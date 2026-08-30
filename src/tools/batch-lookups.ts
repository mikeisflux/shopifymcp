/**
 * Batch lookup primitives shared across the bulk workflows:
 *
 *  - shopify_resolve_skus     — SKU strings → variant GID / price / inventory,
 *                               one batched query instead of search+get per SKU.
 *  - ebay_check_listing_status — SKU strings → eBay listing status (active /
 *                               ended / unpublished / no_offer / no_inventory_item).
 *
 * The `resolveSkus` helper is also imported by the merge/reprice tools so they
 * don't reimplement SKU lookup.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ShopifyClient } from "../shopify-client.js";
import { EbayClient } from "../ebay-client.js";
import { logToolCall } from "../logger.js";
import { textContent } from "../format.js";

/** Escape a SKU for use inside a Shopify search query quoted value. */
export function escapeSkuValue(sku: string): string {
  return sku.replace(/["\\]/g, "\\$&");
}

export interface ResolvedVariant {
  id: string;
  sku: string;
  price: string | null;
  title: string | null;
  productId: string | null;
  count: number; // how many variants matched this SKU (>1 = ambiguous)
}

const RESOLVE_SKUS_BASE = /* GraphQL */ `
  query ResolveSkus($query: String!) {
    productVariants(first: 250, query: $query) {
      nodes {
        id sku price
        product { id title }
      }
    }
  }
`;

const RESOLVE_SKUS_INVENTORY = /* GraphQL */ `
  query ResolveSkusInv($query: String!) {
    productVariants(first: 250, query: $query) {
      nodes {
        id sku price inventoryQuantity
        product { id title }
        inventoryItem {
          inventoryLevels(first: 20) {
            nodes { location { name } quantities(names: ["available"]) { name quantity } }
          }
        }
      }
    }
  }
`;

interface RawVariant {
  id: string;
  sku: string | null;
  price: string | null;
  inventoryQuantity?: number | null;
  product: { id: string; title: string | null } | null;
  inventoryItem?: { inventoryLevels: { nodes: Array<{ location: { name: string } | null; quantities: Array<{ name: string; quantity: number }> }> } } | null;
}

/**
 * Batch-resolve SKUs to variants. Returns a map of sku → variant (first match
 * per SKU). Chunks the OR-search so the query string stays bounded.
 */
export async function resolveSkus(shopify: ShopifyClient, skus: string[]): Promise<Map<string, ResolvedVariant>> {
  const out = new Map<string, ResolvedVariant>();
  const unique = [...new Set(skus.filter(Boolean))];
  const CHUNK = 40;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const query = chunk.map((s) => `sku:"${escapeSkuValue(s)}"`).join(" OR ");
    const res = await shopify.request<{ productVariants: { nodes: RawVariant[] } }>(RESOLVE_SKUS_BASE, { query });
    for (const v of res.data.productVariants.nodes) {
      if (!v.sku) continue;
      const existing = out.get(v.sku);
      if (existing) { existing.count += 1; continue; }
      out.set(v.sku, { id: v.id, sku: v.sku, price: v.price, title: v.product?.title ?? null, productId: v.product?.id ?? null, count: 1 });
    }
  }
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function registerBatchLookupTools(server: McpServer, shopify: ShopifyClient, ebay: EbayClient): void {
  // ─── shopify_resolve_skus ──────────────────────────────────────────────────
  server.registerTool(
    "shopify_resolve_skus",
    {
      title: "Resolve SKUs to variant IDs (batched)",
      description:
        "Resolve many SKUs (up to ~200) to Shopify ProductVariant GIDs in one batched query instead of a search + get per SKU. Returns one entry per input SKU IN INPUT ORDER (so results zip back against a line-item list) with variantId, productId, product title, and price; misses come back with variantId:null and a reason ('not found' / 'ambiguous') rather than being dropped. includeInventory adds each variant's available quantity per location.",
      inputSchema: {
        skus: z.array(z.string()).min(1).max(200).describe("SKU strings to resolve (input order is preserved in the result)."),
        includeInventory: z.boolean().default(false).describe("If true, also return each variant's available quantity per location."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    (async (args: { skus: string[]; includeInventory: boolean }) => {
      const start = Date.now();
      try {
        // One batched query, optionally with inventory.
        const map = new Map<string, RawVariant>();
        const counts = new Map<string, number>();
        const unique = [...new Set(args.skus.filter(Boolean))];
        const CHUNK = 40;
        for (let i = 0; i < unique.length; i += CHUNK) {
          const chunk = unique.slice(i, i + CHUNK);
          const query = chunk.map((s) => `sku:"${escapeSkuValue(s)}"`).join(" OR ");
          const res = await shopify.request<{ productVariants: { nodes: RawVariant[] } }>(args.includeInventory ? RESOLVE_SKUS_INVENTORY : RESOLVE_SKUS_BASE, { query });
          for (const v of res.data.productVariants.nodes) {
            if (!v.sku) continue;
            counts.set(v.sku, (counts.get(v.sku) ?? 0) + 1);
            if (!map.has(v.sku)) map.set(v.sku, v);
          }
        }

        const results = args.skus.map((sku) => {
          const v = map.get(sku);
          const n = counts.get(sku) ?? 0;
          if (!v) return { sku, variantId: null, found: false, reason: "not found" as const };
          if (n > 1) return { sku, variantId: null, found: false, reason: `matched ${n} variants, ambiguous` };
          const entry: Record<string, unknown> = {
            sku,
            variantId: v.id,
            productId: v.product?.id ?? null,
            productTitle: v.product?.title ?? null,
            price: v.price,
            found: true,
          };
          if (args.includeInventory) {
            entry.available = v.inventoryQuantity ?? null;
            entry.inventoryByLocation = (v.inventoryItem?.inventoryLevels.nodes ?? []).map((lvl) => ({
              location: lvl.location?.name ?? null,
              available: lvl.quantities.find((q) => q.name === "available")?.quantity ?? null,
            }));
          }
          return entry;
        });

        const foundCount = results.filter((r) => r.found).length;
        const summary = { requested: args.skus.length, found: foundCount, missing: args.skus.length - foundCount, results };
        logToolCall({ tool: "shopify_resolve_skus", durationMs: Date.now() - start, success: true });
        return { content: [textContent(`Resolved ${foundCount}/${args.skus.length} SKU(s).\n\n\`\`\`json\n${JSON.stringify(summary, null, 2).slice(0, 12000)}\n\`\`\``)], structuredContent: summary };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logToolCall({ tool: "shopify_resolve_skus", durationMs: Date.now() - start, success: false, error: message });
        return { content: [textContent(`Error: ${message}`)], isError: true };
      }
    }) as never,
  );

  // ─── ebay_check_listing_status ─────────────────────────────────────────────
  server.registerTool(
    "ebay_check_listing_status",
    {
      title: "Check eBay listing status (batched)",
      description:
        "Given a list of SKUs, return each one's current eBay listing status in one call: 'active' / 'ended' / 'unpublished' / 'no_offer' (inventory item exists but no offer) / 'no_inventory_item' (nothing on eBay for this SKU). Also returns offerId, listingId, and current price when active. The no_offer vs no_inventory_item distinction tells you whether a clean relist needs an inventory-item delete first.",
      inputSchema: {
        skus: z.array(z.string()).min(1).max(200).describe("SKUs to check (the -ebaylive SKU, as ebay_get_offers expects)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    (async (args: { skus: string[] }) => {
      const start = Date.now();
      try {
        const results = await checkListingStatus(ebay, args.skus);
        const byStatus: Record<string, number> = {};
        for (const r of results) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
        const summary = { requested: args.skus.length, byStatus, results };
        logToolCall({ tool: "ebay_check_listing_status", durationMs: Date.now() - start, success: true });
        return { content: [textContent(`Checked ${results.length} SKU(s): ${Object.entries(byStatus).map(([k, v]) => `${v} ${k}`).join(", ")}.\n\n\`\`\`json\n${JSON.stringify(summary, null, 2).slice(0, 12000)}\n\`\`\``)], structuredContent: summary };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logToolCall({ tool: "ebay_check_listing_status", durationMs: Date.now() - start, success: false, error: message });
        return { content: [textContent(`Error: ${message}`)], isError: true };
      }
    }) as never,
  );
}

export type ListingStatus = "active" | "ended" | "unpublished" | "no_offer" | "no_inventory_item";
export interface StatusResult {
  sku: string;
  status: ListingStatus;
  offerId: string | null;
  listingId: string | null;
  price: string | null;
}

interface EbayOffer {
  offerId?: string;
  status?: string;
  listing?: { listingId?: string; listingStatus?: string };
  pricingSummary?: { price?: { value?: string }; auctionStartPrice?: { value?: string } };
}

/** Check the eBay listing status for a batch of SKUs (bounded concurrency). */
export async function checkListingStatus(ebay: EbayClient, skus: string[]): Promise<StatusResult[]> {
  const results: StatusResult[] = new Array(skus.length);
  const CONCURRENCY = 5;
  for (let i = 0; i < skus.length; i += CONCURRENCY) {
    const slice = skus.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(slice.map((sku) => oneStatus(ebay, sku)));
    for (let j = 0; j < settled.length; j++) results[i + j] = settled[j]!;
    if (i + CONCURRENCY < skus.length) await sleep(120);
  }
  return results;
}

async function oneStatus(ebay: EbayClient, sku: string): Promise<StatusResult> {
  const base: StatusResult = { sku, status: "no_inventory_item", offerId: null, listingId: null, price: null };
  const offerRes = await ebay.request("GET", "/sell/inventory/v1/offer", { query: { sku } }).catch(() => null);
  const offers = (offerRes?.data as { offers?: EbayOffer[] } | undefined)?.offers ?? [];
  if (offers.length) {
    // Prefer a published/active offer if several exist.
    const offer = offers.find((o) => o.listing?.listingId) ?? offers[0]!;
    const listingStatus = (offer.listing?.listingStatus ?? "").toUpperCase();
    const offerStatus = (offer.status ?? "").toUpperCase();
    let status: ListingStatus;
    if (offerStatus === "UNPUBLISHED" || (!offer.listing?.listingId && offerStatus !== "PUBLISHED")) status = "unpublished";
    else if (listingStatus === "ACTIVE") status = "active";
    else if (listingStatus === "ENDED" || listingStatus === "COMPLETED") status = "ended";
    else if (offer.listing?.listingId) status = "active";
    else status = "unpublished";
    const price = offer.pricingSummary?.price?.value ?? offer.pricingSummary?.auctionStartPrice?.value ?? null;
    return { sku, status, offerId: offer.offerId ?? null, listingId: offer.listing?.listingId ?? null, price };
  }
  // No offer — distinguish "inventory item exists" from "nothing at all".
  const invRes = await ebay.request("GET", `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`).catch(() => null);
  if (invRes && invRes.status >= 200 && invRes.status < 300) return { ...base, status: "no_offer" };
  return base;
}
