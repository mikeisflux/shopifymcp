/**
 * eBay listing-coverage audit.
 *
 * Reconciles live (ACTIVE) *base* books/prints against the seller's eBay
 * inventory to surface coverage gaps. "Base" means the real catalog product —
 * anything with `ebaylive` in its SKU or title is EXCLUDED, since those are the
 * separate auction twins and don't count for this audit.
 *
 * For every remaining product it checks whether that SKU exists in eBay
 * inventory ("listed on eBay") and splits the result into listed vs. not-listed
 * (the "needs listing" gap). It scans the whole catalog + all eBay inventory, so
 * the tool starts a background job (JobRunner) and returns a jobId; read the
 * result with ebay_job_status.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShopifyClient } from "../shopify-client.js";
import type { EbayClient } from "../ebay-client.js";
import type { JobRunner, ProgressFn } from "../job-runner.js";
import { logToolCall } from "../logger.js";
import { textContent } from "../format.js";

const PRODUCTS_PAGE = /* GraphQL */ `
  query CoverageProducts($q: String!, $first: Int!, $after: String) {
    products(first: $first, after: $after, query: $q) {
      pageInfo { hasNextPage endCursor }
      nodes { title productType variants(first: 1) { nodes { sku price } } }
    }
  }`;

interface BaseRow { sku: string; title: string; type: string; price: string }

/** A product is "ebaylive" (excluded) if the marker is in its SKU or title. */
const isEbaylive = (sku: string, title: string): boolean => /ebaylive/i.test(sku) || /ebaylive/i.test(title);

/** Page every product of the given types, keeping only non-ebaylive base rows. */
async function gatherBaseProducts(shopify: ShopifyClient, productTypes: string[], statusQ: string, progress: ProgressFn): Promise<BaseRow[]> {
  const rows: BaseRow[] = [];
  for (const type of productTypes) {
    const q = [`product_type:'${type}'`, statusQ ? `status:${statusQ}` : ""].filter(Boolean).join(" ");
    let after: string | null = null;
    for (let page = 0; page < 120; page++) {
      const r: { data: { products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<{ title: string; productType: string; variants: { nodes: Array<{ sku: string | null; price: string | null }> } }> } } } =
        await shopify.request(PRODUCTS_PAGE, { q, first: 250, after });
      const pc = r.data.products;
      for (const p of pc.nodes) {
        const v = p.variants.nodes[0];
        const sku = v?.sku ?? "";
        if (!sku || isEbaylive(sku, p.title)) continue;
        rows.push({ sku, title: p.title, type: p.productType, price: v?.price ?? "" });
      }
      progress({ phase: "shopify", type, kept: rows.length });
      if (!pc.pageInfo.hasNextPage) break;
      after = pc.pageInfo.endCursor;
    }
  }
  return rows;
}

/** Build the set of SKUs that have an eBay inventory record. */
async function gatherEbaySkus(ebay: EbayClient, progress: ProgressFn): Promise<Set<string>> {
  const skus = new Set<string>();
  let offset = 0;
  for (let page = 0; page < 300; page++) {
    const res = await ebay.request("GET", "/sell/inventory/v1/inventory_item", { query: { limit: 200, offset } }).catch(() => null);
    const items = (res?.data as { inventoryItems?: Array<{ sku?: string }> } | undefined)?.inventoryItems ?? [];
    for (const it of items) if (it.sku) skus.add(it.sku);
    progress({ phase: "ebay", ebaySkus: skus.size });
    if (items.length < 200) break;
    offset += 200;
  }
  return skus;
}

function toCsv(rows: BaseRow[]): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return ["sku,title,type,price", ...rows.map((r) => [r.sku, r.title, r.type, r.price].map((c) => esc(String(c ?? ""))).join(","))].join("\n");
}

export function registerCoverageAuditTools(server: McpServer, shopify: ShopifyClient, ebay: EbayClient, jobs: JobRunner): void {
  server.registerTool(
    "ebay_coverage_audit",
    {
      title: "Audit eBay listing coverage",
      description:
        "Find eBay coverage gaps for your real catalog. Scans live base books/prints (default product types Comic Book + Art Print) and EXCLUDES anything with 'ebaylive' in its SKU or title. For each remaining product it checks whether that SKU exists in your eBay inventory, then reports — split by product type — how many are listed on eBay vs. the list of ones that are NOT (the 'needs listing' gap, with a CSV). Whole-catalog scan, so it runs as a background job: read the result with ebay_job_status.",
      inputSchema: {
        productTypes: z.array(z.string()).min(1).optional().describe("Shopify product types to include. Default: [\"Comic Book\", \"Art Print\"]."),
        status: z.enum(["ACTIVE", "DRAFT", "ARCHIVED", "ANY"]).default("ACTIVE").describe("Which product status counts as 'live'. Default ACTIVE."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (async (args: { productTypes?: string[]; status: string }) => {
      const startedAt = Date.now();
      const types = args.productTypes?.length ? args.productTypes : ["Comic Book", "Art Print"];
      const statusQ = args.status === "ANY" ? "" : args.status.toLowerCase();
      const job = jobs.start("ebay_coverage_audit", async (progress) => {
        const base = await gatherBaseProducts(shopify, types, statusQ, progress);
        const ebaySkus = await gatherEbaySkus(ebay, progress);
        const listed: BaseRow[] = [];
        const notListed: BaseRow[] = [];
        for (const r of base) (ebaySkus.has(r.sku) ? listed : notListed).push(r);
        const byType: Record<string, { base: number; listed: number; notListed: number }> = {};
        for (const r of base) (byType[r.type] ??= { base: 0, listed: 0, notListed: 0 }).base++;
        for (const r of listed) (byType[r.type] ??= { base: 0, listed: 0, notListed: 0 }).listed++;
        for (const r of notListed) (byType[r.type] ??= { base: 0, listed: 0, notListed: 0 }).notListed++;
        return {
          productTypes: types,
          status: statusQ || "any",
          baseProductsScanned: base.length,
          ebayInventorySkus: ebaySkus.size,
          listedOnEbay: listed.length,
          notListedNeedListing: notListed.length,
          byType,
          needListing: notListed.slice(0, 1000),
          needListingCsv: toCsv(notListed.slice(0, 3000)),
          listedSample: listed.slice(0, 50),
          note: "'listed on eBay' = the base SKU has an eBay inventory record (may include ended listings). Anything with 'ebaylive' in its SKU or title was excluded.",
        };
      });
      logToolCall({ tool: "ebay_coverage_audit", durationMs: Date.now() - startedAt, success: true });
      return {
        content: [textContent(`Started coverage audit as background job \`${job.jobId}\` — types: ${types.join(", ")}; status: ${statusQ || "any"}. It scans the whole catalog + your eBay inventory, so give it a minute, then read it with ebay_job_status { jobId: "${job.jobId}" }.`)],
        structuredContent: { jobId: job.jobId, status: job.status },
      };
    }) as never,
  );
}
