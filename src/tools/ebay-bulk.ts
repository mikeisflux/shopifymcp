/**
 * Cross-service bulk tool: list Shopify products from a collection as eBay
 * auctions, using the proven single-listing recipe (clean image URL, package
 * weight, auction format, Shopify price as the start price) plus the server's
 * baked-in listing defaults (location, business policies, category, condition,
 * duration).
 *
 * Runs entirely server-side, so a whole collection is listed with ONE MCP call
 * rather than hundreds of round-trips. dryRun:true (default) previews the
 * proposed titles/prices without touching eBay.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ShopifyClient } from "../shopify-client.js";
import { EbayClient } from "../ebay-client.js";
import type { Config } from "../config.js";
import { logToolCall } from "../logger.js";
import { textContent } from "../format.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const SOURCE_QUERY = /* GraphQL */ `
  query EbayBulkSource($id: ID!, $first: Int!, $after: String) {
    collection(id: $id) {
      id
      title
      products(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          title
          vendor
          tags
          featuredImage { url }
          variants(first: 1) { nodes { sku price } }
        }
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

function buildTitle(template: string, vars: Record<string, string>): string {
  const filled = template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "").replace(/\s+/g, " ").trim();
  return filled.length > 80 ? filled.slice(0, 80).trim() : filled;
}

/** Strip the CDN query string — eBay's image fetcher fails on Shopify's `?v=…`. */
function cleanImageUrl(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

function toGid(numericOrGid: string): string {
  return numericOrGid.startsWith("gid://") ? numericOrGid : `gid://shopify/Collection/${numericOrGid}`;
}

export function registerEbayBulkTools(server: McpServer, shopify: ShopifyClient, ebay: EbayClient, config: Config): void {
  const d = config.ebayListing;

  server.registerTool(
    "ebay_bulk_list_auctions",
    {
      title: "Bulk-list a Shopify collection as eBay auctions",
      description:
        "For each product in a Shopify collection, create + publish an eBay auction using the Shopify variant price as the auction start price and the product's own image. Applies the proven recipe (clean image URL, package weight, auction format) and the server's baked-in defaults (location, policies, category, condition NEW, 7-day). dryRun:true (default) returns the proposed titles/prices WITHOUT touching eBay — always preview first. Returns every eBay item ID. Idempotent: skips SKUs that already have an eBay offer.",
      inputSchema: {
        collectionId: z.string().describe("Shopify collection (numeric id or GID) to list from, e.g. book-deadsexy-1-ebaylive."),
        seriesLabel: z.string().describe("Human series name used in titles + Series Title aspect, e.g. \"Dead Sexy #1\"."),
        titleTemplate: z.string().default("{series} {descriptor} Variant Cover - {vendor}").describe("Title template; placeholders {series} {descriptor} {code} {vendor} {sku}. Truncated to eBay's 80-char limit."),
        weightLb: z.number().positive().default(0.5).describe("Package weight in pounds for calculated shipping."),
        maxProducts: z.number().int().min(1).max(300).default(50).describe("How many products to process this call. Use a high value for dryRun preview; smaller (≤50) for live runs, then continue with nextCursor."),
        cursor: z.string().optional().describe("Opaque product cursor from a previous call's nextCursor, to continue."),
        skipExisting: z.boolean().default(true).describe("Skip SKUs that already have an eBay offer (safe re-runs)."),
        dryRun: z.boolean().default(true).describe("true (default): preview proposed listings without creating them. false: create + publish live auctions."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    (async (args: {
      collectionId: string; seriesLabel: string; titleTemplate: string; weightLb: number;
      maxProducts: number; cursor?: string; skipExisting: boolean; dryRun: boolean;
    }) => {
      const start = Date.now();
      const listed: Array<{ sku: string; itemId: string; title: string; startPrice: string }> = [];
      const preview: Array<{ sku: string; title: string; startPrice: string; imageUrl: string }> = [];
      const skipped: Array<{ sku: string; reason: string }> = [];
      const failed: Array<{ sku: string; title: string; error: string }> = [];
      let processed = 0;
      let nextCursor: string | null = null;
      let hasMore = false;

      try {
        const res = await shopify.request<{ collection: { title: string; products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: SrcProduct[] } } | null }>(
          SOURCE_QUERY,
          { id: toGid(args.collectionId), first: args.maxProducts, after: args.cursor ?? null },
        );
        const collection = res.data.collection;
        if (!collection) throw new Error(`Collection ${args.collectionId} not found.`);
        const page = collection.products;
        hasMore = page.pageInfo.hasNextPage;
        nextCursor = page.pageInfo.endCursor;

        for (const p of page.nodes) {
          processed++;
          const variant = p.variants.nodes[0];
          const sku = variant?.sku ?? "";
          const price = variant?.price ?? "";
          const { code, descriptor } = parseTitle(p.title);
          const vendor = p.vendor ?? "Divinity Comics";
          const title = buildTitle(args.titleTemplate, { series: args.seriesLabel, descriptor, code, vendor, sku });
          const rawImg = p.featuredImage?.url ?? "";
          const imageUrl = rawImg ? cleanImageUrl(rawImg) : "";

          if (!sku) { skipped.push({ sku: p.title, reason: "no SKU on variant" }); continue; }
          if (!price || Number(price) <= 0) { skipped.push({ sku, reason: `invalid price "${price}"` }); continue; }
          if (!imageUrl) { skipped.push({ sku, reason: "no image" }); continue; }

          if (args.dryRun) { preview.push({ sku, title, startPrice: price, imageUrl }); continue; }

          try {
            if (args.skipExisting) {
              const existing = await ebay.request("GET", "/sell/inventory/v1/offer", { query: { sku } }).catch(() => null);
              const offers = (existing?.data as { offers?: unknown[] } | undefined)?.offers;
              if (offers && offers.length) { skipped.push({ sku, reason: "eBay offer already exists" }); continue; }
            }

            await ebay.request("PUT", `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
              body: {
                product: {
                  title,
                  description: `${title}. Published by ${vendor}. Brand new, unread, ungraded — shipped bagged & boarded.`,
                  imageUrls: [imageUrl],
                  aspects: { "Series Title": [args.seriesLabel], Publisher: [vendor], Type: ["Comic Book"], Language: ["English"] },
                },
                condition: "NEW",
                availability: { shipToLocationAvailability: { quantity: 1 } },
                packageWeightAndSize: {
                  weight: { value: args.weightLb, unit: "POUND" },
                  packageType: "PACKAGE_THICK_ENVELOPE",
                  dimensions: { length: 10, width: 7, height: 1, unit: "INCH" },
                },
              },
            });

            const offerRes = await ebay.request("POST", "/sell/inventory/v1/offer", {
              body: {
                sku,
                marketplaceId: config.ebayMarketplaceId,
                format: "AUCTION",
                categoryId: d.categoryId,
                merchantLocationKey: d.locationKey,
                listingDuration: d.listingDuration,
                listingPolicies: { fulfillmentPolicyId: d.fulfillmentPolicyId, paymentPolicyId: d.paymentPolicyId, returnPolicyId: d.returnPolicyId },
                pricingSummary: { auctionStartPrice: { value: price, currency: "USD" } },
              },
            });
            const offerId = (offerRes.data as { offerId?: string }).offerId;
            if (!offerId) throw new Error("no offerId returned");

            const pub = await ebay.request("POST", `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`, {});
            const itemId = (pub.data as { listingId?: string }).listingId ?? "";
            listed.push({ sku, itemId, title, startPrice: price });
            await sleep(150);
          } catch (err) {
            failed.push({ sku, title, error: err instanceof Error ? err.message : String(err) });
          }
        }

        const summary = {
          collection: collection.title,
          dryRun: args.dryRun,
          processed,
          listedCount: listed.length,
          skippedCount: skipped.length,
          failedCount: failed.length,
          hasMore,
          nextCursor: hasMore ? nextCursor : null,
          itemIds: listed.map((l) => l.itemId),
          listed,
          preview,
          skipped,
          failed,
        };
        const head = args.dryRun
          ? `**DRY RUN** — ${preview.length} auction(s) proposed from "${collection.title}" (nothing sent to eBay). Review titles/prices, then re-run with dryRun:false.`
          : `Listed ${listed.length} auction(s) from "${collection.title}"; ${skipped.length} skipped, ${failed.length} failed.${hasMore ? " More remain — continue with nextCursor." : ""}`;
        logToolCall({ tool: "ebay_bulk_list_auctions", durationMs: Date.now() - start, success: true });
        return { content: [textContent(`${head}\n\n\`\`\`json\n${JSON.stringify(summary, null, 2).slice(0, 14000)}\n\`\`\``)], structuredContent: summary };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logToolCall({ tool: "ebay_bulk_list_auctions", durationMs: Date.now() - start, success: false, error: message });
        return { content: [textContent(`Error: ${message}`)], isError: true };
      }
    }) as never,
  );
}
