/**
 * Draft order tools: list, get (read); create, complete (write).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ShopifyClient, ShopifyError, assertNoUserErrors } from "../shopify-client.js";
import { registerTool, paginationShape } from "./shared.js";
import { gidToId, toGid, markdownTable, detailLines, money, stripGids } from "../format.js";

const LIST_DRAFT_ORDERS = /* GraphQL */ `
  query ListDraftOrders($first: Int!, $after: String, $query: String) {
    draftOrders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id name status createdAt
        totalPriceSet { shopMoney { amount currencyCode } }
        customer { id displayName }
      }
    }
  }
`;

const GET_DRAFT_ORDER = /* GraphQL */ `
  query GetDraftOrder($id: ID!) {
    draftOrder(id: $id) {
      id name status createdAt invoiceUrl note2
      totalPriceSet { shopMoney { amount currencyCode } }
      subtotalPriceSet { shopMoney { amount currencyCode } }
      customer { id displayName }
      order { id name }
      lineItems(first: 100) {
        nodes {
          title quantity sku
          variant { id }
          originalUnitPriceSet { shopMoney { amount currencyCode } }
        }
      }
      shippingAddress { name address1 city province zip country }
    }
  }
`;

const RESOLVE_SKU = /* GraphQL */ `
  query ResolveSku($query: String!) {
    productVariants(first: 1, query: $query) {
      nodes { id sku }
    }
  }
`;

const CREATE_DRAFT_ORDER = /* GraphQL */ `
  mutation CreateDraftOrder($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id name status invoiceUrl
        totalPriceSet { shopMoney { amount currencyCode } }
      }
      userErrors { field message }
    }
  }
`;

const COMPLETE_DRAFT_ORDER = /* GraphQL */ `
  mutation CompleteDraftOrder($id: ID!, $paymentPending: Boolean) {
    draftOrderComplete(id: $id, paymentPending: $paymentPending) {
      draftOrder {
        id name status
        order { id name }
      }
      userErrors { field message }
    }
  }
`;

interface ShopMoney {
  shopMoney: { amount: string; currencyCode: string };
}

/** Resolves a SKU to a variant GID, throwing an actionable error if not found. */
async function resolveSku(c: ShopifyClient, sku: string): Promise<string> {
  const res = await c.request<{ productVariants: { nodes: Array<{ id: string; sku: string }> } }>(
    RESOLVE_SKU,
    { query: `sku:${sku}` },
  );
  const variant = res.data.productVariants.nodes[0];
  if (!variant) {
    throw new ShopifyError(`No product variant found with SKU "${sku}".`);
  }
  return variant.id;
}

export function registerDraftOrderTools(server: McpServer, client: ShopifyClient): void {
  registerTool(server, client, {
    name: "shopify_list_draft_orders",
    title: "List draft orders",
    description: "List draft orders, optionally filtered by status. Supports pagination.",
    inputSchema: {
      status: z
        .enum(["OPEN", "INVOICE_SENT", "COMPLETED"])
        .optional()
        .describe("Filter by draft order status."),
      ...paginationShape,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const query = args.status ? `status:${args.status.toLowerCase()}` : undefined;
      const res = await c.request<{
        draftOrders: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<{
            id: string;
            name: string;
            status: string;
            createdAt: string;
            totalPriceSet: ShopMoney | null;
            customer: { id: string; displayName: string } | null;
          }>;
        };
      }>(LIST_DRAFT_ORDERS, { first: args.first, after: args.after, query });

      const { draftOrders } = res.data;
      const rows = draftOrders.nodes.map((d) => [
        gidToId(d.id),
        d.name,
        d.status,
        d.createdAt.slice(0, 10),
        money(d.totalPriceSet?.shopMoney),
        d.customer?.displayName ?? "",
      ]);

      const markdown =
        draftOrders.nodes.length === 0
          ? "No draft orders matched."
          : markdownTable(["ID", "Name", "Status", "Created", "Total", "Customer"], rows, args.first) +
            (draftOrders.pageInfo.hasNextPage
              ? `\n\n_More available. Pass \`after: "${draftOrders.pageInfo.endCursor}"\` for the next page._`
              : "");

      return {
        markdown,
        structured: { draftOrders: stripGids(draftOrders.nodes), pageInfo: draftOrders.pageInfo },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_get_draft_order",
    title: "Get draft order",
    description: "Get a single draft order with line items, totals, customer and invoice URL.",
    inputSchema: {
      id: z.string().describe("Draft order id (numeric or GID)."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{ draftOrder: Record<string, any> | null }>(GET_DRAFT_ORDER, {
        id: toGid("DraftOrder", args.id),
      });
      const draft = res.data.draftOrder;
      if (!draft) {
        return {
          markdown: `No draft order found with id ${gidToId(args.id)}.`,
          structured: { draftOrder: null },
          cost: res.cost,
        };
      }

      const header = detailLines([
        ["Name", draft.name],
        ["ID", gidToId(draft.id)],
        ["Status", draft.status],
        ["Total", money(draft.totalPriceSet?.shopMoney)],
        ["Customer", draft.customer?.displayName],
        ["Invoice URL", draft.invoiceUrl],
        ["Completed order", draft.order?.name],
      ]);

      const lineRows = (draft.lineItems?.nodes ?? []).map((li: any) => [
        li.title,
        li.sku ?? "",
        li.quantity,
        money(li.originalUnitPriceSet?.shopMoney),
      ]);

      return {
        markdown:
          `### Draft order ${draft.name}\n\n${header}\n\n**Line items**\n\n` +
          markdownTable(["Item", "SKU", "Qty", "Unit price"], lineRows),
        structured: { draftOrder: stripGids(draft) },
        cost: res.cost,
      };
    },
  });
}

export function registerDraftOrderWriteTools(server: McpServer, client: ShopifyClient): void {
  registerTool(server, client, {
    name: "shopify_create_draft_order",
    title: "Create draft order",
    description:
      "Create a draft order from line items (by variant id or SKU), an optional customer, " +
      "shipping address and an order-level discount.",
    inputSchema: {
      lineItems: z
        .array(
          z.object({
            variantId: z.string().optional().describe("Variant id (numeric or GID)."),
            sku: z.string().optional().describe("Variant SKU; resolved to a variant id."),
            quantity: z.number().int().min(1).default(1),
          }),
        )
        .min(1)
        .describe("Line items. Each needs either variantId or sku."),
      customerId: z.string().optional().describe("Customer id to attach (numeric or GID)."),
      email: z.string().optional().describe("Customer email (if no customerId)."),
      shippingAddress: z
        .object({
          address1: z.string().optional(),
          address2: z.string().optional(),
          city: z.string().optional(),
          province: z.string().optional(),
          zip: z.string().optional(),
          country: z.string().optional(),
          firstName: z.string().optional(),
          lastName: z.string().optional(),
        })
        .optional(),
      discount: z
        .object({
          value: z.number().describe("Discount amount."),
          valueType: z.enum(["PERCENTAGE", "FIXED_AMOUNT"]).default("PERCENTAGE"),
          title: z.string().optional().describe("Discount label shown on the order."),
        })
        .optional()
        .describe("Order-level applied discount."),
      note: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (args, c) => {
      const lineItems = [];
      for (const li of args.lineItems) {
        let variantGid: string;
        if (li.variantId) {
          variantGid = toGid("ProductVariant", li.variantId);
        } else if (li.sku) {
          variantGid = await resolveSku(c, li.sku);
        } else {
          throw new ShopifyError("Each line item needs either variantId or sku.");
        }
        lineItems.push({ variantId: variantGid, quantity: li.quantity });
      }

      const input: Record<string, unknown> = { lineItems };
      if (args.customerId) input.purchasingEntity = { customerId: toGid("Customer", args.customerId) };
      if (args.email) input.email = args.email;
      if (args.note) input.note = args.note;
      if (args.shippingAddress) input.shippingAddress = args.shippingAddress;
      if (args.discount) {
        input.appliedDiscount = {
          value: args.discount.value,
          valueType: args.discount.valueType,
          title: args.discount.title ?? "Discount",
        };
      }

      const res = await c.request<{
        draftOrderCreate: {
          draftOrder: {
            id: string;
            name: string;
            status: string;
            invoiceUrl: string | null;
            totalPriceSet: ShopMoney | null;
          } | null;
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(CREATE_DRAFT_ORDER, { input });

      assertNoUserErrors(res.data.draftOrderCreate.userErrors);
      const draft = res.data.draftOrderCreate.draftOrder!;
      return {
        markdown:
          `Created draft order **${draft.name}** (id ${gidToId(draft.id)}, status ${draft.status}, ` +
          `total ${money(draft.totalPriceSet?.shopMoney)}).`,
        structured: { draftOrder: stripGids(draft) },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_complete_draft_order",
    title: "Complete draft order",
    description:
      "Complete a draft order, turning it into a real order. Set paymentPending=true to mark it " +
      "as pending payment rather than paid.",
    inputSchema: {
      id: z.string().describe("Draft order id (numeric or GID)."),
      paymentPending: z
        .boolean()
        .default(false)
        .describe("If true, the resulting order is marked pending payment."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (args, c) => {
      const res = await c.request<{
        draftOrderComplete: {
          draftOrder: {
            id: string;
            name: string;
            status: string;
            order: { id: string; name: string } | null;
          } | null;
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(COMPLETE_DRAFT_ORDER, {
        id: toGid("DraftOrder", args.id),
        paymentPending: args.paymentPending,
      });

      assertNoUserErrors(res.data.draftOrderComplete.userErrors);
      const draft = res.data.draftOrderComplete.draftOrder!;
      return {
        markdown: `Completed draft order **${draft.name}** → order ${draft.order?.name ?? "(created)"} (status ${draft.status}).`,
        structured: { draftOrder: stripGids(draft) },
        cost: res.cost,
      };
    },
  });
}
