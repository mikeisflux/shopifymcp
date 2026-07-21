/**
 * shopify_bulk_adjust_prices — catalog-wide price changes in one call.
 *
 * Target a collectionId, productId, productIds, or productType. Adjust every
 * variant by a delta / percent, or set an absolute price. Per-option-value
 * overrides (e.g. Glow in the Dark gets a different bump) REPLACE the base rule
 * for matching variants (not stacked). dryRun defaults TRUE and returns a
 * before/after plan; execute batches productVariantsBulkUpdate per product.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ShopifyClient } from "../shopify-client.js";
import { registerTool } from "./shared.js";
import { gidToId, toGid, markdownTable } from "../format.js";

const DEFAULT_EXCLUDE_NAMES = ["LTD", "Exclusive", "Sketch", "Damaged", "Pin-Up"];

const PRODUCT_FIELDS = /* GraphQL */ `
  id title productType
  options { optionValues { name } }
  variants(first: 100) {
    nodes { id sku price compareAtPrice selectedOptions { name value } }
  }
`;

const LIST_BY_QUERY = /* GraphQL */ `
  query PriceProductsByQuery($first: Int!, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query) {
      pageInfo { hasNextPage endCursor }
      nodes { ${PRODUCT_FIELDS} }
    }
  }
`;

const LIST_IN_COLLECTION = /* GraphQL */ `
  query PriceCollectionProducts($id: ID!, $first: Int!, $after: String) {
    collection(id: $id) {
      products(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ${PRODUCT_FIELDS} }
      }
    }
  }
`;

const GET_ONE = /* GraphQL */ `
  query PriceProduct($id: ID!) { product(id: $id) { ${PRODUCT_FIELDS} } }
`;

const VARIANTS_UPDATE = /* GraphQL */ `
  mutation PriceVariantsUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id }
      userErrors { field message }
    }
  }
`;

interface RawVariant {
  id: string;
  sku: string | null;
  price: string;
  compareAtPrice: string | null;
  selectedOptions: Array<{ name: string; value: string }>;
}
interface RawProduct {
  id: string;
  title: string;
  productType: string;
  options: Array<{ optionValues: Array<{ name: string }> }>;
  variants: { nodes: RawVariant[] };
}

type Mode = "delta" | "percent" | "set";
function applyMode(price: number, mode: Mode, amount: number): number {
  if (mode === "delta") return price + amount;
  if (mode === "percent") return price * (1 + amount / 100);
  return amount; // set
}
function round2(n: number): string {
  return (Math.round(Math.max(n, 0) * 100) / 100).toFixed(2);
}

interface Change {
  productId: string;
  variantId: string;
  sku: string | null;
  optionValue: string;
  fromPrice: string;
  toPrice: string;
  fromCompare?: string | null;
  toCompare?: string | null;
}

export function registerPricingTools(server: McpServer, client: ShopifyClient): void {
  registerTool(server, client, {
    name: "shopify_bulk_adjust_prices",
    title: "Bulk adjust variant prices",
    description:
      "Adjust variant prices across a collection, a single product, a list of products, or a whole " +
      "productType. mode 'delta' adds `amount`, 'percent' scales by `amount`%, 'set' sets the absolute " +
      "price. `overrides` keyed by option value REPLACE the base rule for matching variants (e.g. Glow " +
      "in the Dark gets a bigger bump — not stacked). compareAtPrice is left alone unless " +
      "includeCompareAt=true. Products whose title/option value match excludeNames (default " +
      "LTD/Exclusive/Sketch/Damaged/Pin-Up) are skipped; variants priced above excludeAbovePrice are " +
      "skipped individually. dryRun defaults TRUE and returns a before/after plan.",
    inputSchema: {
      collectionId: z.string().optional().describe("Target every product in this collection."),
      productId: z.string().optional().describe("Target a single product."),
      productIds: z.array(z.string()).optional().describe("Target an explicit list of products."),
      productType: z.string().optional().describe('Target all products of this type, e.g. "Comic Book".'),
      mode: z.enum(["delta", "percent", "set"]).describe("delta = add amount; percent = scale by amount%; set = absolute price."),
      amount: z.number().describe("The delta, percentage, or absolute price, per `mode`."),
      overrides: z
        .record(z.object({ mode: z.enum(["delta", "percent", "set"]), amount: z.number() }))
        .optional()
        .describe('Per-option-value rules that REPLACE the base for matching variants, e.g. {"Glow in the Dark":{"mode":"delta","amount":20}}.'),
      includeCompareAt: z.boolean().default(false).describe("Also adjust compareAtPrice (same rule). Default false."),
      excludeNames: z
        .array(z.string())
        .default(DEFAULT_EXCLUDE_NAMES)
        .describe("Skip products whose title or an option value contains one of these (case-insensitive). Pass [] to disable."),
      excludeAbovePrice: z.number().positive().optional().describe("Skip individual variants priced above this."),
      dryRun: z.boolean().default(true).describe("If true (default), return the plan and change nothing."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    handler: async (args, c) => {
      const targets = [args.collectionId, args.productId, args.productIds, args.productType].filter((x) => x !== undefined).length;
      if (targets !== 1) throw new Error("Provide exactly one of collectionId, productId, productIds, or productType.");
      const excludeTerms = (args.excludeNames ?? DEFAULT_EXCLUDE_NAMES).map((t) => t.toLowerCase()).filter(Boolean);

      // Resolve target products (with variants).
      const products: RawProduct[] = [];
      const pushPage = (nodes: RawProduct[]) => products.push(...nodes);
      if (args.productId) {
        const r = await c.request<{ product: RawProduct | null }>(GET_ONE, { id: toGid("Product", args.productId) });
        if (r.data.product) products.push(r.data.product);
      } else if (args.productIds) {
        for (const id of args.productIds) {
          const r = await c.request<{ product: RawProduct | null }>(GET_ONE, { id: toGid("Product", id) });
          if (r.data.product) products.push(r.data.product);
        }
      } else if (args.collectionId) {
        let after: string | null = null;
        do {
          const r: { data: { collection: { products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RawProduct[] } } | null } } =
            await c.request(LIST_IN_COLLECTION, { id: toGid("Collection", args.collectionId), first: 5, after });
          if (!r.data.collection) throw new Error(`No collection found with id ${gidToId(args.collectionId)}.`);
          pushPage(r.data.collection.products.nodes);
          after = r.data.collection.products.pageInfo.hasNextPage ? r.data.collection.products.pageInfo.endCursor : null;
        } while (after);
      } else {
        const query = `product_type:'${args.productType!.replace(/'/g, "")}'`;
        let after: string | null = null;
        do {
          const r: { data: { products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RawProduct[] } } } =
            await c.request(LIST_BY_QUERY, { first: 5, after, query });
          pushPage(r.data.products.nodes);
          after = r.data.products.pageInfo.hasNextPage ? r.data.products.pageInfo.endCursor : null;
        } while (after);
      }

      // Plan.
      const changes: Change[] = [];
      const skippedProducts: Array<{ id: string; title: string; reason: string }> = [];
      for (const p of products) {
        // Name exclusion (whole product).
        if (excludeTerms.length) {
          const hay = [p.title, ...p.options.flatMap((o) => o.optionValues.map((v) => v.name)), ...p.variants.nodes.flatMap((v) => v.selectedOptions.map((s) => s.value))]
            .join(" | ").toLowerCase();
          const hit = excludeTerms.find((t) => hay.includes(t));
          if (hit) { skippedProducts.push({ id: p.id, title: p.title, reason: `name contains "${hit}"` }); continue; }
        }
        for (const v of p.variants.nodes) {
          const cur = Number.parseFloat(v.price);
          if (args.excludeAbovePrice != null && cur > args.excludeAbovePrice) continue; // skip premium variant
          const optVal = v.selectedOptions[0]?.value ?? "";
          const override = v.selectedOptions.map((s) => args.overrides?.[s.value]).find((o) => o);
          const rule = override ?? { mode: args.mode, amount: args.amount };
          const to = round2(applyMode(cur, rule.mode, rule.amount));
          let toCompare: string | null | undefined;
          let fromCompare: string | null | undefined;
          if (args.includeCompareAt && v.compareAtPrice != null) {
            fromCompare = v.compareAtPrice;
            toCompare = round2(applyMode(Number.parseFloat(v.compareAtPrice), rule.mode, rule.amount));
          }
          if (to === v.price && (toCompare === undefined || toCompare === v.compareAtPrice)) continue; // no-op
          changes.push({ productId: p.id, variantId: v.id, sku: v.sku, optionValue: optVal, fromPrice: v.price, toPrice: to, fromCompare, toCompare });
        }
      }

      if (args.dryRun) {
        const sample = changes.slice(0, 40);
        const table = sample.length
          ? markdownTable(
              ["SKU", "Cover", "From", "To", ...(args.includeCompareAt ? ["Cmp→"] : [])],
              sample.map((ch) => [ch.sku ?? gidToId(ch.variantId), ch.optionValue, `$${ch.fromPrice}`, `$${ch.toPrice}`, ...(args.includeCompareAt ? [ch.toCompare != null ? `$${ch.fromCompare}→$${ch.toCompare}` : ""] : [])]),
            )
          : "_(no price changes)_";
        return {
          markdown:
            `**DRY RUN** — ${changes.length} variant price change(s) across ${products.length - skippedProducts.length} product(s); ${skippedProducts.length} product(s) skipped.\n\n` +
            table + (changes.length > sample.length ? `\n\n_Showing ${sample.length} of ${changes.length}._` : "") +
            (skippedProducts.length ? `\n\n**Skipped:** ${skippedProducts.slice(0, 15).map((s) => `${s.title} (${s.reason})`).join("; ")}${skippedProducts.length > 15 ? " …" : ""}` : "") +
            `\n\n_Nothing changed. Re-run with dryRun:false to apply._`,
          structured: { dryRun: true, changeCount: changes.length, productsAffected: products.length - skippedProducts.length, skipped: skippedProducts.length, changes: changes.slice(0, 2000), truncated: changes.length > 2000 },
          cost: undefined,
        };
      }

      // Execute: group by product, bulk-update (chunked).
      const byProduct = new Map<string, Change[]>();
      for (const ch of changes) (byProduct.get(ch.productId) ?? byProduct.set(ch.productId, []).get(ch.productId)!).push(ch);
      let updated = 0;
      const errors: string[] = [];
      for (const [productId, chs] of byProduct) {
        for (let i = 0; i < chs.length; i += 100) {
          const chunk = chs.slice(i, i + 100);
          const variants = chunk.map((ch) => {
            const o: Record<string, unknown> = { id: ch.variantId, price: ch.toPrice };
            if (ch.toCompare !== undefined && ch.toCompare !== null) o.compareAtPrice = ch.toCompare;
            return o;
          });
          const r = await c.request<{ productVariantsBulkUpdate: { userErrors: Array<{ message: string }> } }>(VARIANTS_UPDATE, { productId, variants });
          const ue = r.data.productVariantsBulkUpdate.userErrors;
          if (ue.length) errors.push(`${gidToId(productId)}: ${ue.map((e) => e.message).join("; ")}`);
          else updated += chunk.length;
        }
      }
      const errBlock = errors.length ? `\n\n**${errors.length} error(s):**\n` + errors.slice(0, 20).map((e) => `- ${e}`).join("\n") : "";
      return {
        markdown: `Updated ${updated}/${changes.length} variant price(s) across ${byProduct.size} product(s). ${skippedProducts.length} product(s) skipped.${errBlock}`,
        structured: { dryRun: false, updated, changeCount: changes.length, skipped: skippedProducts.length, errors },
        cost: undefined,
      };
    },
  });
}
