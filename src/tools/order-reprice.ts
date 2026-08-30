/**
 * Cross-service tool: rewrite completed Shopify orders so each line shows the
 * real eBay sale price instead of the Shopify catalog price.
 *
 * For every order it resolves each line's true eBay unit price (from explicit
 * eBay order ids, or ones parsed out of the Shopify order note the merge tool
 * writes), then runs the whole Order Editing cycle internally —
 * orderEditBegin → zero out each eligible line → orderEditAddCustomItem at the
 * eBay price → orderEditCommit — as ONE call per order.
 *
 * Safety: Shopify silently refuses to zero out an already-fulfilled line, which
 * leaves a residual and doubles the total. `skipAlreadyFulfilledLines` (default
 * true) checks each line's unfulfilled quantity first and leaves fulfilled lines
 * untouched, reporting them in `linesSkippedFulfilled` rather than mangling them.
 *
 * Read-only against eBay; writes only via Shopify order edits. dryRun (default)
 * previews before/after totals and per-line changes without committing.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ShopifyClient, ShopifyError, assertNoUserErrors } from "../shopify-client.js";
import { EbayClient } from "../ebay-client.js";
import type { Config } from "../config.js";
import { logToolCall } from "../logger.js";
import { textContent, gidToId, toGid } from "../format.js";

// ─── GraphQL ─────────────────────────────────────────────────────────────────

const ORDER_FOR_REPRICE = /* GraphQL */ `
  query OrderForReprice($id: ID!) {
    order(id: $id) {
      id name note
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      lineItems(first: 250) {
        nodes {
          id title sku quantity unfulfilledQuantity
          variant { id sku }
          discountedUnitPriceSet { shopMoney { amount currencyCode } }
        }
      }
    }
  }
`;

const ORDER_EDIT_BEGIN = /* GraphQL */ `
  mutation RepriceEditBegin($id: ID!) {
    orderEditBegin(id: $id) {
      calculatedOrder {
        id
        lineItems(first: 250) {
          nodes { id title quantity editableQuantity variant { id sku } }
        }
      }
      userErrors { field message }
    }
  }
`;

const ORDER_EDIT_SET_QTY = /* GraphQL */ `
  mutation RepriceSetQty($id: ID!, $lineItemId: ID!, $quantity: Int!) {
    orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: $quantity, restock: false) {
      userErrors { field message }
    }
  }
`;

const ORDER_EDIT_ADD_CUSTOM = /* GraphQL */ `
  mutation RepriceAddCustom($id: ID!, $title: String!, $price: MoneyInput!, $quantity: Int!) {
    orderEditAddCustomItem(id: $id, title: $title, price: $price, quantity: $quantity) {
      calculatedLineItem { id }
      userErrors { field message }
    }
  }
`;

const ORDER_EDIT_COMMIT = /* GraphQL */ `
  mutation RepriceCommit($id: ID!, $staffNote: String) {
    orderEditCommit(id: $id, notifyCustomer: false, staffNote: $staffNote) {
      order { id name currentTotalPriceSet { shopMoney { amount currencyCode } } }
      userErrors { field message }
    }
  }
`;

// ─── Types ───────────────────────────────────────────────────────────────────

interface OrderLine {
  id: string;
  title: string;
  sku: string | null;
  quantity: number;
  unfulfilledQuantity: number;
  variant: { id: string; sku: string | null } | null;
  discountedUnitPriceSet: { shopMoney: { amount: string; currencyCode: string } } | null;
}
interface OrderData {
  id: string;
  name: string;
  note: string | null;
  currentTotalPriceSet: { shopMoney: { amount: string; currencyCode: string } } | null;
  lineItems: { nodes: OrderLine[] };
}
interface CalcLine {
  id: string;
  title: string;
  quantity: number;
  editableQuantity: number;
  variant: { id: string; sku: string | null } | null;
}
interface EbayLineItem {
  title?: string;
  sku?: string;
  quantity?: number;
  lineItemCost?: { value?: string; currency?: string };
}

const DEFAULT_STAFF_NOTE = "Corrected line item pricing to match actual eBay sale price.";

/** eBay lineItemCost is the cost for the line's quantity; derive a per-unit price. */
function unitPrice(li: EbayLineItem): { amount: string; currency: string } {
  const total = Number(li.lineItemCost?.value ?? 0) || 0;
  const qty = li.quantity ?? 1;
  const unit = qty > 0 ? total / qty : total;
  return { amount: unit.toFixed(2), currency: li.lineItemCost?.currency ?? "USD" };
}

/** Pull eBay order ids out of a Shopify order note (the merge tool's format + generic eBay ids). */
function parseEbayOrderIds(note: string | null): string[] {
  if (!note) return [];
  const ids = new Set<string>();
  for (const m of note.matchAll(/\b\d{2}-\d{4,6}-\d{4,6}\b/g)) ids.add(m[0]);
  return [...ids];
}

/** Build sku→price and title→price maps from a set of eBay orders. */
async function loadEbayPrices(
  ebay: EbayClient,
  orderIds: string[],
): Promise<{ bySku: Map<string, { amount: string; currency: string }>; byTitle: Map<string, { amount: string; currency: string }>; fetched: string[]; failed: string[] }> {
  const bySku = new Map<string, { amount: string; currency: string }>();
  const byTitle = new Map<string, { amount: string; currency: string }>();
  const fetched: string[] = [];
  const failed: string[] = [];
  for (const id of orderIds) {
    const res = await ebay.request("GET", `/sell/fulfillment/v1/order/${encodeURIComponent(id)}`).catch(() => null);
    const order = res?.data as { lineItems?: EbayLineItem[] } | undefined;
    if (!order || !order.lineItems) { failed.push(id); continue; }
    fetched.push(id);
    for (const li of order.lineItems) {
      const price = unitPrice(li);
      if (li.sku && !bySku.has(li.sku)) bySku.set(li.sku, price);
      if (li.title && !byTitle.has(li.title)) byTitle.set(li.title, price);
    }
  }
  return { bySku, byTitle, fetched, failed };
}

export function registerOrderRepriceTools(server: McpServer, shopify: ShopifyClient, ebay: EbayClient, _config: Config): void {
  server.registerTool(
    "shopify_reprice_order_lines_to_ebay",
    {
      title: "Reprice order lines to eBay sale price",
      description:
        "Rewrite already-completed Shopify orders so every line shows the real eBay sale price instead of the Shopify catalog price. Resolves each line's eBay unit price (from sourceEbayOrderIds, or eBay order ids parsed from the Shopify order note) and runs the full Order Editing cycle (begin → zero line → add custom item at the eBay price → commit) internally, one call per order. skipAlreadyFulfilledLines (default true) leaves fulfilled lines untouched — Shopify silently refuses to zero them, which otherwise doubles the total. Read-only against eBay. dryRun (default true) previews before/after totals and per-line changes without committing.",
      inputSchema: {
        orderIds: z.array(z.string()).min(1).describe("Shopify order ids (numeric or GID) to reprice."),
        sourceEbayOrderIds: z.array(z.string()).optional().describe("Explicit eBay order ids to pull real prices from. If omitted, eBay order ids are parsed from each Shopify order's note."),
        dryRun: z.boolean().default(true).describe("true (default): preview per-line changes and before/after totals without writing. false: perform the order edits."),
        skipAlreadyFulfilledLines: z.boolean().default(true).describe("true (default, safe): leave already-fulfilled lines untouched (Shopify won't zero them; editing anyway doubles the total) and report them in linesSkippedFulfilled. false: attempt the edit anyway and report the resulting quantity."),
        staffNote: z.string().optional().describe("Staff note recorded on each order edit. Defaults to a standard correction note."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    (async (args: { orderIds: string[]; sourceEbayOrderIds?: string[]; dryRun: boolean; skipAlreadyFulfilledLines: boolean; staffNote?: string }) => {
      const start = Date.now();
      const results: Array<Record<string, unknown>> = [];
      try {
        // Shared eBay price maps when explicit source ids are given for the whole batch.
        let sharedPrices: Awaited<ReturnType<typeof loadEbayPrices>> | null = null;
        if (args.sourceEbayOrderIds && args.sourceEbayOrderIds.length) {
          sharedPrices = await loadEbayPrices(ebay, args.sourceEbayOrderIds);
        }

        for (const rawId of args.orderIds) {
          const orderGid = toGid("Order", rawId);
          const ores = await shopify.request<{ order: OrderData | null }>(ORDER_FOR_REPRICE, { id: orderGid });
          const order = ores.data.order;
          if (!order) { results.push({ orderId: gidToId(orderGid), error: "order not found" }); continue; }

          // Resolve the eBay price maps for this order.
          const prices = sharedPrices ?? await loadEbayPrices(ebay, parseEbayOrderIds(order.note));
          const ebayOrderIds = sharedPrices ? args.sourceEbayOrderIds! : parseEbayOrderIds(order.note);

          // Plan each line.
          interface PlanLine { line: OrderLine; ebayUnit: { amount: string; currency: string } | null; action: "reprice" | "skip-fulfilled" | "unmatched" | "already-correct"; }
          const plan: PlanLine[] = [];
          for (const li of order.lineItems.nodes) {
            const sku = li.sku ?? li.variant?.sku ?? null;
            const ebayUnit = (sku && prices.bySku.get(sku)) || prices.byTitle.get(li.title) || null;
            const curUnit = li.discountedUnitPriceSet?.shopMoney.amount ?? null;
            let action: PlanLine["action"];
            if (!ebayUnit) action = "unmatched";
            else if (args.skipAlreadyFulfilledLines && li.unfulfilledQuantity < li.quantity) action = "skip-fulfilled";
            else if (curUnit !== null && Number(curUnit).toFixed(2) === ebayUnit.amount) action = "already-correct";
            else action = "reprice";
            plan.push({ line: li, ebayUnit, action });
          }

          const repriceLines = plan.filter((p) => p.action === "reprice");
          const skippedFulfilled = plan.filter((p) => p.action === "skip-fulfilled").length;
          const unmatched = plan.filter((p) => p.action === "unmatched");
          const alreadyCorrect = plan.filter((p) => p.action === "already-correct").length;

          const totalBefore = order.currentTotalPriceSet?.shopMoney.amount ?? "0.00";
          const delta = repriceLines.reduce((s, p) => {
            const cur = Number(p.line.discountedUnitPriceSet?.shopMoney.amount ?? 0);
            const nu = Number(p.ebayUnit!.amount);
            return s + (nu - cur) * p.line.quantity;
          }, 0);
          const totalAfterPlanned = (Number(totalBefore) + delta).toFixed(2);

          const changes = plan.map((p) => ({
            title: p.line.title,
            sku: p.line.sku ?? p.line.variant?.sku ?? null,
            qty: p.line.quantity,
            currentUnit: p.line.discountedUnitPriceSet?.shopMoney.amount ?? null,
            ebayUnit: p.ebayUnit?.amount ?? null,
            action: p.action,
          }));

          const base = {
            orderId: gidToId(order.id),
            orderName: order.name,
            ebayOrderIds,
            ebayOrdersFetched: prices.fetched,
            ebayOrdersFailed: prices.failed,
            totalBefore,
            linesRepriced: repriceLines.length,
            linesSkippedFulfilled: skippedFulfilled,
            linesUnmatched: unmatched.length,
            linesAlreadyCorrect: alreadyCorrect,
            unmatchedTitles: unmatched.map((p) => p.line.title),
            changes,
          };

          if (args.dryRun) {
            results.push({ ...base, totalAfter: totalAfterPlanned, committed: false, dryRun: true });
            continue;
          }
          if (repriceLines.length === 0) {
            results.push({ ...base, totalAfter: totalBefore, committed: false, note: "nothing to reprice" });
            continue;
          }

          // Begin the edit and correlate calculated line ids.
          const begin = await shopify.request<{ orderEditBegin: { calculatedOrder: { id: string; lineItems: { nodes: CalcLine[] } } | null; userErrors: Array<{ field: string[] | null; message: string }> } }>(ORDER_EDIT_BEGIN, { id: order.id });
          assertNoUserErrors(begin.data.orderEditBegin.userErrors);
          const calc = begin.data.orderEditBegin.calculatedOrder!;
          const calcByKey = new Map<string, CalcLine[]>();
          for (const cl of calc.lineItems.nodes) {
            const key = cl.variant?.id ?? `title:${cl.title}`;
            (calcByKey.get(key) ?? calcByKey.set(key, []).get(key)!).push(cl);
          }

          let repricedOk = 0;
          const failedLines: Array<{ title: string; error: string }> = [];
          for (const p of repriceLines) {
            const key = p.line.variant?.id ?? `title:${p.line.title}`;
            const bucket = calcByKey.get(key);
            const cl = bucket && bucket.shift();
            if (!cl) { failedLines.push({ title: p.line.title, error: "no matching calculated line" }); continue; }
            if (args.skipAlreadyFulfilledLines && cl.editableQuantity < cl.quantity) { continue; } // guard: fulfilled
            try {
              const setRes = await shopify.request<{ orderEditSetQuantity: { userErrors: Array<{ field: string[] | null; message: string }> } }>(ORDER_EDIT_SET_QTY, { id: calc.id, lineItemId: cl.id, quantity: 0 });
              assertNoUserErrors(setRes.data.orderEditSetQuantity.userErrors);
              const addRes = await shopify.request<{ orderEditAddCustomItem: { userErrors: Array<{ field: string[] | null; message: string }> } }>(ORDER_EDIT_ADD_CUSTOM, {
                id: calc.id,
                title: p.line.title,
                price: { amount: p.ebayUnit!.amount, currencyCode: p.ebayUnit!.currency },
                quantity: p.line.quantity,
              });
              assertNoUserErrors(addRes.data.orderEditAddCustomItem.userErrors);
              repricedOk++;
            } catch (e) {
              failedLines.push({ title: p.line.title, error: e instanceof Error ? e.message : String(e) });
            }
          }

          const commit = await shopify.request<{ orderEditCommit: { order: { id: string; name: string; currentTotalPriceSet: { shopMoney: { amount: string; currencyCode: string } } | null } | null; userErrors: Array<{ field: string[] | null; message: string }> } }>(ORDER_EDIT_COMMIT, { id: calc.id, staffNote: args.staffNote ?? DEFAULT_STAFF_NOTE });
          assertNoUserErrors(commit.data.orderEditCommit.userErrors);
          const committed = commit.data.orderEditCommit.order;

          results.push({
            ...base,
            linesRepriced: repricedOk,
            totalAfter: committed?.currentTotalPriceSet?.shopMoney.amount ?? totalAfterPlanned,
            committed: true,
            failedLines,
          });
        }

        const summary = {
          dryRun: args.dryRun,
          orders: results.length,
          totalLinesRepriced: results.reduce((s, r) => s + (Number(r.linesRepriced) || 0), 0),
          totalLinesSkippedFulfilled: results.reduce((s, r) => s + (Number(r.linesSkippedFulfilled) || 0), 0),
          results,
        };
        const head = args.dryRun
          ? `**DRY RUN** — planned reprice across ${results.length} order(s); ${summary.totalLinesRepriced} line(s) would change, ${summary.totalLinesSkippedFulfilled} skipped (fulfilled). Nothing committed. Re-run with dryRun:false.`
          : `Repriced ${summary.totalLinesRepriced} line(s) across ${results.length} order(s); ${summary.totalLinesSkippedFulfilled} skipped (fulfilled).`;
        logToolCall({ tool: "shopify_reprice_order_lines_to_ebay", durationMs: Date.now() - start, success: true });
        return { content: [textContent(`${head}\n\n\`\`\`json\n${JSON.stringify(summary, null, 2).slice(0, 14000)}\n\`\`\``)], structuredContent: summary };
      } catch (err) {
        const message = err instanceof ShopifyError || err instanceof Error ? err.message : String(err);
        logToolCall({ tool: "shopify_reprice_order_lines_to_ebay", durationMs: Date.now() - start, success: false, error: message });
        return { content: [textContent(`Error: ${message}`)], isError: true };
      }
    }) as never,
  );
}
