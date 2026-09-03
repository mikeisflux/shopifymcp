/**
 * Scheduled eBay → Shopify order import.
 *
 * Wraps the SAME code path as the ebay_merge_sales_to_draft_orders tool
 * (makeMergeHandler), so a bug fixed in one is fixed in both. Each run imports a
 * trailing window of eBay sales into Shopify draft orders with minOrdersToMerge:1
 * (so single-order stragglers — the Granger case that motivated this — are caught,
 * not just 2+ buyers) and separateFromExistingDrafts:false (fold new orders into a
 * buyer's existing open draft rather than making a duplicate). The merge tool's
 * order-level dedup means re-covering a day it already imported is a no-op, so the
 * overlapping trailing window is safe.
 *
 * State (last run + which fixed time-slots have fired today) persists to
 * `/data/order-sync-state.json`, so a restart doesn't re-fire a slot.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ShopifyClient } from "./shopify-client.js";
import type { EbayClient } from "./ebay-client.js";
import type { Config } from "./config.js";
import { log } from "./logger.js";
import { makeMergeHandler, type MergeArgs } from "./tools/ebay-merge.js";
import { DAY_MS, toZonedIso } from "./tz.js";

interface OrderSyncState {
  lastRunAt: string | null;
  lastResults: unknown;
  /** hour-of-day → the YYYY-MM-DD it last fired (in the schedule timezone). */
  slots: Record<string, string>;
}

export class OrderSyncEngine {
  private readonly file: string;
  private state: OrderSyncState;
  private readonly merge: (args: MergeArgs) => Promise<{ structuredContent?: Record<string, unknown>; isError?: boolean; content: Array<{ text?: string }> }>;

  constructor(shopify: ShopifyClient, ebay: EbayClient, private readonly config: Config) {
    const dir = config.orderSync.stateDir;
    try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
    this.file = join(dir, "order-sync-state.json");
    this.state = this.load();
    this.merge = makeMergeHandler(shopify, ebay, config) as never;
  }

  private load(): OrderSyncState {
    try {
      if (existsSync(this.file)) return { lastRunAt: null, lastResults: null, slots: {}, ...JSON.parse(readFileSync(this.file, "utf8")) };
    } catch (e) { log.warn("order_sync_state_load_failed", { error: e instanceof Error ? e.message : String(e) }); }
    return { lastRunAt: null, lastResults: null, slots: {} };
  }

  private save(): void {
    try { const tmp = `${this.file}.tmp`; writeFileSync(tmp, JSON.stringify(this.state, null, 2)); renameSync(tmp, this.file); }
    catch (e) { log.error("order_sync_state_save_failed", { error: e instanceof Error ? e.message : String(e) }); }
  }

  getState(): OrderSyncState { return this.state; }

  /** Has the given fixed hour-slot already fired on `dateStr`? */
  slotFired(hour: number, dateStr: string): boolean { return this.state.slots[String(hour)] === dateStr; }
  markSlotFired(hour: number, dateStr: string): void { this.state.slots[String(hour)] = dateStr; this.save(); }

  /** Local `YYYY-MM-DD` (seller timezone) `days` before now. */
  private localDate(days: number): string {
    return toZonedIso(new Date(Date.now() - days * DAY_MS), this.config.ebaySellerTimezone).slice(0, 10);
  }

  /**
   * Run one import pass over a trailing window. dryRun previews; otherwise it
   * creates/updates drafts via the shared merge code path.
   */
  async run(opts: { lookbackDays?: number; dryRun?: boolean } = {}): Promise<Record<string, unknown> | null> {
    const lookbackDays = opts.lookbackDays ?? this.config.orderSync.lookbackDays;
    const dryRun = opts.dryRun ?? false;
    const dateTo = this.localDate(0);
    const dateFrom = this.localDate(Math.max(0, lookbackDays));
    const args: MergeArgs = {
      dateFrom, dateTo,
      minOrdersToMerge: 1,             // catch single-order stragglers too
      dryRun,
      separateFromExistingDrafts: false, // fold into an existing open draft, never a shipped one
      priceSource: "ebay",
      closeSourceIfSynced: false,
    };
    const res = await this.merge(args);
    const summary = res.structuredContent ?? null;
    this.state.lastRunAt = new Date().toISOString();
    this.state.lastResults = summary && {
      dateRange: (summary as Record<string, unknown>).dateRange,
      merged: (summary as Record<string, unknown>).mergedCount,
      alreadySynced: (summary as Record<string, unknown>).ordersAlreadySynced,
      skipped: (summary as Record<string, unknown>).skippedCount,
    };
    this.save();
    const s = summary as Record<string, number | string> | null;
    log.info("order_sync_run", { dryRun, range: `${dateFrom}..${dateTo}`, merged: s?.mergedCount ?? 0, alreadySynced: s?.ordersAlreadySynced ?? 0, scanned: s?.ordersScanned ?? 0, skipped: s?.skippedCount ?? 0 });
    return summary;
  }
}
