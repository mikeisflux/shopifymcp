/**
 * Extra Admin write tools:
 *   - capture_order_payment   (orderCapture)
 *   - send_order_invoice      (orderInvoiceSend)
 *   - update_draft_order      (draftOrderUpdate)
 *   - send_draft_order_invoice(draftOrderInvoiceSend)
 *   - delete_metafield        (metafieldsDelete)
 *   - update_gift_card        (giftCardUpdate)
 *   - deactivate_gift_card    (giftCardDeactivate)
 *
 * Mutation shapes verified against the Shopify Admin GraphQL API (this server
 * targets 2026-04):
 *   - orderCapture(input: OrderCaptureInput!) → { transaction, userErrors }
 *     where OrderCaptureInput { id (order), parentTransactionId, amount, currency?, finalCapture? }.
 *   - orderInvoiceSend(id: ID!, email: EmailInput) → { order, userErrors }.
 *   - draftOrderUpdate(id: ID!, input: DraftOrderInput!) → { draftOrder, userErrors }.
 *   - draftOrderInvoiceSend(id: ID!, email: EmailInput) → { draftOrder, userErrors }.
 *   - metafieldsDelete(metafields: [MetafieldIdentifierInput!]!) → { deletedMetafields, userErrors }
 *     where MetafieldIdentifierInput { ownerId, namespace, key }.
 *   - giftCardUpdate(id: ID!, input: GiftCardUpdateInput!) → { giftCard, userErrors }
 *     where GiftCardUpdateInput { note?, expiresOn?, templateSuffix?, customerId? }.
 *   - giftCardDeactivate(id: ID!) → { giftCard, userErrors }.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ShopifyClient, ShopifyError, assertNoUserErrors } from "../shopify-client.js";
import { registerTool } from "./shared.js";
import { gidToId, toGid, detailLines, money, stripGids } from "../format.js";

/** userErrors as returned by the standard mutation payloads. */
type UserError = { field?: string[] | null; message: string };

interface PresentmentMoney {
  presentmentMoney: { amount: string; currencyCode: string };
}

// ─── Order payment capture ───────────────────────────────────────────────────

const ORDER_CAPTURE_CONTEXT = /* GraphQL */ `
  query OrderCaptureContext($id: ID!) {
    order(id: $id) {
      id name
      transactions {
        id kind status
        amountSet { presentmentMoney { amount currencyCode } }
      }
    }
  }
`;

const CAPTURE_ORDER_PAYMENT = /* GraphQL */ `
  mutation CaptureOrderPayment($input: OrderCaptureInput!) {
    orderCapture(input: $input) {
      transaction {
        id kind status
        amountSet { presentmentMoney { amount currencyCode } }
      }
      userErrors { field message }
    }
  }
`;

// ─── Invoices ────────────────────────────────────────────────────────────────

const SEND_ORDER_INVOICE = /* GraphQL */ `
  mutation SendOrderInvoice($id: ID!, $email: EmailInput) {
    orderInvoiceSend(id: $id, email: $email) {
      order { id name email }
      userErrors { field message }
    }
  }
`;

const SEND_DRAFT_ORDER_INVOICE = /* GraphQL */ `
  mutation SendDraftOrderInvoice($id: ID!, $email: EmailInput) {
    draftOrderInvoiceSend(id: $id, email: $email) {
      draftOrder { id name status invoiceUrl }
      userErrors { field message }
    }
  }
`;

// ─── Draft order update ──────────────────────────────────────────────────────

const UPDATE_DRAFT_ORDER = /* GraphQL */ `
  mutation UpdateDraftOrder($id: ID!, $input: DraftOrderInput!) {
    draftOrderUpdate(id: $id, input: $input) {
      draftOrder {
        id name status email tags note2
        totalPriceSet { shopMoney { amount currencyCode } }
      }
      userErrors { field message }
    }
  }
`;

// ─── Metafield delete ────────────────────────────────────────────────────────

const DELETE_METAFIELDS = /* GraphQL */ `
  mutation DeleteMetafields($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields { key namespace ownerId }
      userErrors { field message }
    }
  }
`;

/** Owner resource types supported for metafields (mirrors shopify_set_metafield). */
const METAFIELD_OWNER_RESOURCE: Record<string, string> = {
  product: "Product",
  variant: "ProductVariant",
  collection: "Collection",
  customer: "Customer",
  order: "Order",
  draft_order: "DraftOrder",
  page: "Page",
  blog: "Blog",
  article: "Article",
  shop: "Shop",
};

// ─── Gift cards ──────────────────────────────────────────────────────────────

const UPDATE_GIFT_CARD = /* GraphQL */ `
  mutation UpdateGiftCard($id: ID!, $input: GiftCardUpdateInput!) {
    giftCardUpdate(id: $id, input: $input) {
      giftCard {
        id maskedCode note expiresOn templateSuffix
        balance { amount currencyCode }
        customer { id displayName }
      }
      userErrors { field message }
    }
  }
`;

const DEACTIVATE_GIFT_CARD = /* GraphQL */ `
  mutation DeactivateGiftCard($id: ID!) {
    giftCardDeactivate(id: $id) {
      giftCard {
        id maskedCode deactivatedAt
        balance { amount currencyCode }
      }
      userErrors { field message }
    }
  }
`;

export function registerAdminExtraWriteTools(server: McpServer, client: ShopifyClient): void {
  registerTool(server, client, {
    name: "shopify_capture_order_payment",
    title: "Capture order payment",
    description:
      "Capture an authorized payment on an order (claim money previously reserved by an " +
      "authorization). If `parentTransactionId` and/or `amount` are omitted, the server reads the " +
      "order's transactions and captures the full amount of its successful AUTHORIZATION transaction. " +
      "Requires the write_orders scope.",
    inputSchema: {
      orderId: z.string().describe("Order id (numeric or GID)."),
      parentTransactionId: z
        .string()
        .optional()
        .describe(
          "The authorized transaction id to capture (numeric or GID). Omit to auto-detect the " +
            "order's successful authorization transaction.",
        ),
      amount: z
        .number()
        .positive()
        .optional()
        .describe("Amount to capture. Defaults to the authorization's full amount. Cannot exceed it."),
      currency: z
        .string()
        .optional()
        .describe(
          "Presentment currency (ISO code, e.g. USD) of the capture. Required only when the order's " +
            "currency and presentment currency differ; otherwise auto-detected.",
        ),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (args, c) => {
      const orderGid = toGid("Order", args.orderId);

      // Read the order's transactions to locate the authorization and its amount/currency.
      const ctx = await c.request<{
        order: {
          id: string;
          name: string;
          transactions: Array<{
            id: string;
            kind: string;
            status: string;
            amountSet: PresentmentMoney | null;
          }>;
        } | null;
      }>(ORDER_CAPTURE_CONTEXT, { id: orderGid });

      if (!ctx.data.order) {
        throw new ShopifyError(`No order found with id ${gidToId(args.orderId)}.`);
      }
      const txns = ctx.data.order.transactions ?? [];
      const auth = txns.find((t) => t.kind === "AUTHORIZATION" && t.status === "SUCCESS");

      let parentGid: string;
      if (args.parentTransactionId) {
        parentGid = toGid("OrderTransaction", args.parentTransactionId);
      } else if (auth) {
        parentGid = auth.id;
      } else {
        throw new ShopifyError(
          `No successful authorization transaction found on order ${ctx.data.order.name}. ` +
            "Pass parentTransactionId explicitly.",
        );
      }

      const authMoney = auth?.amountSet?.presentmentMoney;
      const captureAmount = args.amount !== undefined ? String(args.amount) : authMoney?.amount;
      if (captureAmount === undefined) {
        throw new ShopifyError(
          "Could not determine the capture amount from the order. Pass `amount` explicitly.",
        );
      }
      const currency = args.currency ?? authMoney?.currencyCode;

      const input: Record<string, unknown> = {
        id: orderGid,
        parentTransactionId: parentGid,
        amount: captureAmount,
      };
      if (currency) input.currency = currency;

      const res = await c.request<{
        orderCapture: {
          transaction: {
            id: string;
            kind: string;
            status: string;
            amountSet: PresentmentMoney | null;
          } | null;
          userErrors: UserError[];
        };
      }>(CAPTURE_ORDER_PAYMENT, { input });
      assertNoUserErrors(res.data.orderCapture.userErrors);
      const txn = res.data.orderCapture.transaction;
      return {
        markdown: txn
          ? `Captured payment on order ${ctx.data.order.name} — transaction ${gidToId(txn.id)} ` +
            `(${txn.kind}, status ${txn.status}, ${money(txn.amountSet?.presentmentMoney)}).`
          : `Capture requested on order ${ctx.data.order.name}.`,
        structured: { transaction: txn ? stripGids(txn) : null },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_send_order_invoice",
    title: "Send order invoice",
    description:
      "Send an email invoice for an order. Optionally override the email subject and add a custom " +
      "message. Requires the write_orders scope.",
    inputSchema: {
      orderId: z.string().describe("Order id (numeric or GID)."),
      subject: z.string().optional().describe("Override the invoice email subject line."),
      customMessage: z.string().optional().describe("Custom message included in the invoice email body."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (args, c) => {
      const variables: Record<string, unknown> = { id: toGid("Order", args.orderId) };
      const email: Record<string, unknown> = {};
      if (args.subject !== undefined) email.subject = args.subject;
      if (args.customMessage !== undefined) email.customMessage = args.customMessage;
      if (Object.keys(email).length > 0) variables.email = email;

      const res = await c.request<{
        orderInvoiceSend: {
          order: { id: string; name: string; email: string | null } | null;
          userErrors: UserError[];
        };
      }>(SEND_ORDER_INVOICE, variables);
      assertNoUserErrors(res.data.orderInvoiceSend.userErrors);
      const order = res.data.orderInvoiceSend.order;
      return {
        markdown: order
          ? `Sent invoice for order **${order.name}** (id ${gidToId(order.id)})${order.email ? ` to ${order.email}` : ""}.`
          : `Sent invoice for order ${gidToId(args.orderId)}.`,
        structured: { order: order ? stripGids(order) : null },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_update_draft_order",
    title: "Update draft order",
    description:
      "Update an open draft order: note, customer email, tags, and/or line items. Only the fields " +
      "you provide are changed. `tags` replaces the full tag list; `lineItems` REPLACES all line " +
      "items. Requires the write_draft_orders scope.",
    inputSchema: {
      draftOrderId: z.string().describe("Draft order id (numeric or GID)."),
      note: z.string().optional().describe("New note text for the draft order."),
      email: z.string().optional().describe("Customer email address for the draft order."),
      tags: z.array(z.string()).optional().describe("Replaces the full tag list on the draft order."),
      lineItems: z
        .array(
          z.object({
            variantId: z.string().describe("Product variant id (numeric or GID)."),
            quantity: z.number().int().min(1).default(1).describe("Quantity of this variant."),
          }),
        )
        .optional()
        .describe("Replaces ALL line items on the draft order. Omit to leave line items unchanged."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const input: Record<string, unknown> = {};
      if (args.note !== undefined) input.note = args.note;
      if (args.email !== undefined) input.email = args.email;
      if (args.tags !== undefined) input.tags = args.tags;
      if (args.lineItems !== undefined) {
        input.lineItems = args.lineItems.map((li) => ({
          variantId: toGid("ProductVariant", li.variantId),
          quantity: li.quantity,
        }));
      }
      if (Object.keys(input).length === 0) {
        throw new ShopifyError("Provide at least one of note, email, tags, or lineItems to update.");
      }

      const res = await c.request<{
        draftOrderUpdate: {
          draftOrder: {
            id: string;
            name: string;
            status: string;
            email: string | null;
            tags: string[];
            note2: string | null;
            totalPriceSet: { shopMoney: { amount: string; currencyCode: string } } | null;
          } | null;
          userErrors: UserError[];
        };
      }>(UPDATE_DRAFT_ORDER, { id: toGid("DraftOrder", args.draftOrderId), input });
      assertNoUserErrors(res.data.draftOrderUpdate.userErrors);
      const draft = res.data.draftOrderUpdate.draftOrder;
      return {
        markdown: draft
          ? `Updated draft order **${draft.name}** (id ${gidToId(draft.id)}, status ${draft.status}).\n\n` +
            detailLines([
              ["Email", draft.email],
              ["Tags", draft.tags.join(", ")],
              ["Note", draft.note2],
              ["Total", money(draft.totalPriceSet?.shopMoney)],
            ])
          : `Updated draft order ${gidToId(args.draftOrderId)}.`,
        structured: { draftOrder: draft ? stripGids(draft) : null },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_send_draft_order_invoice",
    title: "Send draft order invoice",
    description:
      "Send an invoice email for a draft order (includes a secure checkout link). Optionally " +
      "override the email subject and add a custom message. Requires the write_draft_orders scope.",
    inputSchema: {
      draftOrderId: z.string().describe("Draft order id (numeric or GID)."),
      subject: z.string().optional().describe("Override the invoice email subject line."),
      customMessage: z.string().optional().describe("Custom message included in the invoice email body."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (args, c) => {
      const variables: Record<string, unknown> = { id: toGid("DraftOrder", args.draftOrderId) };
      const email: Record<string, unknown> = {};
      if (args.subject !== undefined) email.subject = args.subject;
      if (args.customMessage !== undefined) email.customMessage = args.customMessage;
      if (Object.keys(email).length > 0) variables.email = email;

      const res = await c.request<{
        draftOrderInvoiceSend: {
          draftOrder: { id: string; name: string; status: string; invoiceUrl: string | null } | null;
          userErrors: UserError[];
        };
      }>(SEND_DRAFT_ORDER_INVOICE, variables);
      assertNoUserErrors(res.data.draftOrderInvoiceSend.userErrors);
      const draft = res.data.draftOrderInvoiceSend.draftOrder;
      return {
        markdown: draft
          ? `Sent invoice for draft order **${draft.name}** (id ${gidToId(draft.id)}, status ${draft.status}).`
          : `Sent invoice for draft order ${gidToId(args.draftOrderId)}.`,
        structured: { draftOrder: draft ? stripGids(draft) : null },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_delete_metafield",
    title: "Delete a metafield",
    description:
      "Delete a metafield from a resource, identified by its owner, namespace, and key. The delete " +
      "succeeds even if the metafield does not exist (a no-op). Requires the relevant write scope " +
      "for the owner resource.",
    inputSchema: {
      ownerType: z
        .enum([
          "product",
          "variant",
          "collection",
          "customer",
          "order",
          "draft_order",
          "page",
          "blog",
          "article",
          "shop",
        ])
        .default("product")
        .describe("Which resource the metafield belongs to."),
      ownerId: z
        .string()
        .optional()
        .describe("Id of the owner resource (numeric or GID). Ignored/optional for ownerType 'shop'."),
      namespace: z.string().describe('Metafield namespace, e.g. "custom".'),
      key: z.string().describe('Metafield key, e.g. "material".'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async (args, c) => {
      const ownerResource = METAFIELD_OWNER_RESOURCE[args.ownerType]!;
      let ownerGid: string;
      if (args.ownerType === "shop") {
        ownerGid = (await c.request<{ shop: { id: string } }>(`query { shop { id } }`)).data.shop.id;
      } else {
        if (!args.ownerId) {
          throw new ShopifyError(`ownerId is required for ownerType '${args.ownerType}'.`);
        }
        ownerGid = toGid(ownerResource, args.ownerId);
      }

      const res = await c.request<{
        metafieldsDelete: {
          deletedMetafields: Array<{
            key: string | null;
            namespace: string | null;
            ownerId: string | null;
          } | null> | null;
          userErrors: UserError[];
        };
      }>(DELETE_METAFIELDS, {
        metafields: [{ ownerId: ownerGid, namespace: args.namespace, key: args.key }],
      });
      assertNoUserErrors(res.data.metafieldsDelete.userErrors);

      const deleted = (res.data.metafieldsDelete.deletedMetafields ?? []).filter(
        (m): m is { key: string | null; namespace: string | null; ownerId: string | null } => m !== null,
      );
      const wasDeleted = deleted.length > 0;
      return {
        markdown: wasDeleted
          ? `Deleted metafield **${args.namespace}.${args.key}** from ${args.ownerType} ${gidToId(ownerGid)}.`
          : `No metafield **${args.namespace}.${args.key}** existed on ${args.ownerType} ${gidToId(ownerGid)} (nothing to delete).`,
        structured: {
          ownerId: gidToId(ownerGid),
          namespace: args.namespace,
          key: args.key,
          deleted: wasDeleted,
          deletedMetafields: stripGids(deleted),
        },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_update_gift_card",
    title: "Update gift card",
    description:
      "Update an existing gift card's note, expiry date, online template suffix, and/or assigned " +
      "customer. Only the fields you provide are changed. Set expiresOn to null to make the card " +
      "never expire. A customer cannot be reassigned once one is set. Requires the write_gift_cards scope.",
    inputSchema: {
      giftCardId: z.string().describe("Gift card id (numeric or GID)."),
      note: z.string().optional().describe("Merchant-facing note (not visible to the customer)."),
      expiresOn: z
        .string()
        .nullable()
        .optional()
        .describe("Expiry date (YYYY-MM-DD). Pass null to make the gift card never expire."),
      templateSuffix: z
        .string()
        .optional()
        .describe("Suffix of the Liquid template used to render the gift card online."),
      customerId: z
        .string()
        .optional()
        .describe("Customer id (numeric or GID) to assign. Cannot be changed once already set."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const input: Record<string, unknown> = {};
      if (args.note !== undefined) input.note = args.note;
      if (args.expiresOn !== undefined) input.expiresOn = args.expiresOn;
      if (args.templateSuffix !== undefined) input.templateSuffix = args.templateSuffix;
      if (args.customerId !== undefined) input.customerId = toGid("Customer", args.customerId);
      if (Object.keys(input).length === 0) {
        throw new ShopifyError(
          "Provide at least one of note, expiresOn, templateSuffix, or customerId to update.",
        );
      }

      const res = await c.request<{
        giftCardUpdate: {
          giftCard: {
            id: string;
            maskedCode: string | null;
            note: string | null;
            expiresOn: string | null;
            templateSuffix: string | null;
            balance: { amount: string; currencyCode: string } | null;
            customer: { id: string; displayName: string } | null;
          } | null;
          userErrors: UserError[];
        };
      }>(UPDATE_GIFT_CARD, { id: toGid("GiftCard", args.giftCardId), input });
      assertNoUserErrors(res.data.giftCardUpdate.userErrors);
      const card = res.data.giftCardUpdate.giftCard;
      return {
        markdown: card
          ? `Updated gift card ${card.maskedCode ?? gidToId(card.id)} (id ${gidToId(card.id)}).\n\n` +
            detailLines([
              ["Balance", money(card.balance)],
              ["Expires on", card.expiresOn ?? "never"],
              ["Note", card.note],
              ["Template suffix", card.templateSuffix],
              ["Customer", card.customer?.displayName],
            ])
          : `Updated gift card ${gidToId(args.giftCardId)}.`,
        structured: { giftCard: card ? stripGids(card) : null },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_deactivate_gift_card",
    title: "Deactivate gift card",
    description:
      "Deactivate a gift card so it can no longer be used by a customer. This is IRREVERSIBLE — a " +
      "deactivated gift card cannot be re-enabled. Requires the write_gift_cards scope.",
    inputSchema: {
      giftCardId: z.string().describe("Gift card id (numeric or GID)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{
        giftCardDeactivate: {
          giftCard: {
            id: string;
            maskedCode: string | null;
            deactivatedAt: string | null;
            balance: { amount: string; currencyCode: string } | null;
          } | null;
          userErrors: UserError[];
        };
      }>(DEACTIVATE_GIFT_CARD, { id: toGid("GiftCard", args.giftCardId) });
      assertNoUserErrors(res.data.giftCardDeactivate.userErrors);
      const card = res.data.giftCardDeactivate.giftCard;
      return {
        markdown: card
          ? `Deactivated gift card ${card.maskedCode ?? gidToId(card.id)} (id ${gidToId(card.id)}` +
            `${card.deactivatedAt ? `, at ${card.deactivatedAt}` : ""}). ` +
            `Remaining balance ${money(card.balance)} is no longer usable.`
          : `Deactivated gift card ${gidToId(args.giftCardId)}.`,
        structured: { giftCard: card ? stripGids(card) : null },
        cost: res.cost,
      };
    },
  });
}
