/**
 * Blended popularity model for smart auction ordering (Phase 5).
 *
 * Ranks "covers" (a SKU stem like G1-07, collapsing the regular/foil/metal
 * variants and the -ebaylive twin into one cover) by how much money they make,
 * blending two signals:
 *   • store sales  — revenue per cover from Shopify orders in a trailing window
 *   • auction results — revenue per cover from the engine's own closed auctions
 *
 * The blend is auction-weighted and SELF-ADJUSTING: with little auction history
 * it leans on store sales; as real auction results roll in, their weight rises
 * toward a cap. The result is a 0..1 score per cover stem that listBatch sorts
 * by, so proven money-makers list first.
 */

import type { ShopifyClient } from "./shopify-client.js";
import type { AuctionStore } from "./auction-store.js";
import { log } from "./logger.js";

/** Trailing window of Shopify order history to weigh for store popularity. */
const WINDOW_DAYS = 180;
/** Max order pages to scan per build (250/page) — bounds a heavy cold build. */
const MAX_ORDER_PAGES = 120;
/** Auction-weight half-saturation: at this many auction sales, wAuction ≈ 0.5. */
const AUCTION_HALF = 40;
/** Cap on how much the blend can lean on auctions. */
const AUCTION_WEIGHT_CAP = 0.85;

const ORDERS_Q = /* GraphQL */ `
  query PopularityOrders($q: String!, $first: Int!, $after: String) {
    orders(first: $first, after: $after, query: $q) {
      pageInfo { hasNextPage endCursor }
      nodes { lineItems(first: 50) { nodes { sku quantity originalUnitPriceSet { shopMoney { amount } } } } }
    }
  }`;

export interface Popularity {
  /** cover stem -> blended 0..1 score (higher = list sooner). */
  byStem: Record<string, number>;
  builtAtMs: number;
  storeRevenue: number;
  auctionSales: number;
  auctionWeight: number;
  topStems: Array<{ stem: string; score: number }>;
}

/** Normalize a map's values to 0..1 by its max (empty-safe). */
function normalize(m: Record<string, number>): Record<string, number> {
  const max = Math.max(1, ...Object.values(m));
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(m)) out[k] = v / max;
  return out;
}

/**
 * Build the blended popularity map. `stemOf` maps any SKU (store, ebaylive, or
 * variant) to its cover stem so both signals align on the same cover.
 */
export async function buildPopularity(
  shopify: ShopifyClient,
  store: AuctionStore,
  stemOf: (sku: string) => string,
): Promise<Popularity> {
  // 1) Store sales → revenue per cover stem over the trailing window.
  const storeRevByStem: Record<string, number> = {};
  let storeRevenue = 0;
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  let after: string | null = null;
  for (let page = 0; page < MAX_ORDER_PAGES; page++) {
    const res: { data: { orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<{ lineItems: { nodes: Array<{ sku: string | null; quantity: number | null; originalUnitPriceSet: { shopMoney: { amount: string | null } } | null }> } }> } } } =
      await shopify.request(ORDERS_Q, { q: `created_at:>=${since}`, first: 250, after });
    const o = res.data.orders;
    for (const ord of o.nodes) {
      for (const li of ord.lineItems.nodes) {
        if (!li.sku) continue;
        const qty = li.quantity ?? 1;
        const price = Number(li.originalUnitPriceSet?.shopMoney?.amount ?? 0);
        const rev = qty * (Number.isFinite(price) ? price : 0);
        const stem = stemOf(li.sku);
        storeRevByStem[stem] = (storeRevByStem[stem] ?? 0) + rev;
        storeRevenue += rev;
      }
    }
    if (!o.pageInfo.hasNextPage) break;
    after = o.pageInfo.endCursor;
  }

  // 2) Auction results → revenue per cover stem from closed, SOLD auctions.
  const auctionRevByStem: Record<string, number> = {};
  let auctionSales = 0;
  for (const h of store.get().history) {
    if (!h.sold || h.soldPrice == null) continue;
    const stem = stemOf(h.sku);
    auctionRevByStem[stem] = (auctionRevByStem[stem] ?? 0) + h.soldPrice;
    auctionSales++;
  }

  // 3) Self-adjusting weight — trust auctions more as results accumulate.
  const auctionWeight = Math.min(AUCTION_WEIGHT_CAP, auctionSales / (auctionSales + AUCTION_HALF));

  // 4) Normalize each signal and blend per stem.
  const sN = normalize(storeRevByStem);
  const aN = normalize(auctionRevByStem);
  const byStem: Record<string, number> = {};
  for (const stem of new Set([...Object.keys(sN), ...Object.keys(aN)])) {
    byStem[stem] = auctionWeight * (aN[stem] ?? 0) + (1 - auctionWeight) * (sN[stem] ?? 0);
  }

  const topStems = Object.entries(byStem)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([stem, score]) => ({ stem, score: Math.round(score * 1000) / 1000 }));

  log.info("auction_popularity_built", {
    stems: Object.keys(byStem).length,
    storeRevenue: Math.round(storeRevenue),
    auctionSales,
    auctionWeight: Math.round(auctionWeight * 100) / 100,
  });

  return { byStem, builtAtMs: Date.now(), storeRevenue, auctionSales, auctionWeight, topStems };
}
