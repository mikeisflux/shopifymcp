/**
 * Persistent state for the automated auction engine. JSON-file backed (atomic
 * writes) so it survives container restarts — mount a docker volume at
 * config.auction.stateDir. Single Node process, so in-memory + write-through is
 * safe without locking.
 *
 * Tracks:
 *  - active[sku]  : the auction currently live for a SKU (dedup / no double-listing)
 *  - history[]    : every closed auction (sold or not) for performance analysis
 *  - floors{}     : the current (adapting) start-price floor per cover type
 *  - meta         : last-run timestamps + the latest strategy review
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { log } from "./logger.js";

export interface ActiveAuction {
  sku: string;
  itemId: string;
  offerId: string;
  coverType: string;
  startPrice: number;
  listedAtMs: number;
  endsAtMs: number;
}

export interface ClosedAuction extends ActiveAuction {
  sold: boolean;
  soldPrice: number | null;
  closedAtMs: number;
}

export interface AuctionState {
  active: Record<string, ActiveAuction>;
  history: ClosedAuction[];
  floors: Record<string, number>;
  meta: {
    lastListAtMs: number;
    lastIngestAtMs: number;
    lastReviewAtMs: number;
    lastReview: string | null;
    seededFloors: boolean;
    lastNoSkuCheckAtMs?: number;
    noSkuFindings?: Array<{ orderId: string; buyer: string | null; title: string; total: string | null }>;
  };
}

const EMPTY: AuctionState = {
  active: {},
  history: [],
  floors: {},
  meta: { lastListAtMs: 0, lastIngestAtMs: 0, lastReviewAtMs: 0, lastReview: null, seededFloors: false },
};

export class AuctionStore {
  private readonly file: string;
  private state: AuctionState;

  constructor(stateDir: string) {
    try { mkdirSync(stateDir, { recursive: true }); } catch { /* may already exist */ }
    this.file = join(stateDir, "auction-state.json");
    this.state = this.load();
  }

  private load(): AuctionState {
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<AuctionState>;
        return {
          active: parsed.active ?? {},
          history: parsed.history ?? [],
          floors: parsed.floors ?? {},
          meta: { ...EMPTY.meta, ...(parsed.meta ?? {}) },
        };
      }
    } catch (err) {
      log.error("auction_state_load_failed", { error: err instanceof Error ? err.message : String(err) });
    }
    return structuredClone(EMPTY);
  }

  private save(): void {
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state));
      renameSync(tmp, this.file); // atomic replace
    } catch (err) {
      log.error("auction_state_save_failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  get(): AuctionState { return this.state; }

  /** Seed floors from config the first time only (afterwards they adapt and persist). */
  seedFloors(initial: Record<string, number>): void {
    if (this.state.meta.seededFloors) return;
    this.state.floors = { ...initial, ...this.state.floors };
    this.state.meta.seededFloors = true;
    this.save();
  }

  floor(coverType: string, fallback: number): number {
    return this.state.floors[coverType] ?? fallback;
  }
  setFloor(coverType: string, value: number): void {
    this.state.floors[coverType] = value;
    this.save();
  }

  /** Is a SKU currently live (unexpired active auction)? */
  isActive(sku: string, nowMs: number): boolean {
    const a = this.state.active[sku];
    return !!a && a.endsAtMs > nowMs;
  }

  addActive(a: ActiveAuction): void {
    this.state.active[a.sku] = a;
    this.save();
  }

  /**
   * Move auctions whose window has closed into history. Sold info comes from
   * ingestSales (which calls markSold before this runs). Returns the newly closed.
   */
  reapClosed(nowMs: number, soldBySku: Map<string, number>): ClosedAuction[] {
    const closed: ClosedAuction[] = [];
    for (const [sku, a] of Object.entries(this.state.active)) {
      const soldPrice = soldBySku.get(sku);
      const ended = a.endsAtMs <= nowMs;
      if (soldPrice !== undefined || ended) {
        const rec: ClosedAuction = {
          ...a,
          sold: soldPrice !== undefined,
          soldPrice: soldPrice ?? null,
          closedAtMs: nowMs,
        };
        this.state.history.push(rec);
        closed.push(rec);
        delete this.state.active[sku];
      }
    }
    if (closed.length) this.save();
    return closed;
  }

  setMeta(patch: Partial<AuctionState["meta"]>): void {
    this.state.meta = { ...this.state.meta, ...patch };
    this.save();
  }
}
