/**
 * Cross-service bulk lister: turn Shopify products (a whole collection, or an
 * explicit SKU list) into eBay listings in one call, using the proven
 * single-listing recipe (clean image URL, package weight, Shopify price) plus the
 * server's baked-in defaults (location, business policies, category, condition).
 *
 * Two tools share one core, differing only in listing format:
 *   - ebay_bulk_list_auctions      → AUCTION (auction start price, 7-day)
 *   - ebay_bulk_list_fixed_price   → FIXED_PRICE (Buy It Now, GTC)
 *
 * Runs entirely server-side, so a whole collection lists with ONE MCP call rather
 * than hundreds of round-trips. dryRun:true (default) previews without touching eBay.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ShopifyClient } from "../shopify-client.js";
import { EbayClient } from "../ebay-client.js";
import type { Config } from "../config.js";
import { logToolCall } from "../logger.js";
import { textContent } from "../format.js";
import { publishListing, cleanImageUrl } from "./ebay-listing.js";
import { escapeSkuValue } from "./batch-lookups.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const SOURCE_QUERY = /* GraphQL */ `
  query EbayBulkSource($id: ID!, $first: Int!, $after: String) {
    collection(id: $id) {
      id
      title
      products(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id title vendor tags
          featuredImage { url }
          variants(first: 1) { nodes { sku price } }
        }
      }
    }
  }
`;

const SOURCE_BY_SKU = /* GraphQL */ `
  query EbayBulkSourceBySku($query: String!) {
    productVariants(first: 250, query: $query) {
      nodes {
        sku price
        product { id title vendor tags featuredImage { url } }
      }
    }
  }
`;

interface SrcProduct {
  id: string;
  title: string;
  vendor: string | null;
  tags: string[];
  featuredImage: { url: string } | null;
  variants: { nodes: Array<{ sku: string | null; price: string | null }> };
}

/** "DS1-20 Raised Metal-ebaylive" → { code: "DS1-20", descriptor: "Raised Metal" }. */
function parseTitle(raw: string): { code: string; descriptor: string } {
  const base = raw.replace(/-ebaylive\s*$/i, "").trim();
  const m = base.match(/^([A-Za-z0-9]+-[A-Za-z0-9]+)\s+(.*)$/);
  if (m) return { code: m[1]!, descriptor: m[2]!.trim() };
  return { code: "", descriptor: base };
}

function fillTitle(template: string, vars: Record<string, string>): string {
  let filled = template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");
  filled = filled.replace(/\(\s*\)/g, "").replace(/\s*-\s*(\[|$)/, "$1").replace(/\s+/g, " ").trim();
  return filled;
}

/** Fill the template, dropping the artist if needed to keep the SKU tag within eBay's 80-char limit. */
function buildTitle(template: string, vars: Record<string, string>): string {
  let title = fillTitle(template, vars);
  if (title.length > 80 && vars.artist) title = fillTitle(template, { ...vars, artist: "" });
  return title.length > 80 ? title.slice(0, 80).trim() : title;
}

/** Best-effort artist name from tags: a multi-word tag that isn't a system/collection tag. */
function pickArtist(tags: string[]): string {
  return tags.find((t) => /\s/.test(t) && !/-books$/i.test(t) && !/-ebaylive$/i.test(t) && t.toLowerCase() !== "ebaylive") ?? "";
}

function toGid(numericOrGid: string): string {
  return numericOrGid.startsWith("gid://") ? numericOrGid : `gid://shopify/Collection/${numericOrGid}`;
}

interface BulkArgs {
  format: "AUCTION" | "FIXED_PRICE";
  collectionId?: string;
  skus?: string[];
  seriesLabel: string;
  titleTemplate: string;
  weightLb: number;
  maxProducts: number;
  cursor?: string;
  skipExisting: boolean;
  requireHostedImage: boolean;
  dryRun: boolean;
  price?: number;
  quantity?: number;
}

/** Load the source products for this run — a collection page, or an explicit SKU set. */
async function loadSources(shopify: ShopifyClient, args: BulkArgs): Promise<{ title: string; nodes: SrcProduct[]; hasMore: boolean; nextCursor: string | null }> {
  if (args.skus?.length) {
    const unique = [...new Set(args.skus.filter(Boolean))];
    const nodes: SrcProduct[] = [];
    const CHUNK = 40;
    for (let i = 0; i < unique.length; i += CHUNK) {
      const query = unique.slice(i, i + CHUNK).map((s) => `sku:"${escapeSkuValue(s)}"`).join(" OR ");
      const res = await shopify.request<{ productVariants: { nodes: Array<{ sku: string | null; price: string | null; product: { id: string; title: string; vendor: string | null; tags: string[]; featuredImage: { url: string } | null } | null }> } }>(SOURCE_BY_SKU, { query });
      for (const v of res.data.productVariants.nodes) {
        if (!v.product) continue;
        nodes.push({ id: v.product.id, title: v.product.title, vendor: v.product.vendor, tags: v.product.tags, featuredImage: v.product.featuredImage, variants: { nodes: [{ sku: v.sku, price: v.price }] } });
      }
    }
    return { title: `${nodes.length} SKU(s)`, nodes, hasMore: false, nextCursor: null };
  }
  const res = await shopify.request<{ collection: { title: string; products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: SrcProduct[] } } | null }>(
    SOURCE_QUERY,
    { id: toGid(args.collectionId!), first: args.maxProducts, after: args.cursor ?? null },
  );
  if (!res.data.collection) throw new Error(`Collection ${args.collectionId} not found.`);
  const page = res.data.collection.products;
  return { title: res.data.collection.title, nodes: page.nodes, hasMore: page.pageInfo.hasNextPage, nextCursor: page.pageInfo.endCursor };
}

/** Shared bulk-list core for both auction and fixed-price siblings. */
async function runBulkList(shopify: ShopifyClient, ebay: EbayClient, config: Config, args: BulkArgs): Promise<Record<string, unknown>> {
  const noun = args.format === "AUCTION" ? "auction" : "fixed-price listing";
  const listed: Array<{ sku: string; itemId: string; title: string; price: string; imageHosted: boolean }> = [];
  const preview: Array<{ sku: string; title: string; price: string; imageUrl: string }> = [];
  const skipped: Array<{ sku: string; reason: string }> = [];
  const failed: Array<{ sku: string; title: string; error: string }> = [];
  const warningCounts = new Map<string, number>();
  let processed = 0;

  const src = await loadSources(shopify, args);

  for (const p of src.nodes) {
    processed++;
    const variant = p.variants.nodes[0];
    const sku = variant?.sku ?? "";
    const price = args.price != null ? args.price.toFixed(2) : (variant?.price ?? "");
    const { code, descriptor } = parseTitle(p.title);
    const vendor = p.vendor ?? "Divinity Comics";
    const artist = pickArtist(p.tags);
    const skucode = sku.replace(/-ebaylive$/i, "");
    const title = buildTitle(args.titleTemplate, { series: args.seriesLabel, descriptor, code, vendor, sku, skucode, artist });
    const rawImg = p.featuredImage?.url ?? "";
    const imageUrl = rawImg ? cleanImageUrl(rawImg) : "";

    if (!sku) { skipped.push({ sku: p.title, reason: "no SKU on variant" }); continue; }
    if (!price || Number(price) <= 0) { skipped.push({ sku, reason: `invalid price "${price}"` }); continue; }
    if (!imageUrl) { skipped.push({ sku, reason: "no image" }); continue; }

    if (args.dryRun) { preview.push({ sku, title, price, imageUrl }); continue; }

    try {
      if (args.skipExisting) {
        const existing = await ebay.request("GET", "/sell/inventory/v1/offer", { query: { sku } }).catch(() => null);
        const offers = (existing?.data as { offers?: Array<{ status?: string; listing?: { listingId?: string } }> } | undefined)?.offers;
        if (offers && offers.length) {
          const live = offers.find((o) => o.status === "PUBLISHED" || o.listing?.listingId);
          skipped.push({ sku, reason: live ? `already published (item ${live.listing?.listingId ?? "?"})` : "offer already exists (unpublished — publish or delete it manually)" });
          continue;
        }
      }

      const pub = await publishListing(ebay, config, { sku, title, price, imageUrl, seriesLabel: args.seriesLabel, vendor, weightLb: args.weightLb, requireHostedImage: args.requireHostedImage, format: args.format, quantity: args.quantity });
      // Summarize warnings once (e.g. the monthly listing-value note) rather than per item.
      for (const w of pub.warnings) warningCounts.set(w, (warningCounts.get(w) ?? 0) + 1);
      listed.push({ sku, itemId: pub.itemId, title, price, imageHosted: pub.imageHosted });
      await sleep(150);
    } catch (err) {
      failed.push({ sku, title, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Title-collision report: eBay allows duplicate titles, but two items resolving
  // to the same title usually means the template needs {code}.
  const byTitle = new Map<string, string[]>();
  for (const it of args.dryRun ? preview : listed) {
    const arr = byTitle.get(it.title) ?? [];
    arr.push(it.sku);
    byTitle.set(it.title, arr);
  }
  const collisions = [...byTitle.entries()].filter(([, skus]) => skus.length > 1).map(([title, skus]) => ({ title, skus }));
  const warnings = [...warningCounts.entries()].map(([message, count]) => ({ message, count }));

  return {
    format: args.format,
    source: src.title,
    dryRun: args.dryRun,
    processed,
    listedCount: listed.length,
    skippedCount: skipped.length,
    failedCount: failed.length,
    collisionCount: collisions.length,
    hasMore: src.hasMore,
    nextCursor: src.hasMore ? src.nextCursor : null,
    itemIds: listed.map((l) => l.itemId),
    listed,
    preview,
    collisions,
    warnings,
    skipped,
    failed,
    _noun: noun,
  };
}

/** Format the tool result (head line + JSON) from a runBulkList summary. */
function formatResult(summary: Record<string, unknown>) {
  const noun = summary._noun as string;
  delete summary._noun;
  const collisionCount = summary.collisionCount as number;
  const collisionNote = collisionCount ? ` ⚠️ ${collisionCount} title collision(s) — add {code} to titleTemplate.` : "";
  const head = summary.dryRun
    ? `**DRY RUN** — ${(summary.preview as unknown[]).length} ${noun}(s) proposed from "${summary.source}" (nothing sent to eBay).${collisionNote} Review, then re-run with dryRun:false.`
    : `Listed ${summary.listedCount} ${noun}(s) from "${summary.source}"; ${summary.skippedCount} skipped, ${summary.failedCount} failed.${collisionNote}${summary.hasMore ? " More remain — continue with nextCursor." : ""}`;
  return { content: [textContent(`${head}\n\n\`\`\`json\n${JSON.stringify(summary, null, 2).slice(0, 14000)}\n\`\`\``)], structuredContent: summary };
}

export function registerEbayBulkTools(server: McpServer, shopify: ShopifyClient, ebay: EbayClient, config: Config): void {
  const DEFAULT_TEMPLATE = "{series} {descriptor} Variant - {vendor} ({artist}) [{skucode}]";

  server.registerTool(
    "ebay_bulk_list_auctions",
    {
      title: "Bulk-list a Shopify collection as eBay auctions",
      description:
        "For each product in a Shopify collection, create + publish an eBay AUCTION using the Shopify variant price as the auction start price and the product's own image. Applies the proven recipe (clean image URL, package weight, auction format) and the server's baked-in defaults (location, policies, category, condition NEW, 7-day). dryRun:true (default) returns proposed titles/prices WITHOUT touching eBay. Returns every eBay item ID. Idempotent: skips SKUs that already have an eBay offer. (For Buy It Now, use ebay_bulk_list_fixed_price.)",
      inputSchema: {
        collectionId: z.string().describe("Shopify collection (numeric id or GID) to list from, e.g. book-deadsexy-1-ebaylive."),
        seriesLabel: z.string().describe("Human series name used in titles + Series Title aspect, e.g. \"Dead Sexy #1\"."),
        titleTemplate: z.string().default(DEFAULT_TEMPLATE).describe("Title template; placeholders {series} {descriptor} {code} {vendor} {sku} {skucode}(=sku without -ebaylive) {artist}. Empty ()/dangling - cleaned; artist auto-dropped if the title would exceed eBay's 80-char limit so the SKU tag survives."),
        weightLb: z.number().positive().default(0.5).describe("Package weight in pounds for calculated shipping."),
        maxProducts: z.number().int().min(1).max(250).default(50).describe("How many products to process this call (Shopify caps page size at 250). Use 250 for dryRun preview; smaller (≤50) for live runs, then continue with nextCursor."),
        cursor: z.string().optional().describe("Opaque product cursor from a previous call's nextCursor, to continue."),
        skipExisting: z.boolean().default(true).describe("Skip SKUs that already have an eBay offer (safe re-runs / no duplicates)."),
        requireHostedImage: z.boolean().default(true).describe("If eBay image hosting fails, skip the item instead of publishing a listing whose image won't show on eBay Live."),
        dryRun: z.boolean().default(true).describe("true (default): preview proposed listings without creating them. false: create + publish live auctions."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    (async (args: { collectionId: string; seriesLabel: string; titleTemplate: string; weightLb: number; maxProducts: number; cursor?: string; skipExisting: boolean; requireHostedImage: boolean; dryRun: boolean }) => {
      const start = Date.now();
      try {
        const summary = await runBulkList(shopify, ebay, config, { ...args, format: "AUCTION" });
        logToolCall({ tool: "ebay_bulk_list_auctions", durationMs: Date.now() - start, success: true });
        return formatResult(summary);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logToolCall({ tool: "ebay_bulk_list_auctions", durationMs: Date.now() - start, success: false, error: message });
        return { content: [textContent(`Error: ${message}`)], isError: true };
      }
    }) as never,
  );

  server.registerTool(
    "ebay_bulk_list_fixed_price",
    {
      title: "Bulk-list Shopify products as eBay Buy It Now",
      description:
        "Same as ebay_bulk_list_auctions but publishes FIXED_PRICE (Buy It Now, Good 'Til Cancelled) listings. Provide a collectionId OR an explicit skus list. Uses each SKU's Shopify price unless `price` overrides it for the whole run. eBay forces GTC for fixed price, so no listing duration is sent. dryRun:true (default) previews without touching eBay. Idempotent: skips SKUs that already have an eBay offer. Repetitive per-item warnings (e.g. the monthly listing-value note) are summarized once in `warnings`.",
      inputSchema: {
        collectionId: z.string().optional().describe("Shopify collection (numeric id or GID) to list from. Provide this OR skus."),
        skus: z.array(z.string()).optional().describe("Explicit SKUs to list (instead of a whole collection) — handy for a small set like a 6-card trading-card series. Provide this OR collectionId."),
        seriesLabel: z.string().describe("Human series name used in titles + Series Title aspect, e.g. \"Granger #1\"."),
        price: z.number().positive().optional().describe("Override price for every item this run. If omitted, each SKU's Shopify catalog price is used."),
        quantity: z.number().int().min(1).default(1).describe("Available quantity per fixed-price listing."),
        titleTemplate: z.string().default(DEFAULT_TEMPLATE).describe("Title template; placeholders {series} {descriptor} {code} {vendor} {sku} {skucode} {artist}. Same rules as the auction tool."),
        weightLb: z.number().positive().default(0.5).describe("Package weight in pounds for calculated shipping."),
        maxProducts: z.number().int().min(1).max(250).default(50).describe("Products per call for the collection path (ignored when skus is given). Continue with nextCursor."),
        cursor: z.string().optional().describe("Opaque product cursor from a previous call's nextCursor, to continue (collection path)."),
        skipExisting: z.boolean().default(true).describe("Skip SKUs that already have an eBay offer (safe re-runs / no duplicates)."),
        requireHostedImage: z.boolean().default(true).describe("If eBay image hosting fails, skip the item instead of publishing a listing whose image won't show on eBay Live."),
        dryRun: z.boolean().default(true).describe("true (default): preview proposed listings without creating them. false: create + publish live listings."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    (async (args: { collectionId?: string; skus?: string[]; seriesLabel: string; price?: number; quantity: number; titleTemplate: string; weightLb: number; maxProducts: number; cursor?: string; skipExisting: boolean; requireHostedImage: boolean; dryRun: boolean }) => {
      const start = Date.now();
      try {
        if (args.skus?.length && args.collectionId) throw new Error("Provide collectionId OR skus, not both.");
        if (!args.skus?.length && !args.collectionId) throw new Error("Provide either collectionId or skus.");
        const summary = await runBulkList(shopify, ebay, config, { ...args, format: "FIXED_PRICE" });
        logToolCall({ tool: "ebay_bulk_list_fixed_price", durationMs: Date.now() - start, success: true });
        return formatResult(summary);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logToolCall({ tool: "ebay_bulk_list_fixed_price", durationMs: Date.now() - start, success: false, error: message });
        return { content: [textContent(`Error: ${message}`)], isError: true };
      }
    }) as never,
  );
}
