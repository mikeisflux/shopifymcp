/**
 * Drives the OrderSyncEngine. Built the same way as AuctionScheduler /
 * FulfillmentSyncScheduler (pure setTimeout/setInterval, no cron dependency,
 * guarded self-logging runs). A separate concern in its own file.
 *
 * The comprehensive sweep must fire at fixed times of day (default 8 AM & 2 PM
 * America/Chicago). The existing schedulers only tick on an interval, so this one
 * ticks frequently and fires a slot when the wall clock first enters that hour —
 * using an IANA timezone means DST is handled automatically, no twice-a-year
 * manual adjustment. Slot firings are recorded in the engine's state so a restart
 * during the hour doesn't double-fire. An optional frequent interval runs the
 * same import over a short window to catch brand-new sales between the fixed runs.
 *
 * overlapPolicy: skip (in-memory lock); onFailure: log_and_continue.
 */

import type { OrderSyncEngine } from "./order-sync.js";
import type { OrderSyncConfig } from "./config.js";
import { log } from "./logger.js";
import { zonedClock } from "./tz.js";

const TICK_MIN = 5;

export class OrderSyncScheduler {
  private timers: NodeJS.Timeout[] = [];
  private running = false;

  constructor(private readonly engine: OrderSyncEngine, private readonly cfg: OrderSyncConfig) {}

  start(): void {
    if (!this.cfg.enabled) { log.info("order_sync_disabled"); return; }
    // Fixed-time comprehensive sweeps: check the clock every few minutes.
    const tick = setInterval(() => void this.checkSlots(), TICK_MIN * 60 * 1000);
    this.timers.push(tick);
    // Optional frequent trailing-window sweep.
    if (this.cfg.frequentIntervalMin > 0) {
      const ms = this.cfg.frequentIntervalMin * 60 * 1000;
      const f = setInterval(() => void this.run("frequent", () => this.engine.run({ lookbackDays: 1 })), ms);
      this.timers.push(f);
    }
    log.info("order_sync_started", { timezone: this.cfg.timezone, times: this.cfg.times, lookback_days: this.cfg.lookbackDays, frequent_min: this.cfg.frequentIntervalMin });
    // Run a catch-up sweep shortly after boot so a restart doesn't wait for the next slot.
    this.timers.push(setTimeout(() => void this.run("startup", () => this.engine.run({})), 90_000));
  }

  stop(): void { for (const t of this.timers) clearInterval(t); this.timers = []; }

  /** Fire any fixed time-slot whose hour we've just entered and that hasn't fired today. */
  private async checkSlots(): Promise<void> {
    const { hour, minute, dateStr } = zonedClock(new Date(), this.cfg.timezone);
    for (const target of this.cfg.times) {
      // Fire once, near the top of the target hour, if not already fired today.
      if (hour === target && minute < TICK_MIN * 2 && !this.engine.slotFired(target, dateStr)) {
        this.engine.markSlotFired(target, dateStr);
        await this.run(`slot-${target}:00`, () => this.engine.run({}));
      }
    }
  }

  private async run(name: string, fn: () => Promise<unknown>): Promise<void> {
    if (this.running) { log.info("order_sync_skip_overlap", { cycle: name }); return; }
    this.running = true;
    try { await fn(); }
    catch (err) { log.error("order_sync_cycle_failed", { cycle: name, error: err instanceof Error ? err.message : String(err) }); }
    finally { this.running = false; }
  }
}
