/**
 * Automated auction engine (Phases 1–4).
 *
 *  listBatch()        — Phase 1/2: find collections matching the "ebay live" title,
 *                       pick top-performing SKUs that aren't currently live, and
 *                       publish a batch of auctions at the adaptive per-cover-type floor.
 *  ingestSales()      — Phase 2/3: pull sold orders from eBay, mark auctions sold,
 *                       and reap closed auctions into history.
 *  reviewAndAdapt()   — Phase 3/4: recompute per-cover-type performance, adapt the
 *                       floors within hard bounds, and (optionally) run an LLM review.
 *  report()           — performance snapshot + current floors + recommendations.
 *
 * Runs entirely on the server; no Claude chat required.
 */

import type { Config } from "./config.js";
import type { ShopifyClient } from "./shopify-client.js";
import type { EbayClient } from "./ebay-client.js";
import { AuctionStore, type ActiveAuction, type ClosedAuction } from "./auction-store.js";
import { buildPopularity, type Popularity } from "./popularity.js";
import { log } from "./logger.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Cover-type code from a SKU, e.g. "DS1-15RM-ebaylive" -> "RM"; base "DS1-15" -> "REG". */
export function coverTypeOf(sku: string): string {
  const s = sku.replace(/-ebaylive$/i, "");
  const m = s.match(/^[A-Za-z]+\d*-\d+([A-Za-z]+)?$/);
  const suffix = (m?.[1] ?? "").toUpperCase();
  return suffix || "REG";
}
const COVER_LABEL: Record<string, string> = { RM: "Raised Metal", GITD: "Glow in the Dark", M: "Metal", F: "Foil", REG: "Regular" };
export const coverLabel = (t: string): string => COVER_LABEL[t] ?? t;

/**
 * Cover stem for popularity grouping: strip the -ebaylive suffix and any trailing
 * cover-type letters so a cover's variants + its store twin share one key, e.g.
 * "G1-07M-ebaylive" / "G1-07F" / "G1-07" all → "G1-07". Letter-only SKUs pass through.
 */
export function coverStem(sku: string): string {
  const s = sku.replace(/-ebaylive$/i, "");
  const m = s.match(/^(.*\d)[A-Za-z]*$/);
  return (m?.[1] ?? s).toUpperCase();
}

/**
 * Human series name for a product. Prefers a product tag like "Dead-sexy-1-books"
 * (dashes = real word boundaries + casing) → "Dead Sexy #1"; falls back to the
 * collection slug ("book-deadsexy-1-ebaylive" → "Deadsexy #1"); else "Comic".
 */
export function deriveSeries(tags: string[], collectionTitle: string): string {
  const bookTag = (tags ?? []).find((t) => /-\d+-books$/i.test(t));
  const src = bookTag
    ? bookTag.replace(/-books$/i, "")
    : collectionTitle.replace(/^(books?|prints?)-/i, "").replace(/-ebaylive$/i, "");
  const words: string[] = [];
  let num = "";
  for (const p of src.split("-").filter(Boolean)) {
    if (/^\d+$/.test(p)) num = p;
    else words.push(p.charAt(0).toUpperCase() + p.slice(1));
  }
  const name = words.join(" ").trim();
  return name ? (num ? `${name} #${num}` : name) : "Comic";
}

const cleanImage = (url: string): string => { const q = url.indexOf("?"); return q === -1 ? url : url.slice(0, q); };
const stripSuffix = (sku: string): string => sku.replace(/-ebaylive$/i, "");

const COLLECTIONS_Q = /* GraphQL */ `
  query AuctionCollections($first: Int!, $after: String) {
    collections(first: $first, after: $after, query: "collection_type:smart OR collection_type:custom") {
      pageInfo { hasNextPage endCursor }
      nodes { id title }
    }
  }`;
const PRODUCTS_Q = /* GraphQL */ `
  query AuctionProducts($id: ID!, $first: Int!, $after: String) {
    collection(id: $id) {
      products(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { title vendor tags featuredImage { url } variants(first: 1) { nodes { sku price } } }
      }
    }
  }`;

interface Candidate { sku: string; title: string; series: string; vendor: string; artist: string; imageUrl: string; coverType: string; }

/** Shape of an eBay offer as returned by GET /sell/inventory/v1/offer?sku=. */
interface RawOffer {
  offerId?: string;
  format?: string;
  pricingSummary?: { auctionStartPrice?: { value?: string } };
  listing?: { listingId?: string; listingStatus?: string };
}

export class AuctionEngine {
  constructor(
    private readonly config: Config,
    private readonly shopify: ShopifyClient,
    private readonly ebay: EbayClient,
    readonly store: AuctionStore,
  ) {
    store.seedFloors(config.auction.initialFloors);
  }

  /** Cached blended popularity (cover stem -> 0..1), refreshed on the review cycle. */
  private popularity: Popularity | null = null;

  private nowMs(): number { return Date.now(); }

  /** Rebuild the blended store-sales + auction-results popularity model. */
  async refreshPopularity(): Promise<void> {
    try {
      this.popularity = await buildPopularity(this.shopify, this.store, coverStem);
    } catch (err) {
      log.warn("auction_popularity_failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Per-cover-type performance from closed history. */
  performance(): Record<string, { listed: number; sold: number; sellThrough: number; avgSold: number; score: number }> {
    const byType: Record<string, { listed: number; sold: number; sum: number }> = {};
    for (const h of this.store.get().history) {
      const t = h.coverType;
      byType[t] ??= { listed: 0, sold: 0, sum: 0 };
      byType[t].listed++;
      if (h.sold && h.soldPrice != null) { byType[t].sold++; byType[t].sum += h.soldPrice; }
    }
    const out: Record<string, { listed: number; sold: number; sellThrough: number; avgSold: number; score: number }> = {};
    for (const [t, s] of Object.entries(byType)) {
      const sellThrough = s.listed ? s.sold / s.listed : 0;
      const avgSold = s.sold ? s.sum / s.sold : 0;
      out[t] = { listed: s.listed, sold: s.sold, sellThrough, avgSold, score: sellThrough * avgSold };
    }
    return out;
  }

  private async matchingCollections(): Promise<Array<{ id: string; title: string }>> {
    const match = this.config.auction.collectionMatch;
    const out: Array<{ id: string; title: string }> = [];
    // Paginate ALL collections — the store has 300+, and the *-ebaylive ones have
    // the highest ids, so a single first:250 page silently drops most of them.
    let after: string | null = null;
    for (let page = 0; page < 40; page++) {
      const res: { data: { collections: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<{ id: string; title: string }> } } } =
        await this.shopify.request(COLLECTIONS_Q, { first: 250, after });
      const c = res.data.collections;
      for (const n of c.nodes) if (n.title.toLowerCase().includes(match)) out.push(n);
      if (!c.pageInfo.hasNextPage) break;
      after = c.pageInfo.endCursor;
    }
    return out;
  }

  private async gatherCandidates(): Promise<Candidate[]> {
    const cols = await this.matchingCollections();
    const out: Candidate[] = [];
    const seen = new Set<string>();
    for (const col of cols) {
      let after: string | null = null;
      // Cap paging per collection to keep a cycle bounded (80 × 100 = 8000, enough
      // for the ~4,716-item master collection; dedup across collections is cheap).
      for (let page = 0; page < 80; page++) {
        const r: { data: { collection: { products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<{ title: string; vendor: string | null; tags: string[]; featuredImage: { url: string } | null; variants: { nodes: Array<{ sku: string | null; price: string | null }> } }> } } | null } } =
          await this.shopify.request(PRODUCTS_Q, { id: col.id, first: 100, after });
        const pc = r.data.collection;
        if (!pc) break;
        for (const p of pc.products.nodes) {
          const v = p.variants.nodes[0];
          const sku = v?.sku ?? "";
          const img = p.featuredImage?.url ?? "";
          if (!sku || !img || seen.has(sku)) continue;
          seen.add(sku);
          const artist = (p.tags ?? []).find((t) => /\s/.test(t) && !/-books$/i.test(t) && t.toLowerCase() !== "ebaylive") ?? "";
          out.push({ sku, title: p.title, series: deriveSeries(p.tags ?? [], col.title), vendor: p.vendor ?? "Divinity Comics", artist, imageUrl: cleanImage(img), coverType: coverTypeOf(sku) });
        }
        if (!pc.products.pageInfo.hasNextPage) break;
        after = pc.products.pageInfo.endCursor;
      }
    }
    return out;
  }

  private buildTitle(c: Candidate): string {
    const s = stripSuffix(c.sku);
    const base = `${c.series} ${coverLabel(c.coverType)} Variant - ${c.vendor}`;
    const withArtist = c.artist ? `${base} (${c.artist}) [${s}]` : `${base} [${s}]`;
    if (withArtist.length <= 80) return withArtist;
    const noArtist = `${base} [${s}]`;
    return noArtist.length <= 80 ? noArtist : noArtist.slice(0, 80).trim();
  }

  /** Publish a single auction at the given start price. Returns {itemId, offerId}. */
  private async publishOne(c: Candidate, startPrice: number): Promise<{ itemId: string; offerId: string }> {
    const seriesLabel = c.series;
    const title = this.buildTitle(c);
    const d = this.config.ebayListing;
    let image = c.imageUrl;
    try { image = await this.ebay.uploadHostedPicture(c.imageUrl, c.sku); } catch { /* fall back to raw */ }

    await this.ebay.request("PUT", `/sell/inventory/v1/inventory_item/${encodeURIComponent(c.sku)}`, {
      body: {
        product: { title, description: `${title}. Published by ${c.vendor}. Brand new, unread, ungraded — shipped bagged & boarded.`, imageUrls: [image], aspects: { "Series Title": [seriesLabel], Publisher: [c.vendor], Type: ["Comic Book"], Language: ["English"] } },
        condition: "NEW",
        availability: { shipToLocationAvailability: { quantity: 1 } },
        packageWeightAndSize: { weight: { value: 0.5, unit: "POUND" }, packageType: "PACKAGE_THICK_ENVELOPE", dimensions: { length: 10, width: 7, height: 1, unit: "INCH" } },
      },
    });
    const offerRes = await this.ebay.request("POST", "/sell/inventory/v1/offer", {
      body: {
        sku: c.sku, marketplaceId: this.config.ebayMarketplaceId, format: "AUCTION", categoryId: d.categoryId,
        merchantLocationKey: d.locationKey, listingDuration: `DAYS_${this.config.auction.durationDays}`,
        listingPolicies: { fulfillmentPolicyId: d.fulfillmentPolicyId, paymentPolicyId: d.paymentPolicyId, returnPolicyId: d.returnPolicyId },
        pricingSummary: { auctionStartPrice: { value: startPrice.toFixed(2), currency: "USD" } },
      },
    });
    const offerId = (offerRes.data as { offerId?: string }).offerId;
    if (!offerId) throw new Error("no offerId");
    const pub = await this.ebay.request("POST", `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`, {});
    return { itemId: (pub.data as { listingId?: string }).listingId ?? "", offerId };
  }

  /**
   * Turn an existing eBay offer (from GET /offer?sku=) into an ActiveAuction we
   * can track. Only live AUCTION offers are adopted. eBay's offer payload carries
   * no start/end timestamps, so the window is approximated as now + durationDays;
   * a sale still closes it immediately on the next ingest (the sale match is
   * time-independent), and an unsold one reaps when the approximate window ends.
   */
  private offerToActive(sku: string, offer: RawOffer, now: number): ActiveAuction | null {
    if (offer.format && offer.format !== "AUCTION") return null;
    const status = offer.listing?.listingStatus;
    if (status && status !== "ACTIVE") return null;
    const offerId = offer.offerId ?? "";
    if (!offerId) return null;
    const coverType = coverTypeOf(sku);
    const startPrice = Number(offer.pricingSummary?.auctionStartPrice?.value) || this.store.floor(coverType, this.config.auction.initialFloors[coverType] ?? 5);
    return { sku, itemId: offer.listing?.listingId ?? "", offerId, coverType, startPrice, listedAtMs: now, endsAtMs: now + this.config.auction.durationDays * DAY_MS };
  }

  /** Phase 1/2: list a batch, best performers first, skipping SKUs already live. */
  async listBatch(limit = this.config.auction.batchSize, dryRun = false): Promise<{ listed: Array<{ sku: string; itemId: string; startPrice: number }>; adopted: number; relisted: number; skippedActive: number; skippedExistingOffer: number; failed: Array<{ sku: string; error: string }>; candidates: number }> {
    const now = this.nowMs();
    const perf = this.performance();
    const all = await this.gatherCandidates();
    // Smart order: proven money-makers first (blended store + auction popularity),
    // with per-cover-type performance as the tie-breaker. Build it on the first
    // run so even the initial cycle is ordered, not just later ones.
    if (!this.popularity && !dryRun) await this.refreshPopularity();
    const pop = this.popularity?.byStem ?? {};
    const candidates = all
      .filter((c) => !this.store.isActive(c.sku, now))
      .sort((a, b) =>
        ((pop[coverStem(b.sku)] ?? 0) - (pop[coverStem(a.sku)] ?? 0)) ||
        ((perf[b.coverType]?.score ?? 0) - (perf[a.coverType]?.score ?? 0)));
    const skippedActive = all.length - candidates.length;

    const listed: Array<{ sku: string; itemId: string; startPrice: number }> = [];
    const failed: Array<{ sku: string; error: string }> = [];
    let adopted = 0;
    let relisted = 0;
    let skippedExistingOffer = 0;
    for (const c of candidates.slice(0, limit)) {
      const startPrice = this.store.floor(c.coverType, this.config.auction.initialFloors[c.coverType] ?? 5);
      if (dryRun) { listed.push({ sku: c.sku, itemId: "(dry-run)", startPrice }); continue; }
      try {
        // Check eBay for an existing offer on this SKU.
        const existing = await this.ebay.request("GET", "/sell/inventory/v1/offer", { query: { sku: c.sku } }).catch(() => null);
        const off = (existing?.data as { offers?: RawOffer[] } | undefined)?.offers?.[0];
        if (off) {
          const isAuction = !off.format || off.format === "AUCTION";
          // Already a LIVE auction? Adopt it so we track it; don't republish.
          if (off.listing?.listingStatus === "ACTIVE") {
            skippedExistingOffer++;
            if (!this.store.get().active[c.sku]) {
              const a = this.offerToActive(c.sku, off, now);
              if (a) { this.store.addActive(a); adopted++; }
            }
            continue;
          }
          // Offer exists but isn't live (unpublished / ended) — PUBLISH it. The
          // offer is already built, so one call lists it. This is the backlog the
          // engine used to skip (seeing "an offer exists" and assuming it was live).
          if (isAuction && off.offerId) {
            // Unpublished offers often sit at shipToLocationAvailability quantity 0,
            // which eBay rejects for auctions (25760). Ensure stock before publishing.
            await this.ebay.request("POST", "/sell/inventory/v1/bulk_update_price_quantity", {
              body: { requests: [{ sku: c.sku, shipToLocationAvailability: { quantity: 1 } }] },
            }).catch(() => null);
            const pub = await this.ebay.request("POST", `/sell/inventory/v1/offer/${encodeURIComponent(off.offerId)}/publish`, {});
            const itemId = (pub.data as { listingId?: string }).listingId ?? off.listing?.listingId ?? "";
            const price = Number(off.pricingSummary?.auctionStartPrice?.value) || startPrice;
            this.store.addActive({ sku: c.sku, itemId, offerId: off.offerId, coverType: c.coverType, startPrice: price, listedAtMs: now, endsAtMs: now + this.config.auction.durationDays * DAY_MS });
            listed.push({ sku: c.sku, itemId, startPrice: price });
            relisted++;
            await sleep(150);
            continue;
          }
          // Non-auction offer — leave it.
          skippedExistingOffer++;
          continue;
        }
        const { itemId, offerId } = await this.publishOne(c, startPrice);
        this.store.addActive({ sku: c.sku, itemId, offerId, coverType: c.coverType, startPrice, listedAtMs: now, endsAtMs: now + this.config.auction.durationDays * DAY_MS });
        listed.push({ sku: c.sku, itemId, startPrice });
        await sleep(150);
      } catch (err) {
        failed.push({ sku: c.sku, error: err instanceof Error ? err.message : String(err) });
      }
    }
    this.store.setMeta({ lastListAtMs: now });
    log.info("auction_list_batch", { listed: listed.length, relisted, adopted, skippedExistingOffer, skippedActive, failed: failed.length, candidates: candidates.length });
    return { listed, adopted, relisted, skippedActive, skippedExistingOffer, failed, candidates: candidates.length };
  }

  /**
   * Backfill: scan every candidate in the ebaylive collections and adopt any that
   * already have a live eBay auction into the store, so performance + sales ingest
   * start working against listings created outside the engine (manual, bulk tool,
   * or a prior run whose state was lost to the /data permission bug). Bounded,
   * paced, and idempotent — SKUs already tracked are skipped without an API call.
   */
  async adoptExisting(maxScan = 2000): Promise<{ scanned: number; adopted: number; alreadyActive: number; noLiveOffer: number; failed: number }> {
    const now = this.nowMs();
    const candidates = await this.gatherCandidates();
    let scanned = 0, adopted = 0, alreadyActive = 0, noLiveOffer = 0, failed = 0;
    for (const c of candidates.slice(0, maxScan)) {
      scanned++;
      if (this.store.get().active[c.sku]) { alreadyActive++; continue; }
      try {
        const res = await this.ebay.request("GET", "/sell/inventory/v1/offer", { query: { sku: c.sku } }).catch(() => null);
        const offers = (res?.data as { offers?: RawOffer[] } | undefined)?.offers ?? [];
        const a = offers.length ? this.offerToActive(c.sku, offers[0]!, now) : null;
        if (a) { this.store.addActive(a); adopted++; } else noLiveOffer++;
        await sleep(80);
      } catch { failed++; }
    }
    log.info("auction_adopt_existing", { scanned, adopted, alreadyActive, noLiveOffer, failed });
    return { scanned, adopted, alreadyActive, noLiveOffer, failed };
  }

  /** Phase 2/3: pull recent sold orders, mark sold, reap closed auctions. */
  async ingestSales(sinceDays = 30): Promise<{ soldMatched: number; closed: ClosedAuction[] }> {
    const now = this.nowMs();
    const since = new Date(now - sinceDays * DAY_MS).toISOString();
    const soldBySku = new Map<string, number>();
    let offset = 0;
    for (let page = 0; page < 20; page++) {
      const res = await this.ebay.request("GET", "/sell/fulfillment/v1/order", { query: { filter: `creationdate:[${since}..]`, limit: 200, offset } }).catch(() => null);
      const orders = (res?.data as { orders?: Array<{ lineItems?: Array<{ sku?: string; lineItemCost?: { value?: string } }> }>; total?: number } | undefined)?.orders ?? [];
      for (const o of orders) for (const li of o.lineItems ?? []) {
        if (li.sku && li.lineItemCost?.value) soldBySku.set(li.sku, Number(li.lineItemCost.value));
      }
      if (orders.length < 200) break;
      offset += 200;
    }
    let matched = 0;
    for (const sku of soldBySku.keys()) if (this.store.get().active[sku]) matched++;
    const closed = this.store.reapClosed(now, soldBySku);
    this.store.setMeta({ lastIngestAtMs: now });
    log.info("auction_ingest_sales", { soldSkus: soldBySku.size, matched, closed: closed.length });
    return { soldMatched: matched, closed };
  }

  /**
   * Standing check: scan recent orders for line items with NO SKU — manual/lot
   * sales that can't auto-sync to Shopify — and record them so they're not
   * missed. Logs a warning when any are found and stores the findings in meta
   * (surfaced on the /status dashboard).
   */
  async checkNoSkuSales(sinceDays = 1): Promise<{ findings: Array<{ orderId: string; buyer: string | null; title: string; total: string | null }> }> {
    const now = this.nowMs();
    const since = new Date(now - sinceDays * DAY_MS).toISOString();
    const findings: Array<{ orderId: string; buyer: string | null; title: string; total: string | null }> = [];
    let offset = 0;
    for (let page = 0; page < 20; page++) {
      const res = await this.ebay.request("GET", "/sell/fulfillment/v1/order", { query: { filter: `creationdate:[${since}..]`, limit: 200, offset } }).catch(() => null);
      const orders = (res?.data as { orders?: Array<{ orderId?: string; buyer?: { username?: string }; pricingSummary?: { total?: { value?: string } }; lineItems?: Array<{ sku?: string; title?: string }> }> } | undefined)?.orders ?? [];
      for (const o of orders) {
        for (const li of o.lineItems ?? []) {
          if (!li.sku) findings.push({ orderId: o.orderId ?? "", buyer: o.buyer?.username ?? null, title: li.title ?? "(untitled)", total: o.pricingSummary?.total?.value ?? null });
        }
      }
      if (orders.length < 200) break;
      offset += 200;
    }
    this.store.setMeta({ lastNoSkuCheckAtMs: now, noSkuFindings: findings });
    if (findings.length) log.warn("auction_nosku_sales_found", { count: findings.length, orders: [...new Set(findings.map((f) => f.orderId))] });
    else log.info("auction_nosku_check_clear");
    return { findings };
  }

  /** Phase 3: adapt floors from performance; Phase 4: optional LLM review. */
  async reviewAndAdapt(apply = this.config.auction.autoApplyFloors): Promise<{ changes: Array<{ coverType: string; from: number; to: number; reason: string }>; review: string | null }> {
    const now = this.nowMs();
    // Refresh the blended popularity model so the next list cycle orders by it.
    await this.refreshPopularity();
    const perf = this.performance();
    const a = this.config.auction;
    const changes: Array<{ coverType: string; from: number; to: number; reason: string }> = [];
    for (const [t, p] of Object.entries(perf)) {
      if (p.listed < 5) continue; // need signal
      const cur = this.store.floor(t, a.initialFloors[t] ?? 5);
      const hardMin = a.hardMinFloors[t] ?? 1;
      let next = cur;
      let reason = "hold";
      if (p.sellThrough >= 0.8 && p.avgSold > cur * 1.5) { next = Math.min(a.hardMaxFloor, Math.max(cur * 1.1, p.avgSold * 0.6)); reason = `strong: ${(p.sellThrough * 100).toFixed(0)}% sell-through, avg $${p.avgSold.toFixed(2)}`; }
      else if (p.sellThrough < 0.3) { next = Math.max(hardMin, cur * 0.9); reason = `weak: ${(p.sellThrough * 100).toFixed(0)}% sell-through`; }
      next = Math.round(next * 100) / 100;
      if (Math.abs(next - cur) >= 0.5) {
        changes.push({ coverType: t, from: cur, to: next, reason });
        if (apply) this.store.setFloor(t, next);
      }
    }
    let review: string | null = null;
    if (a.anthropicApiKey) { review = await this.llmReview(perf, changes).catch((e) => `LLM review failed: ${e instanceof Error ? e.message : String(e)}`); }
    this.store.setMeta({ lastReviewAtMs: now, lastReview: review });
    log.info("auction_review", { changes: changes.length, applied: apply, llm: Boolean(review) });
    return { changes, review };
  }

  /** Phase 4: narrative strategy review via the Anthropic API (optional). */
  private async llmReview(perf: Record<string, { listed: number; sold: number; sellThrough: number; avgSold: number; score: number }>, changes: Array<{ coverType: string; from: number; to: number; reason: string }>): Promise<string> {
    const body = {
      model: "claude-sonnet-5",
      max_tokens: 700,
      messages: [{ role: "user", content: `You are the pricing strategist for an automated eBay comic-auction system. Per cover-type performance (closed auctions):\n${JSON.stringify(perf, null, 2)}\nCurrent floors: ${JSON.stringify(this.store.get().floors)}\nProposed floor changes this cycle: ${JSON.stringify(changes)}\n\nIn 5 concise bullets: what's selling best, what's underperforming, whether the proposed floor moves look right, and one concrete experiment to try next. Be specific and numeric.` }],
    };
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.config.auction.anthropicApiKey!, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { content?: Array<{ text?: string }>; error?: { message?: string } };
    if (json.error) throw new Error(json.error.message ?? "anthropic error");
    return (json.content ?? []).map((b) => b.text ?? "").join("\n").trim();
  }

  report() {
    const s = this.store.get();
    return {
      enabled: this.config.auction.enabled,
      activeCount: Object.keys(s.active).length,
      historyCount: s.history.length,
      floors: s.floors,
      performance: this.performance(),
      lastListAt: s.meta.lastListAtMs ? new Date(s.meta.lastListAtMs).toISOString() : null,
      lastIngestAt: s.meta.lastIngestAtMs ? new Date(s.meta.lastIngestAtMs).toISOString() : null,
      lastReviewAt: s.meta.lastReviewAtMs ? new Date(s.meta.lastReviewAtMs).toISOString() : null,
      lastReview: s.meta.lastReview,
      popularity: this.popularity
        ? {
            builtAt: new Date(this.popularity.builtAtMs).toISOString(),
            auctionWeight: this.popularity.auctionWeight,
            auctionSales: this.popularity.auctionSales,
            storeRevenue: Math.round(this.popularity.storeRevenue),
            coversRanked: Object.keys(this.popularity.byStem).length,
            topCovers: this.popularity.topStems,
          }
        : null,
    };
  }
}
