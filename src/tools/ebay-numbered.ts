/**
 * ebay_create_numbered_listings — one call to build N numbered Shopify products
 * from a single image and list them all on eBay (auction or fixed price).
 *
 * The image is uploaded to Shopify Files ONCE (from any public URL — a Google
 * Drive share link is normalized to a direct-download URL); the resulting stable
 * CDN URL is reused for every product and for eBay, so there's no per-item Drive
 * fetch (the failure mode that dropped images on a big run). Products and eBay
 * listings are both created idempotently (existing SKU/published offer → reused),
 * so re-running the same call creates nothing new and returns the same numbers.
 *
 * Because N can be ~100 and the MCP transport times out ~90s, a live run of more
 * than 20 items is dispatched to the background JobRunner and returns a jobId;
 * poll ebay_job_status for progress + the final payload. dryRun and small live
 * runs return synchronously.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ShopifyClient } from "../shopify-client.js";
import { EbayClient } from "../ebay-client.js";
import type { Config } from "../config.js";
import type { JobRunner, ProgressFn } from "../job-runner.js";
import { logToolCall } from "../logger.js";
import { textContent } from "../format.js";
import { publishListing, clearListing } from "./ebay-listing.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const JOB_THRESHOLD = 20; // live runs larger than this go to the background runner

// ─── GraphQL ─────────────────────────────────────────────────────────────────

const FILE_CREATE = /* GraphQL */ `
  mutation NumberedFileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files { id fileStatus ... on MediaImage { image { url } } }
      userErrors { field message code }
    }
  }
`;
const FILE_NODE = /* GraphQL */ `
  query NumberedFileNode($id: ID!) {
    node(id: $id) { ... on MediaImage { id fileStatus image { url } } }
  }
`;
const VARIANT_BY_SKU = /* GraphQL */ `
  query NumberedVariantBySku($query: String!) {
    productVariants(first: 1, query: $query) { nodes { id product { id } } }
  }
`;
const CREATE_PRODUCT = /* GraphQL */ `
  mutation NumberedCreateProduct($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product { id variants(first: 1) { nodes { id } } }
      userErrors { field message }
    }
  }
`;
const UPDATE_VARIANT = /* GraphQL */ `
  mutation NumberedSetVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id sku price }
      userErrors { field message }
    }
  }
`;
const ADD_MEDIA = /* GraphQL */ `
  mutation NumberedAddMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media { ... on MediaImage { id } }
      mediaUserErrors { field message }
    }
  }
`;
const ADD_TO_COLLECTION = /* GraphQL */ `
  mutation NumberedAddToCollection($id: ID!, $productIds: [ID!]!) {
    collectionAddProducts(id: $id, productIds: $productIds) {
      collection { id }
      userErrors { field message }
    }
  }
`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Normalize a Google Drive share link to a direct-download URL Shopify can fetch. */
export function normalizeImageUrl(url: string): string {
  const m = url.match(/drive\.google\.com\/file\/d\/([^/?#]+)/i);
  if (m) return `https://drive.google.com/uc?export=download&id=${m[1]}`;
  const open = url.match(/drive\.google\.com\/open\?[^#]*\bid=([^&#]+)/i);
  if (open) return `https://drive.google.com/uc?export=download&id=${open[1]}`;
  return url;
}

function fillTitle(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => (vars[k] !== undefined ? String(vars[k]) : "")).replace(/\s+/g, " ").trim();
}

/** Upload the image to Shopify Files once and return its processed CDN URL. */
async function uploadImageOnce(shopify: ShopifyClient, url: string): Promise<string> {
  const create = await shopify.request<{ fileCreate: { files: Array<{ id: string; fileStatus: string; image?: { url: string } | null }> | null; userErrors: Array<{ field: string[] | null; message: string; code?: string }> } }>(
    FILE_CREATE,
    { files: [{ originalSource: url, contentType: "IMAGE" }] },
  );
  const errs = create.data.fileCreate.userErrors;
  if (errs.length) throw new Error(`fileCreate failed: ${errs.map((e) => e.message).join("; ")}`);
  const file = create.data.fileCreate.files?.[0];
  if (!file) throw new Error("fileCreate returned no file");
  if (file.image?.url) return file.image.url;
  // Poll until Shopify finishes processing the image.
  for (let i = 0; i < 20; i++) {
    await sleep(2000);
    const node = await shopify.request<{ node: { fileStatus?: string; image?: { url: string } | null } | null }>(FILE_NODE, { id: file.id });
    const n = node.data.node;
    if (n?.fileStatus === "READY" && n.image?.url) return n.image.url;
    if (n?.fileStatus === "FAILED") throw new Error("Shopify failed to process the image (fileStatus FAILED)");
  }
  throw new Error("timed out waiting for Shopify to process the image");
}

interface NumberedArgs {
  prefix: string;
  titleTemplate: string;
  start: number;
  end: number;
  price: number;
  imageUrl: string;
  format: "AUCTION" | "FIXED_PRICE";
  quantity: number;
  productType: string;
  vendor: string;
  tags: string[];
  collectionId?: string;
  weightLb: number;
  dryRun: boolean;
}

function toCollectionGid(id: string): string {
  return id.startsWith("gid://") ? id : `gid://shopify/Collection/${id}`;
}

/** The full build+list work (idempotent). Reports progress; returns the summary. */
async function buildAndList(shopify: ShopifyClient, ebay: EbayClient, config: Config, args: NumberedArgs, progress: ProgressFn): Promise<Record<string, unknown>> {
  const total = args.end - args.start + 1;
  const price = args.price.toFixed(2);
  const cdnUrl = await uploadImageOnce(shopify, normalizeImageUrl(args.imageUrl));
  progress({ phase: "image-ready", cdnUrl, total });

  const products: Array<{ n: number; sku: string; productId: string | null; itemNumber: string | null }> = [];
  const failed: Array<{ n: number; sku: string; error: string }> = [];
  const newProductIds: string[] = [];
  let listed = 0;

  for (let n = args.start; n <= args.end; n++) {
    const sku = `${args.prefix}-${n}-ebaylive`;
    const title = fillTitle(args.titleTemplate, { n, total, sku, prefix: args.prefix });
    let productId: string | null = null;
    let itemNumber: string | null = null;
    try {
      // 1. Shopify product (reuse if the SKU already exists).
      const found = await shopify.request<{ productVariants: { nodes: Array<{ product: { id: string } | null }> } }>(VARIANT_BY_SKU, { query: `sku:"${sku}"` });
      const existingProduct = found.data.productVariants.nodes[0]?.product?.id ?? null;
      if (existingProduct) {
        productId = existingProduct;
      } else {
        const cp = await shopify.request<{ productCreate: { product: { id: string; variants: { nodes: Array<{ id: string }> } } | null; userErrors: Array<{ field: string[] | null; message: string }> } }>(
          CREATE_PRODUCT,
          { product: { title, vendor: args.vendor, productType: args.productType, tags: args.tags, status: "ACTIVE" } },
        );
        if (cp.data.productCreate.userErrors.length) throw new Error(cp.data.productCreate.userErrors.map((e) => e.message).join("; "));
        const np = cp.data.productCreate.product!;
        productId = np.id;
        newProductIds.push(np.id);
        const vId = np.variants.nodes[0]?.id;
        if (vId) {
          const uv = await shopify.request<{ productVariantsBulkUpdate: { userErrors: Array<{ field: string[] | null; message: string }> } }>(UPDATE_VARIANT, { productId: np.id, variants: [{ id: vId, price, inventoryItem: { sku } }] });
          if (uv.data.productVariantsBulkUpdate.userErrors.length) throw new Error(uv.data.productVariantsBulkUpdate.userErrors.map((e) => e.message).join("; "));
        }
        const am = await shopify.request<{ productCreateMedia: { mediaUserErrors: Array<{ field: string[] | null; message: string }> } }>(ADD_MEDIA, { productId: np.id, media: [{ originalSource: cdnUrl, mediaContentType: "IMAGE" }] });
        if (am.data.productCreateMedia.mediaUserErrors.length) throw new Error(am.data.productCreateMedia.mediaUserErrors.map((e) => e.message).join("; "));
      }

      // 2. eBay listing (reuse an already-published offer; else list, retry 25604 once, verify).
      itemNumber = await listOneOnEbay(ebay, config, { sku, title, price, cdnUrl, args });
      if (itemNumber) listed++;
      products.push({ n, sku, productId, itemNumber });
    } catch (e) {
      failed.push({ n, sku, error: e instanceof Error ? e.message : String(e) });
      products.push({ n, sku, productId, itemNumber: null });
    }
    progress({ phase: "listing", done: products.length, listed, failed: failed.length, total, lastSku: sku });
    await sleep(150);
  }

  // Optional: add all products to a collection in one call.
  if (args.collectionId && newProductIds.length) {
    await shopify.request(ADD_TO_COLLECTION, { id: toCollectionGid(args.collectionId), productIds: newProductIds }).catch(() => null);
  }

  products.sort((a, b) => a.n - b.n);
  const itemNumbers = products.map((p) => p.itemNumber).filter((x): x is string => Boolean(x));
  return {
    format: args.format,
    range: `${args.prefix}-${args.start}..${args.end}`,
    created: products.filter((p) => p.productId).length,
    listed,
    failedCount: failed.length,
    failed,
    itemNumbers,
    itemNumbersText: itemNumbers.join("\n"),
    products,
  };
}

/** List one SKU on eBay: reuse a published offer if present; else publish, retry 25604 once, then verify. */
async function listOneOnEbay(ebay: EbayClient, config: Config, p: { sku: string; title: string; price: string; cdnUrl: string; args: NumberedArgs }): Promise<string | null> {
  // Reuse an already-published listing (idempotency / safe re-run).
  const existing = await ebay.request("GET", "/sell/inventory/v1/offer", { query: { sku: p.sku } }).catch(() => null);
  const offers = (existing?.data as { offers?: Array<{ status?: string; listing?: { listingId?: string } }> } | undefined)?.offers;
  const live = offers?.find((o) => o.status === "PUBLISHED" && o.listing?.listingId);
  if (live?.listing?.listingId) return live.listing.listingId;

  const params = { sku: p.sku, title: p.title, price: p.price, imageUrl: p.cdnUrl, seriesLabel: p.args.prefix, vendor: p.args.vendor, weightLb: p.args.weightLb, format: p.args.format, quantity: p.args.quantity };
  try {
    const pub = await publishListing(ebay, config, params);
    if (pub.itemId) return pub.itemId;
  } catch (e) {
    // "25604 Availability not found" is transient right after inventory write — retry once.
    if (/25604|availability not found/i.test(e instanceof Error ? e.message : String(e))) {
      await sleep(2000);
      const retry = await publishListing(ebay, config, params).catch(() => null);
      if (retry?.itemId) return retry.itemId;
    } else {
      // Any other failure: one clear-and-relist pass (what relist does today).
    }
  }
  // Verify / recover: clear stale offer + inventory, then one clean relist.
  await clearListing(ebay, p.sku).catch(() => null);
  const relist = await publishListing(ebay, config, params).catch(() => null);
  return relist?.itemId ?? null;
}

export function registerEbayNumberedTools(server: McpServer, shopify: ShopifyClient, ebay: EbayClient, config: Config, jobs: JobRunner): void {
  server.registerTool(
    "ebay_create_numbered_listings",
    {
      title: "Bulk-create numbered products + eBay listings",
      description:
        "Build N numbered Shopify products from ONE image and list them all on eBay in a single call — e.g. \"Back Issue Blow Out #1..96\". The image is uploaded to Shopify Files once (any public URL; a Google Drive share link is auto-normalized) and its CDN URL reused for every product and eBay, so there are no per-item image fetches. Idempotent: an existing SKU reuses its product, an already-published offer reuses its item number — re-running creates nothing new. dryRun (default) echoes the SKU/title list. A live run of >20 items runs as a BACKGROUND JOB and returns {jobId} — poll ebay_job_status; ≤20 returns synchronously.",
      inputSchema: {
        prefix: z.string().describe("SKU base → {prefix}-{n}-ebaylive (e.g. BIBO → BIBO-1-ebaylive)."),
        titleTemplate: z.string().describe("Title template; placeholders {n} {total} {sku} {prefix} (e.g. \"Back Issue Blow Out #{n}\")."),
        count: z.number().int().min(1).max(500).optional().describe("How many items, numbered from `start` (default 1). Provide count OR start+end."),
        start: z.number().int().min(0).optional().describe("First number (default 1)."),
        end: z.number().int().min(0).optional().describe("Last number (inclusive). Provide with start instead of count."),
        price: z.number().positive().describe("Price / auction start price for every item."),
        imageUrl: z.string().url().describe("Public image URL (Google Drive share link OK — normalized to a direct download)."),
        format: z.enum(["AUCTION", "FIXED_PRICE"]).default("AUCTION").describe("Listing format."),
        quantity: z.number().int().min(1).default(1).describe("Quantity per FIXED_PRICE listing (auctions are always 1)."),
        productType: z.string().default("Comic Book").describe("Shopify product type."),
        vendor: z.string().default("Divinity Comics").describe("Shopify vendor / eBay Publisher aspect."),
        tags: z.array(z.string()).default(["ebaylive"]).describe("Shopify product tags."),
        collectionId: z.string().optional().describe("Optional Shopify collection to add all created products to."),
        weightLb: z.number().positive().default(0.5).describe("Package weight in pounds for calculated shipping."),
        dryRun: z.boolean().default(true).describe("true (default): echo the SKU/title list, create nothing. false: build + list."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    (async (raw: { prefix: string; titleTemplate: string; count?: number; start?: number; end?: number; price: number; imageUrl: string; format: "AUCTION" | "FIXED_PRICE"; quantity: number; productType: string; vendor: string; tags: string[]; collectionId?: string; weightLb: number; dryRun: boolean }) => {
      const startTs = Date.now();
      try {
        const start = raw.start ?? 1;
        const end = raw.end ?? start + (raw.count ?? 1) - 1;
        if (end < start) throw new Error("end must be >= start.");
        if (end - start + 1 > 500) throw new Error("Refusing to create more than 500 at once.");
        const args: NumberedArgs = { prefix: raw.prefix, titleTemplate: raw.titleTemplate, start, end, price: raw.price, imageUrl: raw.imageUrl, format: raw.format, quantity: raw.quantity, productType: raw.productType, vendor: raw.vendor, tags: raw.tags, collectionId: raw.collectionId, weightLb: raw.weightLb, dryRun: raw.dryRun };
        const total = end - start + 1;

        if (args.dryRun) {
          const preview = Array.from({ length: total }, (_, i) => {
            const n = start + i;
            return { n, sku: `${args.prefix}-${n}-ebaylive`, title: fillTitle(args.titleTemplate, { n, total, sku: `${args.prefix}-${n}`, prefix: args.prefix }), price: args.price.toFixed(2) };
          });
          const summary = { dryRun: true, format: args.format, count: total, imageUrl: normalizeImageUrl(args.imageUrl), preview };
          logToolCall({ tool: "ebay_create_numbered_listings", durationMs: Date.now() - startTs, success: true });
          return { content: [textContent(`**DRY RUN** — ${total} ${args.format === "AUCTION" ? "auction" : "fixed-price"} listing(s) proposed (${args.prefix}-${start}..${end}). Nothing created. Re-run with dryRun:false.\n\n\`\`\`json\n${JSON.stringify(summary, null, 2).slice(0, 12000)}\n\`\`\``)], structuredContent: summary };
        }

        if (total > JOB_THRESHOLD) {
          const job = jobs.start("ebay_create_numbered_listings", (progress) => buildAndList(shopify, ebay, config, args, progress));
          logToolCall({ tool: "ebay_create_numbered_listings", durationMs: Date.now() - startTs, success: true });
          return { content: [textContent(`Started background job **${job.jobId}** to build + list ${total} items (${args.prefix}-${start}..${end}). Poll \`ebay_job_status\` with this jobId for progress and the final item numbers.`)], structuredContent: { jobId: job.jobId, status: "running", total } };
        }

        const summary = await buildAndList(shopify, ebay, config, args, () => {});
        logToolCall({ tool: "ebay_create_numbered_listings", durationMs: Date.now() - startTs, success: true });
        return { content: [textContent(`Built ${summary.created} product(s), listed ${summary.listed}; ${summary.failedCount} failed.\n\n\`\`\`json\n${JSON.stringify(summary, null, 2).slice(0, 13000)}\n\`\`\``)], structuredContent: summary as Record<string, unknown> };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logToolCall({ tool: "ebay_create_numbered_listings", durationMs: Date.now() - startTs, success: false, error: message });
        return { content: [textContent(`Error: ${message}`)], isError: true };
      }
    }) as never,
  );

  server.registerTool(
    "ebay_job_status",
    {
      title: "Check a background job",
      description: "Return the status and progress of a background job started by a bulk tool (e.g. ebay_create_numbered_listings). When done, includes the full result payload (item numbers, etc.).",
      inputSchema: { jobId: z.string().describe("The jobId returned when the background job was started.") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    (async (args: { jobId: string }) => {
      const job = jobs.get(args.jobId);
      if (!job) return { content: [textContent(`No job found with id ${args.jobId}.`)], isError: true };
      const head = job.status === "done" ? `✅ Job ${job.jobId} done.` : job.status === "error" ? `❌ Job ${job.jobId} failed: ${job.error}` : job.status === "interrupted" ? `⚠ Job ${job.jobId} was interrupted by a restart — re-run the original call (it's idempotent).` : `⏳ Job ${job.jobId} running: ${JSON.stringify(job.progress)}`;
      return { content: [textContent(`${head}\n\n\`\`\`json\n${JSON.stringify(job, null, 2).slice(0, 13000)}\n\`\`\``)], structuredContent: job as unknown as Record<string, unknown> };
    }) as never,
  );
}
