/**
 * Drives the AuctionEngine on timers (Phase 1). Pure setInterval — no cron
 * dependency. Each loop is independent, guarded, and self-logging; a failure in
 * one cycle never stops the schedule. Only starts when config.auction.enabled.
 */

import type { AuctionEngine } from "./auction-engine.js";
import type { AuctionAutomationConfig } from "./config.js";
import { log } from "./logger.js";

export class AuctionScheduler {
  private timers: NodeJS.Timeout[] = [];
  constructor(private readonly engine: AuctionEngine, private readonly cfg: AuctionAutomationConfig) {}

  start(): void {
    if (!this.cfg.enabled) { log.info("auction_scheduler_disabled"); return; }
    // Adopt listings created outside the engine (manual / bulk / pre-restart) so
    // the store isn't blind to them, then ingest (frees SKUs + updates history),
    // then review, then list.
    this.every(this.cfg.ingestIntervalMin, "adopt", () => this.engine.adoptExisting());
    this.every(this.cfg.ingestIntervalMin, "ingest", () => this.engine.ingestSales());
    this.every(this.cfg.reviewIntervalMin, "review", () => this.engine.reviewAndAdapt());
    this.every(this.cfg.listIntervalMin, "list", () => this.engine.listBatch());
    // Standing daily check: flag sold-but-no-SKU (manual/lot) sales.
    this.every(this.cfg.noSkuCheckIntervalMin, "nosku", () => this.engine.checkNoSkuSales());
    log.info("auction_scheduler_started", {
      adopt_min: this.cfg.ingestIntervalMin, list_min: this.cfg.listIntervalMin, ingest_min: this.cfg.ingestIntervalMin, review_min: this.cfg.reviewIntervalMin, nosku_min: this.cfg.noSkuCheckIntervalMin, batch: this.cfg.batchSize,
    });
  }

  stop(): void { for (const t of this.timers) clearInterval(t); this.timers = []; }

  private every(minutes: number, name: string, fn: () => Promise<unknown>): void {
    const ms = Math.max(1, minutes) * 60 * 1000;
    // Stagger the first run so the cycles don't fire at once on boot; adopt
    // before ingest so freshly-adopted auctions are matchable in the same pass.
    const kickoff = setTimeout(() => {
      void this.run(name, fn);
      this.timers.push(setInterval(() => void this.run(name, fn), ms));
    }, name === "adopt" ? 15_000 : name === "ingest" ? 45_000 : name === "review" ? 90_000 : name === "list" ? 150_000 : 210_000);
    this.timers.push(kickoff);
  }

  private async run(name: string, fn: () => Promise<unknown>): Promise<void> {
    try { await fn(); }
    catch (err) { log.error("auction_cycle_failed", { cycle: name, error: err instanceof Error ? err.message : String(err) }); }
  }
}
