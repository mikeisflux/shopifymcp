/**
 * Shopify → eBay fulfillment-tracking sync.
 *
 * Each run finds Shopify orders marked shipped (with a tracking number), matches
 * each to its eBay order(s), and pushes the tracking via the eBay Fulfillment
 * API — the automatic counterpart to the manual get-order → find-eBay-order →
 * POST shipping_fulfillment → confirm dance.
 *
 * Matching rules (never guess):
 *   - A Shopify order whose NAME is an eBay order id verbatim (e.g.
 *     `26-15065-57798`) → that single eBay order.
 *   - A merge-draft order (its note carries the `ebay-merge` marker / eBay order
 *     ids) → push to EVERY eBay order id in the note; one combined package
 *     fulfills all the originals.
 *   - Anything else (a shopify_payments/manual order with a `#12870`-style name
 *     and no eBay ids) → skipped and reported, never matched to a "closest" order.
 *
 * Idempotent: each target eBay order's `orderFulfillmentStatus` is checked first
 * and skipped if already `FULFILLED`, so re-runs / overlapping schedules don't
 * double-post. A persisted watermark (last run time) means a delayed or failed
 * run doesn't miss orders.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ShopifyClient } from "./shopify-client.js";
import type { EbayClient } from "./ebay-client.js";
import type { Config } from "./config.js";
import { log } from "./logger.js";
import { parseEbayOrderIds, EBAY_ORDER_ID_RE } from "./ebay-order-ids.js";

const FULFILLED_ORDERS = /* GraphQL */ `
  query FulfilledOrders($query: String!, $after: String) {
    orders(first: 50, after: $after, query: $query, sortKey: UPDATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id name note updatedAt displayFulfillmentStatus
        transactions(first: 10) { gateway }
        fulfillments(first: 10) { status trackingInfo { number company url } }
      }
    }
  }
`;

const ORDERS_BY_ID = /* GraphQL */ `
  query OrdersByIdForSync($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order {
        id name note updatedAt displayFulfillmentStatus
        transactions(first: 10) { gateway }
        fulfillments(first: 10) { status trackingInfo { number company url } }
      }
    }
  }
`;

interface ShopOrder {
  id: string;
  name: string;
  note: string | null;
  updatedAt: string;
  displayFulfillmentStatus: string;
  transactions: Array<{ gateway: string | null }>;
  fulfillments: Array<{ status: string; trackingInfo: Array<{ number: string | null; company: string | null; url: string | null }> }>;
}

interface SyncState {
  watermark: string | null;
  lastRunAt: string | null;
  lastResults: unknown;
}

export interface SyncResult {
  runAt: string;
  dryRun: boolean;
  watermarkAdvancedTo: string | null;
  synced: Array<Record<string, unknown>>;
  skippedAlreadyFulfilled: Array<Record<string, unknown>>;
  skippedNoTracking: Array<Record<string, unknown>>;
  skippedNoEbayMatch: Array<Record<string, unknown>>;
  failed: Array<Record<string, unknown>>;
}

/** Map a Shopify tracking company to an eBay shippingCarrierCode. */
function carrierCode(company: string | null | undefined): string {
  const c = (company ?? "").toUpperCase();
  if (c.includes("USPS") || c.includes("POSTAL")) return "USPS";
  if (c.includes("UPS")) return "UPS";
  if (c.includes("FEDEX")) return "FedEx";
  if (c.includes("DHL")) return "DHL";
  return "OTHER";
}

export class FulfillmentSyncEngine {
  private readonly file: string;
  private state: SyncState;

  constructor(
    private readonly shopify: ShopifyClient,
    private readonly ebay: EbayClient,
    config: Config,
  ) {
    const dir = config.trackingSync.stateDir;
    try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
    this.file = join(dir, "tracking-sync-state.json");
    this.state = this.load();
  }

  private load(): SyncState {
    try {
      if (existsSync(this.file)) return { watermark: null, lastRunAt: null, lastResults: null, ...JSON.parse(readFileSync(this.file, "utf8")) };
    } catch (e) { log.warn("tracking_sync_state_load_failed", { error: e instanceof Error ? e.message : String(e) }); }
    return { watermark: null, lastRunAt: null, lastResults: null };
  }

  private save(): void {
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      renameSync(tmp, this.file);
    } catch (e) { log.error("tracking_sync_state_save_failed", { error: e instanceof Error ? e.message : String(e) }); }
  }

  getState(): SyncState { return this.state; }

  /** Fetch the candidate Shopify orders for this run. */
  private async candidates(sinceIso: string | null, orderIds: string[] | undefined): Promise<ShopOrder[]> {
    if (orderIds && orderIds.length) {
      const ids = orderIds.map((o) => (o.startsWith("gid://") ? o : `gid://shopify/Order/${o}`));
      const res = await this.shopify.request<{ nodes: Array<ShopOrder | null> }>(ORDERS_BY_ID, { ids });
      return res.data.nodes.filter((n): n is ShopOrder => Boolean(n && n.name));
    }
    const parts = ["fulfillment_status:shipped"];
    if (sinceIso) parts.push(`updated_at:>='${sinceIso}'`);
    const query = parts.join(" ");
    const out: ShopOrder[] = [];
    let after: string | null = null;
    for (let page = 0; page < 20; page++) {
      const res: { data: { orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ShopOrder[] } } } =
        await this.shopify.request(FULFILLED_ORDERS, { query, after });
      out.push(...res.data.orders.nodes);
      if (!res.data.orders.pageInfo.hasNextPage) break;
      after = res.data.orders.pageInfo.endCursor;
    }
    return out;
  }

  /** Resolve which eBay order id(s) a Shopify order maps to (or null to skip). */
  private matchEbayOrders(o: ShopOrder): { ids: string[]; kind: "direct" | "merge" } | null {
    const noteIds = parseEbayOrderIds(o.note);
    const isMerge = /ebay-merge/i.test(o.note ?? "") || /ebay orders \(/i.test(o.note ?? "");
    if (isMerge && noteIds.length) return { ids: noteIds, kind: "merge" };
    if (EBAY_ORDER_ID_RE.test(o.name.replace(/^#/, ""))) return { ids: [o.name.replace(/^#/, "")], kind: "direct" };
    return null;
  }

  /** POST tracking to one eBay order; returns the outcome bucket + detail. */
  private async pushOne(ebayOrderId: string, carrier: string, tracking: string, dryRun: boolean, note?: string): Promise<{ bucket: "synced" | "skippedAlreadyFulfilled" | "failed"; detail: Record<string, unknown> }> {
    const detail: Record<string, unknown> = { ebayOrderId, trackingNumber: tracking, carrier };
    if (note) detail.note = note;
    const getRes = await this.ebay.request("GET", `/sell/fulfillment/v1/order/${encodeURIComponent(ebayOrderId)}`).catch(() => null);
    if (!getRes) { return { bucket: "failed", detail: { ...detail, error: "eBay order not found" } }; }
    const order = getRes.data as { orderFulfillmentStatus?: string; lineItems?: Array<{ lineItemId?: string; quantity?: number }> } | undefined;
    if ((order?.orderFulfillmentStatus ?? "").toUpperCase() === "FULFILLED") return { bucket: "skippedAlreadyFulfilled", detail };
    const lineItems = (order?.lineItems ?? []).filter((li) => li.lineItemId).map((li) => ({ lineItemId: li.lineItemId!, quantity: li.quantity ?? 1 }));
    if (!lineItems.length) return { bucket: "failed", detail: { ...detail, error: "no lineItemIds on eBay order" } };
    if (dryRun) return { bucket: "synced", detail: { ...detail, dryRun: true, lineItems: lineItems.length } };
    const body = { lineItems, shippingCarrierCode: carrier, trackingNumber: tracking };
    const post = await this.ebay.request("POST", `/sell/fulfillment/v1/order/${encodeURIComponent(ebayOrderId)}/shipping_fulfillment`, { body }).catch((e) => { throw e; });
    return { bucket: "synced", detail: { ...detail, fulfillmentId: (post.data as { fulfillmentId?: string } | undefined)?.fulfillmentId ?? null } };
  }

  /**
   * Run one sync pass. Scheduled runs (no orderIds / sinceMinutes) advance the
   * watermark; manual overrides do not.
   */
  async run(opts: { sinceMinutes?: number; orderIds?: string[]; dryRun: boolean } = { dryRun: true }): Promise<SyncResult> {
    const runAt = new Date().toISOString();
    const isScheduledScan = !opts.orderIds?.length && opts.sinceMinutes == null;
    const sinceIso = opts.orderIds?.length
      ? null
      : opts.sinceMinutes != null
        ? new Date(Date.now() - opts.sinceMinutes * 60_000).toISOString()
        : this.state.watermark;

    const result: SyncResult = { runAt, dryRun: opts.dryRun, watermarkAdvancedTo: null, synced: [], skippedAlreadyFulfilled: [], skippedNoTracking: [], skippedNoEbayMatch: [], failed: [] };

    let orders: ShopOrder[];
    try {
      orders = await this.candidates(sinceIso, opts.orderIds);
    } catch (e) {
      log.error("tracking_sync_query_failed", { error: e instanceof Error ? e.message : String(e) });
      throw e;
    }

    for (const o of orders) {
      const tracking = o.fulfillments.flatMap((f) => f.trackingInfo).find((t) => t.number);
      if (!tracking?.number) { result.skippedNoTracking.push({ shopifyOrderName: o.name, reason: "fulfilled but no tracking number set" }); continue; }
      const match = this.matchEbayOrders(o);
      if (!match) {
        const gateway = o.transactions.map((t) => t.gateway).filter(Boolean).join(",") || "unknown";
        result.skippedNoEbayMatch.push({ shopifyOrderName: o.name, reason: `gateway is ${gateway}, not an eBay order (and no merge note)` });
        continue;
      }
      const carrier = carrierCode(tracking.company);
      for (let i = 0; i < match.ids.length; i++) {
        const ebayOrderId = match.ids[i]!;
        const note = match.kind === "merge" ? `${i + 1} of ${match.ids.length} merged eBay orders` : undefined;
        try {
          const { bucket, detail } = await this.pushOne(ebayOrderId, carrier, tracking.number, opts.dryRun, note);
          result[bucket].push({ shopifyOrderName: o.name, ...detail });
        } catch (e) {
          result.failed.push({ shopifyOrderName: o.name, ebayOrderId, error: e instanceof Error ? e.message : String(e) });
        }
      }
    }

    // Advance the watermark only for a real scheduled scan that didn't hard-fail.
    if (isScheduledScan && !opts.dryRun) {
      this.state.watermark = runAt;
      result.watermarkAdvancedTo = runAt;
    }
    this.state.lastRunAt = runAt;
    this.state.lastResults = { synced: result.synced.length, skippedAlreadyFulfilled: result.skippedAlreadyFulfilled.length, skippedNoTracking: result.skippedNoTracking.length, skippedNoEbayMatch: result.skippedNoEbayMatch.length, failed: result.failed.length };
    this.save();

    const level = result.failed.length ? "warn" : "info";
    log[level]("tracking_sync_run", { dryRun: opts.dryRun, orders: orders.length, synced: result.synced.length, alreadyFulfilled: result.skippedAlreadyFulfilled.length, noTracking: result.skippedNoTracking.length, noMatch: result.skippedNoEbayMatch.length, failed: result.failed.length });
    return result;
  }
}

/** Start the recurring tracking-sync scheduler (no-op when disabled). */
export function startTrackingSyncScheduler(engine: FulfillmentSyncEngine, config: Config): NodeJS.Timeout | null {
  if (!config.trackingSync.enabled) { log.info("tracking_sync_disabled"); return null; }
  const ms = Math.max(1, config.trackingSync.intervalMin) * 60_000;
  const tick = () => { void engine.run({ dryRun: false }).catch((e) => log.error("tracking_sync_cycle_failed", { error: e instanceof Error ? e.message : String(e) })); };
  const timer = setInterval(tick, ms);
  setTimeout(tick, 60_000); // first run a minute after boot
  log.info("tracking_sync_started", { interval_min: config.trackingSync.intervalMin });
  return timer;
}
