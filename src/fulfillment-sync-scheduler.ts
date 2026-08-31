/**
 * Drives the FulfillmentSyncEngine on a timer — the tracking-sync counterpart to
 * AuctionScheduler, deliberately built the same way (pure setTimeout/setInterval,
 * no cron dependency; each run guarded and self-logging). A separate concern from
 * the auction scheduler, so it lives in its own file and is gated by its own flag.
 *
 * overlapPolicy: skip — an in-memory boolean lock means if a run is still in
 * progress when the next tick fires, that tick is skipped (single process, no
 * distributed lock needed). onFailure: log_and_continue — a run's error is logged
 * and never thrown out of the timer.
 */

import type { FulfillmentSyncEngine } from "./fulfillment-sync.js";
import type { TrackingSyncConfig } from "./config.js";
import { log } from "./logger.js";

export class FulfillmentSyncScheduler {
  private timers: NodeJS.Timeout[] = [];
  private running = false;
  constructor(private readonly engine: FulfillmentSyncEngine, private readonly cfg: TrackingSyncConfig) {}

  start(): void {
    if (!this.cfg.enabled) { log.info("fulfillment_sync_disabled"); return; }
    this.every(this.cfg.intervalMin, "sync", () => this.engine.run({ dryRun: false }));
    log.info("fulfillment_sync_started", { interval_min: this.cfg.intervalMin });
  }

  stop(): void { for (const t of this.timers) clearInterval(t); this.timers = []; }

  private every(minutes: number, name: string, fn: () => Promise<unknown>): void {
    const ms = Math.max(1, minutes) * 60 * 1000;
    // Delay the first run so it doesn't fire during boot alongside everything else.
    const kickoff = setTimeout(() => {
      void this.run(name, fn);
      this.timers.push(setInterval(() => void this.run(name, fn), ms));
    }, 60_000);
    this.timers.push(kickoff);
  }

  private async run(name: string, fn: () => Promise<unknown>): Promise<void> {
    if (this.running) { log.info("fulfillment_sync_skip_overlap", { cycle: name }); return; }
    this.running = true;
    try { await fn(); }
    catch (err) { log.error("fulfillment_sync_cycle_failed", { cycle: name, error: err instanceof Error ? err.message : String(err) }); }
    finally { this.running = false; }
  }
}
