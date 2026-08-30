/**
 * Cross-service tool: merge a day's eBay sales into one Shopify draft order per
 * repeat buyer.
 *
 * For a local calendar-day range it pulls that day's eBay orders (paginating the
 * Fulfillment API internally, using the same seller-local-timezone handling as
 * `ebay_search_orders`), groups them by buyer USERNAME (the stable key), and for
 * every buyer with ≥ `minOrdersToMerge` orders creates ONE Shopify draft order:
 * SKUs resolved to real product variants, no-SKU eBay listings kept as custom
 * line items, and the shipping address taken from the eBay ship-to. It is
 * read-only against eBay (never closes/refunds the source orders) and write-only
 * against Shopify draft orders.
 *
 * Price note: resolved-SKU lines use the Shopify catalog price (variant linkage
 * keeps inventory/reporting correct); no-SKU custom lines use the eBay sale
 * price. Each source eBay order id and its eBay total is recorded in the draft's
 * note for reconciliation.
 *
 * Every draft carries a marker in its note — `ebay-merge buyer:<username>
 * range:<from>..<to>` — which makes the tool safe to re-run: a buyer already
 * merged for the same range is detected and skipped rather than duplicated.
 *
 * Also registers `shopify_resolve_skus`, a batched SKU→variant resolver.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ShopifyClient, ShopifyError, assertNoUserErrors } from "../shopify-client.js";
import { EbayClient } from "../ebay-client.js";
import type { Config } from "../config.js";
import { logToolCall } from "../logger.js";
import { textContent, gidToId } from "../format.js";
import { DAY_MS, zonedDayStartToUtc } from "../tz.js";

// ─── GraphQL ─────────────────────────────────────────────────────────────────

const RESOLVE_SKUS_BATCH = /* GraphQL */ `
  query ResolveSkus($query: String!) {
    productVariants(first: 250, query: $query) {
      nodes { id sku price product { id title } }
    }
  }
`;

const OPEN_DRAFTS = /* GraphQL */ `
  query OpenDrafts($after: String) {
    draftOrders(first: 250, after: $after, query: "status:OPEN") {
      pageInfo { hasNextPage endCursor }
      nodes { id name note2 }
    }
  }
`;

const DRAFT_LINE_ITEMS = /* GraphQL */ `
  query DraftLineItems($id: ID!) {
    draftOrder(id: $id) {
      id name note2
      lineItems(first: 250) {
        nodes {
          title quantity sku
          variant { id }
          originalUnitPriceSet { shopMoney { amount currencyCode } }
        }
      }
    }
  }
`;

const CREATE_DRAFT_ORDER = /* GraphQL */ `
  mutation CreateMergeDraft($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id name status invoiceUrl
        totalPriceSet { shopMoney { amount currencyCode } }
      }
      userErrors { field message }
    }
  }
`;

const UPDATE_DRAFT_ORDER = /* GraphQL */ `
  mutation UpdateMergeDraft($id: ID!, $input: DraftOrderInput!) {
    draftOrderUpdate(id: $id, input: $input) {
      draftOrder {
        id name status invoiceUrl
        totalPriceSet { shopMoney { amount currencyCode } }
      }
      userErrors { field message }
    }
  }
`;

// ─── eBay order shapes (Fulfillment API) ─────────────────────────────────────

interface EbayLineItem {
  title?: string;
  sku?: string;
  quantity?: number;
  lineItemCost?: { value?: string; currency?: string };
}
interface EbayShipTo {
  fullName?: string;
  contactAddress?: {
    addressLine1?: string;
    addressLine2?: string;
    city?: string;
    stateOrProvince?: string;
    postalCode?: string;
    countryCode?: string;
  };
  primaryPhone?: { phoneNumber?: string };
  email?: string;
}
interface EbayOrder {
  orderId?: string;
  creationDate?: string;
  buyer?: { username?: string };
  pricingSummary?: { total?: { value?: string; currency?: string } };
  lineItems?: EbayLineItem[];
  fulfillmentStartInstructions?: Array<{ shippingStep?: { shipTo?: EbayShipTo } }>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const COUNTRY_NAMES: Record<string, string> = {
  US: "United States",
  CA: "Canada",
  GB: "United Kingdom",
  AU: "Australia",
  DE: "Germany",
  FR: "France",
  IT: "Italy",
  ES: "Spain",
  NL: "Netherlands",
  JP: "Japan",
};

/** Escape a SKU for use inside a Shopify search query quoted value. */
function escapeSkuValue(sku: string): string {
  return sku.replace(/["\\]/g, "\\$&");
}

/** Batch-resolve SKUs to variant GIDs. Returns a map of sku → {id, price, title}. */
async function resolveSkus(
  shopify: ShopifyClient,
  skus: string[],
): Promise<Map<string, { id: string; price: string | null; title: string | null }>> {
  const out = new Map<string, { id: string; price: string | null; title: string | null }>();
  const unique = [...new Set(skus.filter(Boolean))];
  const CHUNK = 40; // keep the OR-query string bounded
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const query = chunk.map((s) => `sku:"${escapeSkuValue(s)}"`).join(" OR ");
    const res = await shopify.request<{
      productVariants: { nodes: Array<{ id: string; sku: string | null; price: string | null; product: { title: string | null } | null }> };
    }>(RESOLVE_SKUS_BATCH, { query });
    for (const v of res.data.productVariants.nodes) {
      if (v.sku && !out.has(v.sku)) out.set(v.sku, { id: v.id, price: v.price, title: v.product?.title ?? null });
    }
  }
  return out;
}

/** Split "Martin Kobovitch" → {firstName, lastName}. */
function splitName(full: string | undefined): { firstName?: string; lastName?: string } {
  const name = (full ?? "").trim();
  if (!name) return {};
  const idx = name.lastIndexOf(" ");
  if (idx === -1) return { firstName: name };
  return { firstName: name.slice(0, idx), lastName: name.slice(idx + 1) };
}

/** Map an eBay ship-to into a Shopify MailingAddressInput. */
function toShopifyAddress(shipTo: EbayShipTo | undefined): Record<string, unknown> | undefined {
  const a = shipTo?.contactAddress;
  if (!a) return undefined;
  const { firstName, lastName } = splitName(shipTo?.fullName);
  const countryCode = (a.countryCode ?? "").toUpperCase();
  const addr: Record<string, unknown> = {};
  if (firstName) addr.firstName = firstName;
  if (lastName) addr.lastName = lastName;
  if (a.addressLine1) addr.address1 = a.addressLine1;
  if (a.addressLine2) addr.address2 = a.addressLine2;
  if (a.city) addr.city = a.city;
  if (a.stateOrProvince) addr.province = a.stateOrProvince;
  if (a.postalCode) addr.zip = a.postalCode;
  if (countryCode) addr.country = COUNTRY_NAMES[countryCode] ?? countryCode;
  const phone = shipTo?.primaryPhone?.phoneNumber;
  if (phone) addr.phone = phone;
  return Object.keys(addr).length ? addr : undefined;
}

type ShopMoney = { shopMoney: { amount: string; currencyCode: string } };
type DraftResult = { id: string; name: string; status: string; invoiceUrl: string | null; totalPriceSet: ShopMoney | null };

export function registerEbayMergeTools(server: McpServer, shopify: ShopifyClient, ebay: EbayClient, config: Config): void {
  // ─── Batched SKU resolver (read) ───────────────────────────────────────────
  server.registerTool(
    "shopify_resolve_skus",
    {
      title: "Resolve SKUs to variant IDs (batched)",
      description:
        "Batch-resolve many SKUs to Shopify ProductVariant GIDs in a single call (chunked OR-search internally), instead of one shopify_search + shopify_get_product round-trip per SKU. Returns, per input SKU, the variant id, product title, and catalog price — plus a list of SKUs that didn't match any variant.",
      inputSchema: {
        skus: z.array(z.string()).min(1).describe("SKU strings to resolve."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    (async (args: { skus: string[] }) => {
      const start = Date.now();
      try {
        const map = await resolveSkus(shopify, args.skus);
        const resolved: Record<string, { variantId: string; productTitle: string | null; price: string | null }> = {};
        const unresolved: string[] = [];
        for (const sku of [...new Set(args.skus.filter(Boolean))]) {
          const v = map.get(sku);
          if (v) resolved[sku] = { variantId: gidToId(v.id), productTitle: v.title, price: v.price };
          else unresolved.push(sku);
        }
        const summary = { requested: args.skus.length, resolvedCount: Object.keys(resolved).length, unresolvedCount: unresolved.length, resolved, unresolved };
        logToolCall({ tool: "shopify_resolve_skus", durationMs: Date.now() - start, success: true });
        return {
          content: [textContent(`Resolved ${summary.resolvedCount}/${summary.requested} SKU(s); ${unresolved.length} unmatched.\n\n\`\`\`json\n${JSON.stringify(summary, null, 2).slice(0, 12000)}\n\`\`\``)],
          structuredContent: summary,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logToolCall({ tool: "shopify_resolve_skus", durationMs: Date.now() - start, success: false, error: message });
        return { content: [textContent(`Error: ${message}`)], isError: true };
      }
    }) as never,
  );

  // ─── Merge sales → draft orders (write) ────────────────────────────────────
  server.registerTool(
    "ebay_merge_sales_to_draft_orders",
    {
      title: "Merge a day's eBay sales into draft orders",
      description:
        "Group a local calendar day's eBay sales by buyer and create ONE Shopify draft order per buyer with ≥ minOrdersToMerge orders — resolving SKUs to variants, keeping no-SKU eBay listings as custom line items, and pulling the shipping address from the eBay ship-to. Read-only against eBay (never closes/refunds source orders); write-only against Shopify drafts. dryRun:true (default) returns the planned groupings without creating anything. Idempotent: a buyer already merged for the same range (detected via a marker in the draft note) is skipped, so it's safe to re-run.",
      inputSchema: {
        dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Local start date YYYY-MM-DD (inclusive), in the seller's timezone."),
        dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Local end date YYYY-MM-DD (inclusive), in the seller's timezone. Same as dateFrom for a single day."),
        minOrdersToMerge: z.number().int().min(1).default(2).describe("Only buyers with at least this many orders in the range get a draft. Others are reported as skipped."),
        dryRun: z.boolean().default(true).describe("true (default): return planned groupings without creating drafts. false: create the drafts."),
        noteTag: z.string().optional().describe("Freeform tag added to each draft's note for traceability (e.g. \"2026-08-29 show\"). Defaults to the date range."),
        excludeBuyerUsernames: z.array(z.string()).optional().describe("eBay usernames to skip entirely (e.g. wholesale accounts handled manually)."),
        separateFromExistingDrafts: z.boolean().default(true).describe("true (default, safe): always create a NEW draft for the buyer. false: append the day's line items to the buyer's existing open merge draft instead."),
        priceSource: z.enum(["ebay", "catalog"]).default("ebay").describe("\"ebay\" (default): every line is priced at what the buyer actually paid on eBay — SKU'd lines still link to their variant but carry a price override to the eBay sale price, so the draft total matches what was collected. \"catalog\": SKU'd lines use the variant's current Shopify list price instead. No-SKU lines always use the eBay price either way."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (async (args: {
      dateFrom: string; dateTo: string; minOrdersToMerge: number; dryRun: boolean;
      noteTag?: string; excludeBuyerUsernames?: string[]; separateFromExistingDrafts: boolean;
      priceSource: "ebay" | "catalog";
    }) => {
      const start = Date.now();
      try {
        const tz = config.ebaySellerTimezone;
        const rangeStr = args.dateFrom === args.dateTo ? args.dateFrom : `${args.dateFrom}..${args.dateTo}`;
        const noteTag = args.noteTag ?? rangeStr;
        const excluded = new Set((args.excludeBuyerUsernames ?? []).map((u) => u.toLowerCase()));

        const fromUtc = zonedDayStartToUtc(args.dateFrom, tz);
        const toUtc = new Date(zonedDayStartToUtc(args.dateTo, tz).getTime() + DAY_MS); // inclusive end
        const filter = `creationdate:[${fromUtc.toISOString()}..${toUtc.toISOString()}]`;

        // 1. Pull all orders in the window.
        const orders: EbayOrder[] = [];
        let offset = 0;
        for (let page = 0; page < 40; page++) {
          const res = await ebay.request("GET", "/sell/fulfillment/v1/order", { query: { filter, limit: 200, offset } });
          const batch = (res.data as { orders?: EbayOrder[] } | undefined)?.orders ?? [];
          orders.push(...batch);
          if (batch.length < 200) break;
          offset += 200;
        }

        // 2. Group by buyer username.
        interface Group {
          username: string;
          buyerName: string | null;
          orders: Array<{ orderId: string; total: string | null; currency: string | null }>;
          shipTo: EbayShipTo | undefined;
          lineItems: EbayLineItem[];
          ebayTotal: number;
          currency: string;
        }
        const groups = new Map<string, Group>();
        for (const o of orders) {
          const username = o.buyer?.username ?? "";
          if (!username) continue;
          const shipTo = o.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo;
          let g = groups.get(username);
          if (!g) {
            g = { username, buyerName: shipTo?.fullName ?? null, orders: [], shipTo, lineItems: [], ebayTotal: 0, currency: "USD" };
            groups.set(username, g);
          }
          if (!g.shipTo && shipTo) { g.shipTo = shipTo; g.buyerName = shipTo.fullName ?? g.buyerName; }
          const cur = o.pricingSummary?.total?.currency;
          if (cur) g.currency = cur;
          g.orders.push({ orderId: o.orderId ?? "", total: o.pricingSummary?.total?.value ?? null, currency: cur ?? null });
          g.ebayTotal += Number(o.pricingSummary?.total?.value ?? 0) || 0;
          for (const li of o.lineItems ?? []) g.lineItems.push(li);
        }

        // 3. Determine qualifying vs skipped.
        const qualifying: Group[] = [];
        const skipped: Array<{ buyerUsername: string; buyerName: string | null; orderCount: number; reason: string }> = [];
        for (const g of groups.values()) {
          if (excluded.has(g.username.toLowerCase())) { skipped.push({ buyerUsername: g.username, buyerName: g.buyerName, orderCount: g.orders.length, reason: "excluded" }); continue; }
          if (g.orders.length < args.minOrdersToMerge) { skipped.push({ buyerUsername: g.username, buyerName: g.buyerName, orderCount: g.orders.length, reason: "below minOrdersToMerge" }); continue; }
          qualifying.push(g);
        }

        // 4. Batch-resolve every SKU across qualifying buyers up front.
        const allSkus = qualifying.flatMap((g) => g.lineItems.map((li) => li.sku).filter((s): s is string => Boolean(s)));
        const skuMap = allSkus.length ? await resolveSkus(shopify, allSkus) : new Map();

        // 5. Load open drafts once (for resume-safety + optional append).
        let openDrafts: Array<{ id: string; name: string; note2: string | null }> = [];
        {
          let after: string | null = null;
          for (let page = 0; page < 5; page++) {
            const res: { data: { draftOrders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<{ id: string; name: string; note2: string | null }> } } } =
              await shopify.request(OPEN_DRAFTS, { after });
            openDrafts.push(...res.data.draftOrders.nodes);
            if (!res.data.draftOrders.pageInfo.hasNextPage) break;
            after = res.data.draftOrders.pageInfo.endCursor;
          }
        }

        // 6. Build + (optionally) create a draft per qualifying buyer.
        const merged: Array<Record<string, unknown>> = [];
        for (const g of qualifying) {
          // Aggregate line items. In "ebay" mode a variant line is keyed by
          // (variantId, unitPrice) so the same book sold twice at different
          // auction prices stays as two correctly-priced lines; in "catalog"
          // mode it's keyed by variantId alone (price comes from the catalog).
          const variantAgg = new Map<string, { variantId: string; sku: string; title: string | null; qty: number; unitPrice: string; catalogPrice: string | null; currency: string }>();
          const customAgg = new Map<string, { title: string; unitPrice: string; qty: number }>();
          const unresolvedSkus: string[] = [];
          const noSkuItems: Array<{ title: string; price: string; qty: number }> = [];

          for (const li of g.lineItems) {
            const qty = li.quantity ?? 1;
            const unit = unitPrice(li);
            const currency = li.lineItemCost?.currency ?? g.currency;
            if (li.sku) {
              const v = skuMap.get(li.sku);
              if (v) {
                const key = args.priceSource === "ebay" ? `${v.id}|${unit}` : v.id;
                const cur = variantAgg.get(key);
                if (cur) cur.qty += qty;
                else variantAgg.set(key, { variantId: v.id, sku: li.sku, title: v.title, qty, unitPrice: unit, catalogPrice: v.price, currency });
              } else {
                if (!unresolvedSkus.includes(li.sku)) unresolvedSkus.push(li.sku);
                // fall back to a custom line so nothing is silently dropped (always eBay price)
                const key = `${li.title ?? li.sku}|${unit}`;
                const c = customAgg.get(key);
                if (c) c.qty += qty; else customAgg.set(key, { title: li.title ?? li.sku, unitPrice: unit, qty });
              }
            } else {
              const title = li.title ?? "Custom eBay item";
              const key = `${title}|${unit}`;
              const c = customAgg.get(key);
              if (c) c.qty += qty; else customAgg.set(key, { title, unitPrice: unit, qty });
              noSkuItems.push({ title, price: unit, qty });
            }
          }

          const lineItemsInput: Array<Record<string, unknown>> = [
            ...[...variantAgg.values()].map((v) => {
              const line: Record<string, unknown> = { variantId: v.variantId, quantity: v.qty };
              // "ebay": override the variant's catalog price with the actual sale price.
              if (args.priceSource === "ebay") line.priceOverride = { amount: v.unitPrice, currencyCode: v.currency };
              return line;
            }),
            ...[...customAgg.values()].map((c) => ({ title: c.title, originalUnitPrice: c.unitPrice, quantity: c.qty })),
          ];

          const address = toShopifyAddress(g.shipTo);
          const marker = `ebay-merge buyer:${g.username} range:${rangeStr}`;
          const orderIds = g.orders.map((o) => o.orderId).filter(Boolean);
          const note = `${marker}\n${noteTag}\neBay orders (${orderIds.length}): ${orderIds.join(", ")}\neBay total: $${g.ebayTotal.toFixed(2)}`;

          const plan: Record<string, unknown> = {
            buyerUsername: g.username,
            buyerName: g.buyerName,
            orderCount: g.orders.length,
            orderIds,
            ebayTotal: g.ebayTotal.toFixed(2),
            variantLineItems: [...variantAgg.values()].map((v) => ({ variantId: gidToId(v.variantId), sku: v.sku, title: v.title, qty: v.qty, price: args.priceSource === "ebay" ? v.unitPrice : v.catalogPrice, priceSource: args.priceSource })),
            customLineItems: [...customAgg.values()],
            noSkuItemCount: noSkuItems.length,
            unresolvedSkus,
            address: address ?? null,
          };

          // Resume-safety: same-range marker already present → skip.
          const existingSame = openDrafts.find((d) => (d.note2 ?? "").includes(marker));
          if (existingSame) {
            merged.push({ ...plan, draftOrderName: existingSame.name, draftOrderId: gidToId(existingSame.id), action: "already-merged (skipped)" });
            continue;
          }

          if (args.dryRun) {
            merged.push({ ...plan, draftOrderName: null, draftOrderId: null, action: args.separateFromExistingDrafts ? "would-create" : "would-append-or-create" });
            continue;
          }

          // Append mode: fold into the buyer's existing open merge draft.
          if (!args.separateFromExistingDrafts) {
            const prefix = `ebay-merge buyer:${g.username} range:`;
            const existingAny = openDrafts.find((d) => (d.note2 ?? "").includes(prefix));
            if (existingAny) {
              const draft = await appendToDraft(shopify, existingAny.id, lineItemsInput, note);
              merged.push({ ...plan, draftOrderName: draft.name, draftOrderId: gidToId(draft.id), total: draft.totalPriceSet?.shopMoney.amount ?? null, action: "appended" });
              continue;
            }
          }

          // Create a new draft.
          const input: Record<string, unknown> = { lineItems: lineItemsInput, note, tags: ["ebay-merge"] };
          if (address) input.shippingAddress = address;
          const res = await shopify.request<{ draftOrderCreate: { draftOrder: DraftResult | null; userErrors: Array<{ field: string[] | null; message: string }> } }>(CREATE_DRAFT_ORDER, { input });
          assertNoUserErrors(res.data.draftOrderCreate.userErrors);
          const draft = res.data.draftOrderCreate.draftOrder!;
          openDrafts.push({ id: draft.id, name: draft.name, note2: note });
          merged.push({ ...plan, draftOrderName: draft.name, draftOrderId: gidToId(draft.id), total: draft.totalPriceSet?.shopMoney.amount ?? null, action: "created" });
        }

        const summary = {
          dateRange: rangeStr,
          timeZone: tz,
          priceSource: args.priceSource,
          dryRun: args.dryRun,
          ordersScanned: orders.length,
          buyersTotal: groups.size,
          mergedCount: merged.length,
          skippedCount: skipped.length,
          merged,
          skipped,
        };
        const head = args.dryRun
          ? `**DRY RUN** — ${merged.length} buyer(s) would get a draft from ${rangeStr} (${orders.length} orders scanned, ${skipped.length} buyer(s) below threshold/excluded). Nothing created. Re-run with dryRun:false.`
          : `Merged ${merged.length} buyer(s) into draft orders from ${rangeStr}; ${skipped.length} skipped.`;
        logToolCall({ tool: "ebay_merge_sales_to_draft_orders", durationMs: Date.now() - start, success: true });
        return { content: [textContent(`${head}\n\n\`\`\`json\n${JSON.stringify(summary, null, 2).slice(0, 14000)}\n\`\`\``)], structuredContent: summary };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logToolCall({ tool: "ebay_merge_sales_to_draft_orders", durationMs: Date.now() - start, success: false, error: message });
        return { content: [textContent(`Error: ${message}`)], isError: true };
      }
    }) as never,
  );
}

/** eBay lineItemCost is the cost for the line's quantity; derive a per-unit price. */
function unitPrice(li: EbayLineItem): string {
  const total = Number(li.lineItemCost?.value ?? 0) || 0;
  const qty = li.quantity ?? 1;
  const unit = qty > 0 ? total / qty : total;
  return unit.toFixed(2);
}

/** Append line items to an existing draft (draftOrderUpdate replaces the set, so we re-send existing + new). */
async function appendToDraft(
  shopify: ShopifyClient,
  draftGid: string,
  newLineItems: Array<Record<string, unknown>>,
  appendedNote: string,
): Promise<DraftResult> {
  const existing = await shopify.request<{
    draftOrder: {
      note2: string | null;
      lineItems: { nodes: Array<{ title: string; quantity: number; sku: string | null; variant: { id: string } | null; originalUnitPriceSet: { shopMoney: { amount: string; currencyCode: string } } | null }> };
    } | null;
  }>(DRAFT_LINE_ITEMS, { id: draftGid });
  const cur = existing.data.draftOrder;
  if (!cur) throw new ShopifyError(`Draft order ${draftGid} not found for append.`);
  // Re-send existing lines. For variant lines, preserve the effective unit price
  // via priceOverride so a prior eBay-sale price isn't reset to catalog on update.
  const rebuilt: Array<Record<string, unknown>> = cur.lineItems.nodes.map((li) => {
    const money = li.originalUnitPriceSet?.shopMoney;
    if (li.variant?.id) {
      const line: Record<string, unknown> = { variantId: li.variant.id, quantity: li.quantity };
      if (money) line.priceOverride = { amount: money.amount, currencyCode: money.currencyCode };
      return line;
    }
    return { title: li.title, originalUnitPrice: money?.amount ?? "0.00", quantity: li.quantity };
  });
  const input = {
    lineItems: [...rebuilt, ...newLineItems],
    note: `${cur.note2 ?? ""}\n${appendedNote}`.trim(),
  };
  const res = await shopify.request<{ draftOrderUpdate: { draftOrder: DraftResult | null; userErrors: Array<{ field: string[] | null; message: string }> } }>(UPDATE_DRAFT_ORDER, { id: draftGid, input });
  assertNoUserErrors(res.data.draftOrderUpdate.userErrors);
  return res.data.draftOrderUpdate.draftOrder!;
}
