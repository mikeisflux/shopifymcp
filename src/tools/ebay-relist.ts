/**
 * Higher-level eBay listing workflows:
 *
 *  - ebay_relist_sold_covers — take specific SKUs (or a collection's ended
 *    covers), clear stale listing data, republish, and return item numbers
 *    filtered to just the requested SKUs (with a distinct alreadyActive bucket).
 *  - shopify_duplicate_listing_for_extra_copies — create N extra copies of a
 *    single-variant listing (incrementing suffix), either eBay-only (no catalog
 *    products) or Shopify+eBay.
 *
 * Both reuse the shared single-auction recipe (ebay-listing.ts) and the batched
 * status check (batch-lookups.ts).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ShopifyClient, assertNoUserErrors } from "../shopify-client.js";
import { EbayClient } from "../ebay-client.js";
import type { Config } from "../config.js";
import { logToolCall } from "../logger.js";
import { textContent, gidToId, toGid } from "../format.js";
import { publishListing, clearListing } from "./ebay-listing.js";
import { checkListingStatus, escapeSkuValue } from "./batch-lookups.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── GraphQL ─────────────────────────────────────────────────────────────────

const VARIANTS_BY_SKU = /* GraphQL */ `
  query RelistSource($query: String!) {
    productVariants(first: 250, query: $query) {
      nodes { sku price product { id title vendor tags featuredImage { url } } }
    }
  }
`;

const COLLECTION_VARIANTS = /* GraphQL */ `
  query RelistCollection($id: ID!, $first: Int!) {
    collection(id: $id) {
      title
      products(first: $first) {
        nodes { title vendor tags featuredImage { url } variants(first: 1) { nodes { sku price } } }
      }
    }
  }
`;

const DUP_SOURCE = /* GraphQL */ `
  query DupSource($id: ID!) {
    product(id: $id) {
      id title vendor productType tags
      featuredImage { url }
      variants(first: 1) { nodes { id sku price } }
    }
  }
`;

const CREATE_PRODUCT_WITH_VARIANT = /* GraphQL */ `
  mutation DupCreateProduct($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product { id title variants(first: 1) { nodes { id } } }
      userErrors { field message }
    }
  }
`;

const UPDATE_VARIANT_SKU_PRICE = /* GraphQL */ `
  mutation DupSetVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id sku price }
      userErrors { field message }
    }
  }
`;

const ADD_MEDIA = /* GraphQL */ `
  mutation DupAddMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media { ... on MediaImage { id } }
      mediaUserErrors { field message }
    }
  }
`;

// ─── Types ───────────────────────────────────────────────────────────────────

interface VariantSource {
  sku: string | null;
  price: string | null;
  product: { id: string; title: string; vendor: string | null; tags: string[]; featuredImage: { url: string } | null } | null;
}

function stripEbaylive(s: string): string {
  return s.replace(/-ebaylive\s*$/i, "").trim();
}

/** Fill a title template; tidy empty () and dangling separators; cap at 80 chars. */
function fillTitle(template: string, vars: Record<string, string>): string {
  let t = template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");
  t = t.replace(/\(\s*\)/g, "").replace(/\s+/g, " ").trim();
  return t.length > 80 ? t.slice(0, 80).trim() : t;
}

export function registerEbayListingWorkflowTools(server: McpServer, shopify: ShopifyClient, ebay: EbayClient, config: Config): void {
  // ─── ebay_relist_sold_covers ───────────────────────────────────────────────
  server.registerTool(
    "ebay_relist_sold_covers",
    {
      title: "Relist sold/ended eBay covers",
      description:
        "End-to-end relist: given specific SKUs (or a collection's ended covers), clear any stale offer/inventory data and republish each as an eBay auction, returning item numbers filtered to just the requested SKUs. Still-active listings are returned in a separate 'alreadyActive' bucket (their existing item numbers), not relisted. dryRun (default) previews which SKUs would be cleared and relisted. Use skus OR collectionId, not both.",
      inputSchema: {
        skus: z.array(z.string()).optional().describe("Specific SKUs to relist (the -ebaylive SKUs). Use this OR collectionId."),
        collectionId: z.string().optional().describe("Relist from this collection (numeric or GID). Combine with onlyEnded to only touch sold-out covers."),
        onlyEnded: z.boolean().default(true).describe("Skip anything still active — only clear + relist ended/unpublished/unlisted covers."),
        titleTemplate: z.string().optional().describe("Optional title template; placeholders {title}(product title minus -ebaylive) {sku} {skucode} {vendor}. Default: the product's own title."),
        price: z.number().optional().describe("Override starting auction price for all relisted items. Defaults to each SKU's Shopify price."),
        weightLb: z.number().positive().default(0.5).describe("Package weight in pounds for calculated shipping."),
        dryRun: z.boolean().default(true).describe("true (default): preview which SKUs would be cleared + relisted. false: perform it."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    (async (args: { skus?: string[]; collectionId?: string; onlyEnded: boolean; titleTemplate?: string; price?: number; weightLb: number; dryRun: boolean }) => {
      const start = Date.now();
      try {
        const hasSkus = Boolean(args.skus?.length);
        if (hasSkus && args.collectionId) throw new Error("Provide skus OR collectionId, not both.");
        if (!hasSkus && !args.collectionId) throw new Error("Provide either skus or collectionId.");

        // Resolve the target set → map of sku → source product data.
        const sources = new Map<string, VariantSource>();
        let targetSkus: string[] = [];
        if (args.skus?.length) {
          targetSkus = [...new Set(args.skus.filter(Boolean))];
          const CHUNK = 40;
          for (let i = 0; i < targetSkus.length; i += CHUNK) {
            const chunk = targetSkus.slice(i, i + CHUNK);
            const query = chunk.map((s) => `sku:"${escapeSkuValue(s)}"`).join(" OR ");
            const res = await shopify.request<{ productVariants: { nodes: VariantSource[] } }>(VARIANTS_BY_SKU, { query });
            for (const v of res.data.productVariants.nodes) if (v.sku) sources.set(v.sku, v);
          }
        } else {
          const res = await shopify.request<{ collection: { title: string; products: { nodes: Array<{ title: string; vendor: string | null; tags: string[]; featuredImage: { url: string } | null; variants: { nodes: Array<{ sku: string | null; price: string | null }> } }> } } | null }>(
            COLLECTION_VARIANTS,
            { id: toGid("Collection", args.collectionId!), first: 250 },
          );
          const coll = res.data.collection;
          if (!coll) throw new Error(`Collection ${args.collectionId} not found.`);
          for (const p of coll.products.nodes) {
            const v = p.variants.nodes[0];
            if (!v?.sku) continue;
            targetSkus.push(v.sku);
            sources.set(v.sku, { sku: v.sku, price: v.price, product: { id: "", title: p.title, vendor: p.vendor, tags: p.tags, featuredImage: p.featuredImage } });
          }
        }

        // Check current eBay status for the whole set.
        const statuses = await checkListingStatus(ebay, targetSkus);
        const statusBySku = new Map(statuses.map((s) => [s.sku, s]));

        const relisted: Array<Record<string, unknown>> = [];
        const alreadyActive: Array<Record<string, unknown>> = [];
        const failed: Array<Record<string, unknown>> = [];
        const toRelist: string[] = [];

        for (const sku of targetSkus) {
          const st = statusBySku.get(sku);
          if (st?.status === "active") {
            alreadyActive.push({ sku, itemNumber: st.listingId, price: st.price, note: "already active, no action taken" });
            continue;
          }
          if (args.onlyEnded && !st) { failed.push({ sku, reason: "no status" }); continue; }
          toRelist.push(sku);
        }

        if (args.dryRun) {
          const preview = toRelist.map((sku) => {
            const src = sources.get(sku);
            const price = args.price != null ? args.price.toFixed(2) : src?.price ?? null;
            return { sku, plannedPrice: price, currentStatus: statusBySku.get(sku)?.status ?? "unknown", hasImage: Boolean(src?.product?.featuredImage?.url) };
          });
          const summary = { dryRun: true, requested: targetSkus.length, wouldRelist: toRelist.length, alreadyActive, wouldClearAndRelist: preview };
          logToolCall({ tool: "ebay_relist_sold_covers", durationMs: Date.now() - start, success: true });
          return { content: [textContent(`**DRY RUN** — ${toRelist.length} SKU(s) would be cleared + relisted; ${alreadyActive.length} already active.\n\n\`\`\`json\n${JSON.stringify(summary, null, 2).slice(0, 12000)}\n\`\`\``)], structuredContent: summary };
        }

        for (const sku of toRelist) {
          const src = sources.get(sku);
          if (!src || !src.product) { failed.push({ sku, reason: "no Shopify product/variant for SKU" }); continue; }
          const imageUrl = src.product.featuredImage?.url;
          if (!imageUrl) { failed.push({ sku, reason: "no product image" }); continue; }
          const price = args.price != null ? args.price.toFixed(2) : src.price;
          if (!price || Number(price) <= 0) { failed.push({ sku, reason: `invalid price "${price ?? ""}"` }); continue; }

          const titleBase = stripEbaylive(src.product.title);
          const vars = { title: titleBase, sku, skucode: stripEbaylive(sku), vendor: src.product.vendor ?? "Divinity Comics" };
          const title = args.titleTemplate ? fillTitle(args.titleTemplate, vars) : (titleBase.length > 80 ? titleBase.slice(0, 80) : titleBase);

          try {
            const cleared = await clearListing(ebay, sku); // remove stale offer/inventory so republish is clean
            const pub = await publishListing(ebay, config, { sku, title, price, imageUrl, seriesLabel: titleBase, vendor: vars.vendor, weightLb: args.weightLb });
            relisted.push({ sku, itemNumber: pub.itemId, price, imageHosted: pub.imageHosted, cleared: cleared.deletedOffers.length || cleared.deletedInventoryItem ? cleared : undefined });
            await sleep(200);
          } catch (e) {
            failed.push({ sku, reason: e instanceof Error ? e.message : String(e) });
          }
        }

        const summary = { dryRun: false, requested: targetSkus.length, relisted, alreadyActive, failed };
        logToolCall({ tool: "ebay_relist_sold_covers", durationMs: Date.now() - start, success: true });
        return { content: [textContent(`Relisted ${relisted.length} SKU(s); ${alreadyActive.length} already active, ${failed.length} failed.\n\n\`\`\`json\n${JSON.stringify(summary, null, 2).slice(0, 13000)}\n\`\`\``)], structuredContent: summary };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logToolCall({ tool: "ebay_relist_sold_covers", durationMs: Date.now() - start, success: false, error: message });
        return { content: [textContent(`Error: ${message}`)], isError: true };
      }
    }) as never,
  );

  // ─── shopify_duplicate_listing_for_extra_copies ────────────────────────────
  server.registerTool(
    "shopify_duplicate_listing_for_extra_copies",
    {
      title: "Duplicate a listing for extra copies",
      description:
        "Create N extra copies of an existing single-variant listing — same image and price, incrementing suffix (SKU {baseSku}{n}-ebaylive, title \"{baseTitle} {label}{n}\"). destination is REQUIRED and explicit: 'ebay_only' publishes eBay auctions WITHOUT creating any Shopify catalog product; 'shopify_and_ebay' also creates the Shopify products. dryRun (default) previews the exact titles/SKUs first.",
      inputSchema: {
        sourceProductId: z.string().describe("Existing product to copy (its title, image, price, vendor, type, tags are the template). Numeric or GID."),
        count: z.number().int().min(1).max(50).describe("How many additional copies to create."),
        suffixStart: z.number().int().min(1).default(2).describe("Number the extra copies from here (e.g. 2 → F2, F3, ...)."),
        destination: z.enum(["shopify_and_ebay", "ebay_only"]).describe("REQUIRED. 'ebay_only': eBay listings only, no Shopify products. 'shopify_and_ebay': also create catalog products."),
        titleSuffixLabel: z.string().optional().describe("Letter(s) before the copy number in the title (e.g. \"F\"). Defaults to the trailing letters of the source SKU."),
        ebayPrice: z.number().optional().describe("Starting auction price. Defaults to the source listing's price."),
        weightLb: z.number().positive().default(0.5).describe("Package weight in pounds for calculated shipping."),
        dryRun: z.boolean().default(true).describe("true (default): preview titles/SKUs without creating anything. false: create the copies."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    (async (args: { sourceProductId: string; count: number; suffixStart: number; destination: "shopify_and_ebay" | "ebay_only"; titleSuffixLabel?: string; ebayPrice?: number; weightLb: number; dryRun: boolean }) => {
      const start = Date.now();
      try {
        const sourceGid = toGid("Product", args.sourceProductId);
        const res = await shopify.request<{ product: { id: string; title: string; vendor: string | null; productType: string | null; tags: string[]; featuredImage: { url: string } | null; variants: { nodes: Array<{ id: string; sku: string | null; price: string | null }> } } | null }>(DUP_SOURCE, { id: sourceGid });
        const product = res.data.product;
        if (!product) throw new Error(`Source product ${args.sourceProductId} not found.`);
        const variant = product.variants.nodes[0];
        if (!variant?.sku) throw new Error("Source product has no variant SKU to base copies on.");
        const imageUrl = product.featuredImage?.url;
        if (!imageUrl && args.destination === "ebay_only") throw new Error("Source product has no image; eBay listings need one.");

        const baseSku = stripEbaylive(variant.sku); // e.g. STB1-13F
        const baseTitle = stripEbaylive(product.title); // e.g. STB1-13 Foil
        const label = args.titleSuffixLabel ?? (baseSku.match(/[A-Za-z]+$/)?.[0] ?? "");
        const price = (args.ebayPrice != null ? args.ebayPrice : Number(variant.price ?? 0)).toFixed(2);
        const vendor = product.vendor ?? "Divinity Comics";

        const copies = Array.from({ length: args.count }, (_, i) => {
          const n = args.suffixStart + i;
          return { n, sku: `${baseSku}${n}-ebaylive`, title: `${baseTitle} ${label}${n}`.replace(/\s+/g, " ").trim() };
        });

        if (args.dryRun) {
          const summary = { dryRun: true, sourceProductId: gidToId(sourceGid), destination: args.destination, price, count: args.count, copies: copies.map((c) => ({ sku: c.sku, title: c.title, price })) };
          logToolCall({ tool: "shopify_duplicate_listing_for_extra_copies", durationMs: Date.now() - start, success: true });
          return { content: [textContent(`**DRY RUN** — would create ${args.count} copy(ies) via ${args.destination}.\n\n\`\`\`json\n${JSON.stringify(summary, null, 2).slice(0, 12000)}\n\`\`\``)], structuredContent: summary };
        }

        const created: Array<Record<string, unknown>> = [];
        const failed: Array<Record<string, unknown>> = [];
        for (const c of copies) {
          try {
            let productId: string | null = null;
            if (args.destination === "shopify_and_ebay") {
              const cp = await shopify.request<{ productCreate: { product: { id: string; variants: { nodes: Array<{ id: string }> } } | null; userErrors: Array<{ field: string[] | null; message: string }> } }>(CREATE_PRODUCT_WITH_VARIANT, {
                product: { title: c.title, vendor, productType: product.productType ?? "Comic Book", tags: product.tags, status: "ACTIVE" },
              });
              assertNoUserErrors(cp.data.productCreate.userErrors);
              const np = cp.data.productCreate.product!;
              productId = np.id;
              const vId = np.variants.nodes[0]?.id;
              if (vId) {
                const uv = await shopify.request<{ productVariantsBulkUpdate: { userErrors: Array<{ field: string[] | null; message: string }> } }>(UPDATE_VARIANT_SKU_PRICE, { productId: np.id, variants: [{ id: vId, price, inventoryItem: { sku: c.sku } }] });
                assertNoUserErrors(uv.data.productVariantsBulkUpdate.userErrors);
              }
              if (imageUrl) {
                const am = await shopify.request<{ productCreateMedia: { mediaUserErrors: Array<{ field: string[] | null; message: string }> } }>(ADD_MEDIA, { productId: np.id, media: [{ originalSource: imageUrl, mediaContentType: "IMAGE" }] });
                assertNoUserErrors(am.data.productCreateMedia.mediaUserErrors);
              }
            }
            const pub = await publishListing(ebay, config, { sku: c.sku, title: c.title, price, imageUrl: imageUrl!, seriesLabel: baseTitle, vendor, weightLb: args.weightLb });
            created.push({ sku: c.sku, title: c.title, itemNumber: pub.itemId, price, productId: productId ? gidToId(productId) : null, imageHosted: pub.imageHosted });
            await sleep(200);
          } catch (e) {
            failed.push({ sku: c.sku, title: c.title, error: e instanceof Error ? e.message : String(e) });
          }
        }

        const summary = { dryRun: false, sourceProductId: gidToId(sourceGid), destination: args.destination, createdCount: created.length, failedCount: failed.length, itemNumbers: created.map((c) => c.itemNumber), created, failed };
        logToolCall({ tool: "shopify_duplicate_listing_for_extra_copies", durationMs: Date.now() - start, success: true });
        return { content: [textContent(`Created ${created.length}/${args.count} copy(ies) via ${args.destination}; ${failed.length} failed.\n\n\`\`\`json\n${JSON.stringify(summary, null, 2).slice(0, 13000)}\n\`\`\``)], structuredContent: summary };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logToolCall({ tool: "shopify_duplicate_listing_for_extra_copies", durationMs: Date.now() - start, success: false, error: message });
        return { content: [textContent(`Error: ${message}`)], isError: true };
      }
    }) as never,
  );
}
