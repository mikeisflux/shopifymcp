/**
 * Advanced order flows that are multi-step under the hood, each wrapped in one
 * tool call with a dry run:
 *   - shopify_edit_order      : add variant / custom line items to an existing order
 *   - shopify_create_return   : open a return against fulfilled line items
 *   - shopify_issue_store_credit : credit a customer's store-credit account
 *
 * All surface userErrors as tool errors.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ShopifyClient, assertNoUserErrors } from "../shopify-client.js";
import { registerTool } from "./shared.js";
import { gidToId, toGid } from "../format.js";

// ─── Order editing ───────────────────────────────────────────────────────────

const ORDER_CURRENCY = /* GraphQL */ `
  query OrderCurrency($id: ID!) { order(id: $id) { id name currencyCode } }
`;

const ORDER_EDIT_BEGIN = /* GraphQL */ `
  mutation OrderEditBegin($id: ID!) {
    orderEditBegin(id: $id) {
      calculatedOrder { id }
      userErrors { field message }
    }
  }
`;

const CALC_TOTALS = `calculatedOrder {
  id
  subtotalPriceSet { shopMoney { amount currencyCode } }
  totalPriceSet { shopMoney { amount currencyCode } }
}`;

const ORDER_EDIT_ADD_VARIANT = /* GraphQL */ `
  mutation OrderEditAddVariant($id: ID!, $variantId: ID!, $quantity: Int!, $locationId: ID) {
    orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity, locationId: $locationId) {
      ${CALC_TOTALS}
      userErrors { field message }
    }
  }
`;

const ORDER_EDIT_ADD_CUSTOM_ITEM = /* GraphQL */ `
  mutation OrderEditAddCustomItem($id: ID!, $title: String!, $price: MoneyInput!, $quantity: Int!, $taxable: Boolean, $requiresShipping: Boolean) {
    orderEditAddCustomItem(id: $id, title: $title, price: $price, quantity: $quantity, taxable: $taxable, requiresShipping: $requiresShipping) {
      ${CALC_TOTALS}
      userErrors { field message }
    }
  }
`;

const ORDER_EDIT_COMMIT = /* GraphQL */ `
  mutation OrderEditCommit($id: ID!, $notifyCustomer: Boolean, $staffNote: String) {
    orderEditCommit(id: $id, notifyCustomer: $notifyCustomer, staffNote: $staffNote) {
      order { id name totalPriceSet { shopMoney { amount currencyCode } } }
      userErrors { field message }
    }
  }
`;

interface CalcTotals {
  calculatedOrder: {
    id: string;
    subtotalPriceSet: { shopMoney: { amount: string; currencyCode: string } } | null;
    totalPriceSet: { shopMoney: { amount: string; currencyCode: string } } | null;
  } | null;
  userErrors: Array<{ field: string[] | null; message: string }>;
}

// ─── Returns ─────────────────────────────────────────────────────────────────

const ORDER_FULFILLMENT_LINES = /* GraphQL */ `
  query OrderFulfillmentLines($id: ID!) {
    order(id: $id) {
      id name
      fulfillments {
        fulfillmentLineItems(first: 100) {
          nodes { id quantity lineItem { name sku variant { id } } }
        }
      }
    }
  }
`;

const RETURN_CREATE = /* GraphQL */ `
  mutation ReturnCreate($returnInput: ReturnInput!) {
    returnCreate(returnInput: $returnInput) {
      return { id status }
      userErrors { field message }
    }
  }
`;

interface FulfillmentLine {
  id: string;
  quantity: number;
  lineItem: { name: string; sku: string | null; variant: { id: string } | null } | null;
}

// ─── Store credit ────────────────────────────────────────────────────────────

const CUSTOMER_CREDIT_ACCOUNT = /* GraphQL */ `
  query CustomerStoreCredit($id: ID!) {
    customer(id: $id) {
      id displayName
      storeCreditAccounts(first: 1) { nodes { id balance { amount currencyCode } } }
    }
  }
`;

const STORE_CREDIT_CREDIT = /* GraphQL */ `
  mutation StoreCreditAccountCredit($id: ID!, $creditInput: StoreCreditAccountCreditInput!) {
    storeCreditAccountCredit(id: $id, creditInput: $creditInput) {
      storeCreditAccountTransaction {
        amount { amount currencyCode }
        account { id balance { amount currencyCode } }
      }
      userErrors { field message }
    }
  }
`;

export function registerAdvancedOrderTools(server: McpServer, client: ShopifyClient): void {
  registerTool(server, client, {
    name: "shopify_edit_order",
    title: "Edit an existing order (add items)",
    description:
      "Add line items to an existing order — product variants and/or custom (one-off) items — e.g. a " +
      "Kickstarter add-on or a missed item. Wraps Shopify's begin → add → commit edit flow in one call. " +
      "dryRun defaults to TRUE: it stages the additions and returns the recalculated total WITHOUT " +
      "committing. Set dryRun:false to commit (optionally notifying the customer). Removing or changing " +
      "quantity of existing lines is not covered here — use shopify_graphql_mutation with orderEditSetQuantity.",
    inputSchema: {
      orderId: z.string().describe("Order id (numeric or GID)."),
      addVariants: z
        .array(z.object({
          variantId: z.string().describe("Product variant id (numeric or GID)."),
          quantity: z.number().int().min(1).describe("How many to add."),
          locationId: z.string().optional().describe("Optional location to allocate from."),
        }))
        .optional()
        .describe("Existing product variants to add as line items."),
      addCustomItems: z
        .array(z.object({
          title: z.string().describe("Line item title."),
          price: z.string().describe('Unit price as a decimal string, e.g. "20.00" (order currency).'),
          quantity: z.number().int().min(1).describe("Quantity."),
          taxable: z.boolean().optional().describe("Whether the item is taxable (default Shopify behavior if omitted)."),
          requiresShipping: z.boolean().optional().describe("Whether the item requires shipping."),
        }))
        .optional()
        .describe("One-off custom line items (not tied to a product)."),
      notifyCustomer: z.boolean().default(false).describe("On commit, email the customer about the change. Default false."),
      staffNote: z.string().optional().describe("Internal note recorded with the edit."),
      dryRun: z.boolean().default(true).describe("If true (default), stage and show the new total without committing."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    handler: async (args, c) => {
      const nAdds = (args.addVariants?.length ?? 0) + (args.addCustomItems?.length ?? 0);
      if (nAdds === 0) throw new Error("Provide at least one item in addVariants or addCustomItems.");
      const orderGid = toGid("Order", args.orderId);

      const cur = await c.request<{ order: { name: string; currencyCode: string } | null }>(ORDER_CURRENCY, { id: orderGid });
      if (!cur.data.order) throw new Error(`No order found with id ${gidToId(args.orderId)}.`);
      const currencyCode = cur.data.order.currencyCode;

      const begin = await c.request<{ orderEditBegin: { calculatedOrder: { id: string } | null; userErrors: Array<{ field: string[] | null; message: string }> } }>(
        ORDER_EDIT_BEGIN, { id: orderGid },
      );
      assertNoUserErrors(begin.data.orderEditBegin.userErrors);
      const calcId = begin.data.orderEditBegin.calculatedOrder!.id;

      let lastTotals: CalcTotals["calculatedOrder"] = null;
      for (const v of args.addVariants ?? []) {
        const r = await c.request<{ orderEditAddVariant: CalcTotals }>(ORDER_EDIT_ADD_VARIANT, {
          id: calcId, variantId: toGid("ProductVariant", v.variantId), quantity: v.quantity, locationId: v.locationId ? toGid("Location", v.locationId) : null,
        });
        assertNoUserErrors(r.data.orderEditAddVariant.userErrors);
        lastTotals = r.data.orderEditAddVariant.calculatedOrder;
      }
      for (const ci of args.addCustomItems ?? []) {
        const r = await c.request<{ orderEditAddCustomItem: CalcTotals }>(ORDER_EDIT_ADD_CUSTOM_ITEM, {
          id: calcId, title: ci.title, price: { amount: ci.price, currencyCode }, quantity: ci.quantity,
          taxable: ci.taxable ?? null, requiresShipping: ci.requiresShipping ?? null,
        });
        assertNoUserErrors(r.data.orderEditAddCustomItem.userErrors);
        lastTotals = r.data.orderEditAddCustomItem.calculatedOrder;
      }

      const newTotal = lastTotals?.totalPriceSet?.shopMoney;
      const totalStr = newTotal ? `${newTotal.amount} ${newTotal.currencyCode}` : "?";

      if (args.dryRun) {
        return {
          markdown:
            `**DRY RUN** — staged ${nAdds} addition(s) on order ${cur.data.order.name}. New total would be **${totalStr}**. ` +
            `Not committed.\n\n_Re-run with dryRun:false to commit._`,
          structured: { dryRun: true, orderId: gidToId(orderGid), additions: nAdds, newTotal: newTotal ?? null },
          cost: undefined,
        };
      }

      const commit = await c.request<{ orderEditCommit: { order: { id: string; name: string; totalPriceSet: { shopMoney: { amount: string; currencyCode: string } } | null } | null; userErrors: Array<{ field: string[] | null; message: string }> } }>(
        ORDER_EDIT_COMMIT, { id: calcId, notifyCustomer: args.notifyCustomer, staffNote: args.staffNote ?? null },
      );
      assertNoUserErrors(commit.data.orderEditCommit.userErrors);
      const order = commit.data.orderEditCommit.order!;
      const committedTotal = order.totalPriceSet?.shopMoney;
      return {
        markdown: `Committed ${nAdds} addition(s) to order **${order.name}**. New total: ${committedTotal ? `${committedTotal.amount} ${committedTotal.currencyCode}` : totalStr}.` + (args.notifyCustomer ? " Customer notified." : ""),
        structured: { orderId: gidToId(order.id), name: order.name, additions: nAdds, total: committedTotal ?? null },
        cost: undefined,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_create_return",
    title: "Create a return",
    description:
      "Open a return against a FULFILLED order's line items. Specify items by fulfillmentLineItemId, or " +
      "by variantId / SKU (resolved from the order's fulfillments). dryRun defaults to TRUE and echoes " +
      "the resolved return lines without creating the return.",
    inputSchema: {
      orderId: z.string().describe("Order id (numeric or GID)."),
      items: z
        .array(z.object({
          fulfillmentLineItemId: z.string().optional().describe("Fulfillment line item id (numeric or GID)."),
          variantId: z.string().optional().describe("Match a fulfilled line by product variant id."),
          sku: z.string().optional().describe("Match a fulfilled line by SKU."),
          quantity: z.number().int().min(1).describe("Quantity to return."),
          reason: z
            .enum(["UNKNOWN", "DEFECTIVE", "NOT_AS_DESCRIBED", "WRONG_ITEM", "UNWANTED", "SIZE_TOO_SMALL", "SIZE_TOO_LARGE", "STYLE", "COLOR", "OTHER"])
            .default("UNKNOWN")
            .describe("Return reason. Default UNKNOWN."),
          note: z.string().optional().describe("Optional customer-facing note for this line."),
        }))
        .min(1)
        .describe("Lines to return."),
      notifyCustomer: z.boolean().default(false).describe("Email the customer about the return. Default false."),
      dryRun: z.boolean().default(true).describe("If true (default), resolve + echo the return lines without creating it."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (args, c) => {
      const orderGid = toGid("Order", args.orderId);
      const res = await c.request<{ order: { name: string; fulfillments: Array<{ fulfillmentLineItems: { nodes: FulfillmentLine[] } }> } | null }>(
        ORDER_FULFILLMENT_LINES, { id: orderGid },
      );
      if (!res.data.order) throw new Error(`No order found with id ${gidToId(args.orderId)}.`);
      const flis = res.data.order.fulfillments.flatMap((f) => f.fulfillmentLineItems.nodes);
      const byVariant = new Map<string, FulfillmentLine>();
      const bySku = new Map<string, FulfillmentLine>();
      for (const fli of flis) {
        if (fli.lineItem?.variant?.id) byVariant.set(fli.lineItem.variant.id, fli);
        if (fli.lineItem?.sku) bySku.set(fli.lineItem.sku, fli);
      }

      const returnLineItems: Array<{ fulfillmentLineItemId: string; quantity: number; returnReason: string; returnReasonNote?: string }> = [];
      const resolved: Array<{ fulfillmentLineItemId: string; quantity: number; reason: string; label: string }> = [];
      for (const it of args.items) {
        let fliId: string | undefined;
        let label = "";
        if (it.fulfillmentLineItemId) { fliId = toGid("FulfillmentLineItem", it.fulfillmentLineItemId); label = gidToId(fliId); }
        else if (it.variantId) { const m = byVariant.get(toGid("ProductVariant", it.variantId)); fliId = m?.id; label = m?.lineItem?.name ?? `variant ${it.variantId}`; }
        else if (it.sku) { const m = bySku.get(it.sku); fliId = m?.id; label = m?.lineItem?.name ?? `sku ${it.sku}`; }
        if (!fliId) throw new Error(`Could not resolve a fulfilled line for ${JSON.stringify(it)}. It may be unfulfilled or already returned.`);
        returnLineItems.push({ fulfillmentLineItemId: fliId, quantity: it.quantity, returnReason: it.reason, ...(it.note ? { returnReasonNote: it.note } : {}) });
        resolved.push({ fulfillmentLineItemId: gidToId(fliId), quantity: it.quantity, reason: it.reason, label });
      }

      if (args.dryRun) {
        return {
          markdown:
            `**DRY RUN** — return on order ${res.data.order.name}:\n` +
            resolved.map((r) => `- ${r.quantity}× ${r.label} (${r.reason})`).join("\n") +
            `\n\n_Not created. Re-run with dryRun:false to open the return._`,
          structured: { dryRun: true, orderId: gidToId(orderGid), lines: resolved },
          cost: undefined,
        };
      }

      const created = await c.request<{ returnCreate: { return: { id: string; status: string } | null; userErrors: Array<{ field: string[] | null; message: string }> } }>(
        RETURN_CREATE, { returnInput: { orderId: orderGid, returnLineItems, notifyCustomer: args.notifyCustomer } },
      );
      assertNoUserErrors(created.data.returnCreate.userErrors);
      const ret = created.data.returnCreate.return!;
      return {
        markdown: `Created return ${gidToId(ret.id)} (${ret.status}) on order ${res.data.order.name} with ${returnLineItems.length} line(s).`,
        structured: { return: { id: gidToId(ret.id), status: ret.status }, lines: resolved },
        cost: undefined,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_issue_store_credit",
    title: "Issue store credit",
    description:
      "Add store credit to a customer's store-credit account (e.g. as a goodwill gesture or refund " +
      "alternative). dryRun defaults to TRUE and shows the current balance + resulting balance without " +
      "crediting.",
    inputSchema: {
      customerId: z.string().describe("Customer id (numeric or GID)."),
      amount: z.string().describe('Amount to credit as a decimal string, e.g. "25.00".'),
      currencyCode: z.string().optional().describe("Currency code (e.g. USD). Defaults to the customer's existing store-credit currency."),
      expiresAt: z.string().optional().describe("Optional ISO-8601 expiry, e.g. 2027-01-01T00:00:00Z."),
      dryRun: z.boolean().default(true).describe("If true (default), show current + resulting balance without crediting."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (args, c) => {
      const customerGid = toGid("Customer", args.customerId);
      const acct = await c.request<{ customer: { displayName: string; storeCreditAccounts: { nodes: Array<{ id: string; balance: { amount: string; currencyCode: string } }> } } | null }>(
        CUSTOMER_CREDIT_ACCOUNT, { id: customerGid },
      );
      if (!acct.data.customer) throw new Error(`No customer found with id ${gidToId(args.customerId)}.`);
      const account = acct.data.customer.storeCreditAccounts.nodes[0];
      if (!account) {
        throw new Error(
          `Customer ${acct.data.customer.displayName} has no store-credit account yet. Store credit accounts are created ` +
            "on first credit through the admin; if this persists, credit them once in the Shopify admin to initialize it.",
        );
      }
      const currencyCode = args.currencyCode ?? account.balance.currencyCode;
      const current = Number.parseFloat(account.balance.amount);
      const resulting = (current + Number.parseFloat(args.amount)).toFixed(2);

      if (args.dryRun) {
        return {
          markdown:
            `**DRY RUN** — credit ${args.amount} ${currencyCode} to ${acct.data.customer.displayName}. ` +
            `Balance ${account.balance.amount} → ${resulting} ${currencyCode}. Not applied.\n\n_Re-run with dryRun:false to credit._`,
          structured: { dryRun: true, customerId: gidToId(customerGid), current: account.balance, resulting: { amount: resulting, currencyCode } },
          cost: undefined,
        };
      }

      const creditInput: Record<string, unknown> = { creditAmount: { amount: args.amount, currencyCode } };
      if (args.expiresAt !== undefined) creditInput.expiresAt = args.expiresAt;
      const res = await c.request<{
        storeCreditAccountCredit: { storeCreditAccountTransaction: { amount: { amount: string; currencyCode: string }; account: { id: string; balance: { amount: string; currencyCode: string } } } | null; userErrors: Array<{ field: string[] | null; message: string }> };
      }>(STORE_CREDIT_CREDIT, { id: account.id, creditInput });
      assertNoUserErrors(res.data.storeCreditAccountCredit.userErrors);
      const tx = res.data.storeCreditAccountCredit.storeCreditAccountTransaction!;
      return {
        markdown: `Credited ${tx.amount.amount} ${tx.amount.currencyCode} to ${acct.data.customer.displayName}. New balance: ${tx.account.balance.amount} ${tx.account.balance.currencyCode}.`,
        structured: { customerId: gidToId(customerGid), credited: tx.amount, newBalance: tx.account.balance },
        cost: undefined,
      };
    },
  });
}
