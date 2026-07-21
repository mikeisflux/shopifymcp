/**
 * shopify_normalize_print_variants — bulk-normalize art-print products to the
 * standard four-variant set (P / FP / MP / MTC) with fixed titles, prices and
 * weights. Baked-in standard (the live data is NOT a trustworthy source):
 *
 *   pos suffix  option value             price  weight
 *   1   P       11x17 Art Print          20.00  1.2 oz
 *   2   FP      11x17 Foil Art Print     30.00  1.2 oz
 *   3   MP      11x17 Metal Art Print    45.00  14  oz
 *   4   MTC     Metal Trading Card       10.00  1.2 oz
 *
 * MAG (magazine print) variants are left completely untouched.
 * dryRun defaults to true; the plan flags repricing of EXISTING variants
 * separately, since that is the one genuinely destructive action.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ShopifyClient } from "../shopify-client.js";
import { registerTool } from "./shared.js";
import { gidToId, toGid } from "../format.js";

interface StandardSlot {
  suffix: "P" | "FP" | "MP" | "MTC";
  title: string;
  price: string;
  weightOz: number;
}

const STANDARD: StandardSlot[] = [
  { suffix: "P", title: "11x17 Art Print", price: "30.00", weightOz: 1.2 },
  { suffix: "FP", title: "11x17 Foil Art Print", price: "40.00", weightOz: 1.2 },
  { suffix: "MP", title: "11x17 Metal Art Print", price: "55.00", weightOz: 14 },
  { suffix: "MTC", title: "Metal Trading Card", price: "20.00", weightOz: 1.2 },
];
const OPTION_NAME = "Style";
// Longest-match first so MTC/MAG/MP/FP are stripped before the bare P.
const SUFFIX_ORDER = ["MTC", "MAG", "MP", "FP", "P"] as const;

/** Splits a SKU into its stem and recognized suffix (longest-match). */
function splitSku(sku: string): { stem: string; suffix: string | null } {
  for (const suf of SUFFIX_ORDER) {
    if (sku.endsWith(suf)) return { stem: sku.slice(0, sku.length - suf.length), suffix: suf };
  }
  return { stem: sku, suffix: null };
}

// ─── GraphQL ─────────────────────────────────────────────────────────────────

const COLLECTION_PRODUCT_IDS = /* GraphQL */ `
  query NormCollectionProducts($id: ID!, $first: Int!, $after: String) {
    collection(id: $id) {
      products(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id }
      }
    }
  }
`;

const GET_PRODUCT = /* GraphQL */ `
  query NormProduct($id: ID!) {
    product(id: $id) {
      id title
      options { id name optionValues { id name } }
      media(first: 10) { nodes { id } }
      variants(first: 100) {
        nodes {
          id sku price
          selectedOptions { name value }
          media(first: 3) { nodes { id } }
        }
      }
    }
  }
`;

const OPTION_UPDATE = /* GraphQL */ `
  mutation NormOptionUpdate($productId: ID!, $option: OptionUpdateInput!, $optionValuesToUpdate: [OptionValueUpdateInput!]) {
    productOptionUpdate(productId: $productId, option: $option, optionValuesToUpdate: $optionValuesToUpdate) {
      userErrors { field message }
    }
  }
`;

const VARIANTS_CREATE = /* GraphQL */ `
  mutation NormVariantsCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkCreate(productId: $productId, variants: $variants) {
      productVariants { id sku }
      userErrors { field message }
    }
  }
`;

const VARIANTS_UPDATE = /* GraphQL */ `
  mutation NormVariantsUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id sku }
      userErrors { field message }
    }
  }
`;

const APPEND_MEDIA = /* GraphQL */ `
  mutation NormAppendMedia($productId: ID!, $variantMedia: [ProductVariantAppendMediaInput!]!) {
    productVariantAppendMedia(productId: $productId, variantMedia: $variantMedia) {
      userErrors { code field message }
    }
  }
`;

const OPTIONS_REORDER = /* GraphQL */ `
  mutation NormOptionsReorder($productId: ID!, $options: [OptionReorderInput!]!) {
    productOptionsReorder(productId: $productId, options: $options) {
      userErrors { field message }
    }
  }
`;

// ─── Types ───────────────────────────────────────────────────────────────────

interface RawVariant {
  id: string;
  sku: string | null;
  price: string;
  selectedOptions: Array<{ name: string; value: string }>;
  media: { nodes: Array<{ id: string }> };
}
interface RawProduct {
  id: string;
  title: string;
  options: Array<{ id: string; name: string; optionValues: Array<{ id: string; name: string }> }>;
  media: { nodes: Array<{ id: string }> };
  variants: { nodes: RawVariant[] };
}

interface Plan {
  productId: string;
  title: string;
  skip?: string;
  stem?: string;
  optionRename?: { from: string; to: string };
  valueRenames: Array<{ from: string; to: string }>;
  creates: Array<{ sku: string; title: string; price: string }>;
  updates: Array<{ sku: string; setPrice: string; reprice?: { from: string; to: string } }>;
  reorder: string[];
  mediaId?: string;
  leaves: string[];
}

/** Builds the normalization plan for one product (pure — no mutations). */
type PrintPrices = { P?: number; FP?: number; MP?: number; MTC?: number };
/** Resolves a slot's target price: override from `prices` (dollars) or the baked-in default. */
function priceFor(slot: StandardSlot, prices: PrintPrices | undefined): string {
  const o = prices?.[slot.suffix];
  return o !== undefined ? o.toFixed(2) : slot.price;
}

function planProduct(p: RawProduct, prices: PrintPrices | undefined): Plan {
  const plan: Plan = {
    productId: p.id,
    title: p.title,
    valueRenames: [],
    creates: [],
    updates: [],
    reorder: [],
    leaves: [],
  };

  if (p.options.length !== 1) {
    plan.skip = `expected exactly 1 option, found ${p.options.length}`;
    return plan;
  }
  const option = p.options[0]!;

  // Derive stem from standard-suffixed variants; they must agree.
  const stems = new Set<string>();
  const bySuffix = new Map<string, RawVariant>();
  for (const v of p.variants.nodes) {
    if (!v.sku) continue;
    const { stem, suffix } = splitSku(v.sku);
    if (suffix === "MAG") {
      const optVal = v.selectedOptions[0]?.value;
      if (optVal) plan.leaves.push(optVal);
      continue;
    }
    if (suffix && ["P", "FP", "MP", "MTC"].includes(suffix)) {
      stems.add(stem);
      if (!bySuffix.has(suffix)) bySuffix.set(suffix, v);
    }
  }
  if (stems.size === 0) {
    plan.skip = "no standard-suffixed variant (P/FP/MP/MTC) with a SKU found";
    return plan;
  }
  if (stems.size > 1) {
    plan.skip = `ambiguous stem: ${[...stems].join(", ")}`;
    return plan;
  }
  const stem = [...stems][0]!;
  plan.stem = stem;

  if (option.name !== OPTION_NAME) plan.optionRename = { from: option.name, to: OPTION_NAME };

  // Map an option value name -> its id (for renames).
  const valueId = new Map(option.optionValues.map((ov) => [ov.name, ov.id] as const));

  for (const slot of STANDARD) {
    const targetSku = stem + slot.suffix;
    const price = priceFor(slot, prices);
    const existing = bySuffix.get(slot.suffix);
    if (existing) {
      const currentValue = existing.selectedOptions[0]?.value;
      if (currentValue && currentValue !== slot.title && valueId.has(currentValue)) {
        plan.valueRenames.push({ from: currentValue, to: slot.title });
      }
      const upd: Plan["updates"][number] = { sku: targetSku, setPrice: price };
      if (existing.price !== price) upd.reprice = { from: existing.price, to: price };
      plan.updates.push(upd);
    } else {
      plan.creates.push({ sku: targetSku, title: slot.title, price });
    }
  }

  // Reorder: standard titles first, then any leftover (e.g. MAG) values.
  plan.reorder = [...STANDARD.map((s) => s.title), ...plan.leaves];

  // Media: if the product has exactly one image, attach it to all variants.
  if (p.media.nodes.length === 1) plan.mediaId = p.media.nodes[0]!.id;

  return plan;
}

function weightInput(oz: number): Record<string, unknown> {
  return { measurement: { weight: { value: oz, unit: "OUNCES" } } };
}

/** Renders a plan as human-readable Markdown. */
function renderPlan(plan: Plan): string {
  if (plan.skip) return `- **${plan.title}** (${gidToId(plan.productId)}) — SKIPPED: ${plan.skip}`;
  const lines: string[] = [`- **${plan.title}** (${gidToId(plan.productId)}, stem ${plan.stem})`];
  if (plan.optionRename) lines.push(`    - rename option "${plan.optionRename.from}" → "${plan.optionRename.to}"`);
  for (const r of plan.valueRenames) lines.push(`    - rename value "${r.from}" → "${r.to}"`);
  for (const c of plan.creates) lines.push(`    - CREATE ${c.sku} — "${c.title}" @ $${c.price}`);
  for (const u of plan.updates) {
    lines.push(
      `    - update ${u.sku}` + (u.reprice ? ` — ⚠️ REPRICE $${u.reprice.from} → $${u.reprice.to}` : " — price ok"),
    );
  }
  if (plan.leaves.length) lines.push(`    - leave untouched (MAG/other): ${plan.leaves.join(", ")}`);
  return lines.join("\n");
}

/** Executes a plan against Shopify. Returns error strings (empty = success). */
async function executePlan(c: ShopifyClient, plan: Plan): Promise<string[]> {
  const errs: string[] = [];
  const productGid = plan.productId;
  const label = `${plan.title} (${gidToId(productGid)})`;

  // Need the option id for rename/reorder.
  const prodRes = await c.request<{ product: RawProduct | null }>(GET_PRODUCT, { id: productGid });
  const product = prodRes.data.product;
  if (!product || product.options.length !== 1) {
    return [`${label}: could not re-read product/option`];
  }
  const option = product.options[0]!;
  const collect = (ue: Array<{ message: string }> | undefined, step: string) => {
    if (ue && ue.length) errs.push(`${label} [${step}]: ${ue.map((e) => e.message).join("; ")}`);
  };

  // 1. Rename option + existing option values.
  if (plan.optionRename || plan.valueRenames.length) {
    const valueId = new Map(option.optionValues.map((ov) => [ov.name, ov.id] as const));
    const optionValuesToUpdate = plan.valueRenames
      .map((r) => ({ id: valueId.get(r.from), name: r.to }))
      .filter((v) => v.id) as Array<{ id: string; name: string }>;
    const res = await c.request<{ productOptionUpdate: { userErrors: Array<{ message: string }> } }>(
      OPTION_UPDATE,
      {
        productId: productGid,
        option: { id: option.id, name: OPTION_NAME },
        optionValuesToUpdate: optionValuesToUpdate.length ? optionValuesToUpdate : undefined,
      },
    );
    collect(res.data.productOptionUpdate.userErrors, "option-update");
  }

  // 2. Create missing variants (price, sku, weight, tracked off).
  if (plan.creates.length) {
    const variants = plan.creates.map((cr) => ({
      optionValues: [{ optionName: OPTION_NAME, name: cr.title }],
      price: cr.price,
      inventoryItem: { sku: cr.sku, tracked: false, ...weightInput(weightFor(cr.title)) },
    }));
    const res = await c.request<{ productVariantsBulkCreate: { userErrors: Array<{ message: string }> } }>(
      VARIANTS_CREATE,
      { productId: productGid, variants },
    );
    collect(res.data.productVariantsBulkCreate.userErrors, "create");
  }

  // 3. Update existing variants (reprice, sku, weight, tracking off).
  if (plan.updates.length) {
    // Re-read to map target SKUs to variant ids (existing ones only).
    const fresh = await c.request<{ product: RawProduct | null }>(GET_PRODUCT, { id: productGid });
    const idBySku = new Map<string, string>();
    for (const v of fresh.data.product?.variants.nodes ?? []) if (v.sku) idBySku.set(v.sku, v.id);
    const variants: Array<Record<string, unknown>> = [];
    for (const u of plan.updates) {
      // Match the existing variant by its target suffix on the current stem.
      const slot = STANDARD.find((s) => u.sku.endsWith(s.suffix) && plan.stem === u.sku.slice(0, u.sku.length - s.suffix.length));
      const existingId = findExistingVariantId(fresh.data.product, plan.stem!, slot!.suffix);
      if (!existingId) continue;
      variants.push({
        id: existingId,
        price: u.setPrice,
        inventoryItem: { sku: u.sku, tracked: false, ...weightInput(weightFor(slot!.title)) },
      });
    }
    if (variants.length) {
      const res = await c.request<{ productVariantsBulkUpdate: { userErrors: Array<{ message: string }> } }>(
        VARIANTS_UPDATE,
        { productId: productGid, variants },
      );
      collect(res.data.productVariantsBulkUpdate.userErrors, "update");
    }
  }

  // 4. Attach the single image to every variant (after variants exist).
  if (plan.mediaId) {
    const fresh = await c.request<{ product: RawProduct | null }>(GET_PRODUCT, { id: productGid });
    const variantMedia = (fresh.data.product?.variants.nodes ?? [])
      .filter((v) => !v.media.nodes.some((m) => m.id === plan.mediaId))
      .map((v) => ({ variantId: v.id, mediaIds: [plan.mediaId!] }));
    if (variantMedia.length) {
      const res = await c.request<{ productVariantAppendMedia: { userErrors: Array<{ message: string }> } }>(
        APPEND_MEDIA,
        { productId: productGid, variantMedia },
      );
      collect(res.data.productVariantAppendMedia.userErrors, "media");
    }
  }

  // 5. Reorder option values to the standard order (+ leftovers).
  const res = await c.request<{ productOptionsReorder: { userErrors: Array<{ message: string }> } }>(
    OPTIONS_REORDER,
    {
      productId: productGid,
      options: [{ id: option.id, values: plan.reorder.map((name) => ({ name })) }],
    },
  );
  collect(res.data.productOptionsReorder.userErrors, "reorder");

  return errs;
}

function weightFor(title: string): number {
  return STANDARD.find((s) => s.title === title)?.weightOz ?? 1.2;
}

function findExistingVariantId(product: RawProduct | null, stem: string, suffix: string): string | undefined {
  for (const v of product?.variants.nodes ?? []) {
    if (!v.sku) continue;
    const sp = splitSku(v.sku);
    if (sp.stem === stem && sp.suffix === suffix) return v.id;
  }
  return undefined;
}

export function registerNormalizeTools(server: McpServer, client: ShopifyClient): void {
  registerTool(server, client, {
    name: "shopify_normalize_print_variants",
    title: "Normalize art-print variants (bulk)",
    description:
      "Bring art-print products to the standard 4-variant set — P (11x17 Art Print, $20), FP (Foil, " +
      "$30), MP (Metal, $45), MTC (Metal Trading Card, $10) — with correct SKUs, titles, weights, " +
      "option name 'Style', value order, media on every variant, and tracking off. Creates missing " +
      "variants, fixes existing ones, and LEAVES MAG (magazine) variants untouched. Target a single " +
      "productId, a list of productIds, or a whole collectionId. dryRun defaults to TRUE — run it " +
      "first and review the plan (repricing of existing variants is flagged as the destructive part).",
    inputSchema: {
      productId: z.string().optional().describe("Normalize one product (numeric or GID)."),
      productIds: z.array(z.string()).optional().describe("Normalize an explicit list of products."),
      collectionId: z.string().optional().describe("Normalize every product in this collection."),
      dryRun: z
        .boolean()
        .default(true)
        .describe("If true (default), only report the plan and change nothing. Set false to execute."),
      prices: z
        .object({
          P: z.number().positive().optional(),
          FP: z.number().positive().optional(),
          MP: z.number().positive().optional(),
          MTC: z.number().positive().optional(),
        })
        .optional()
        .describe("Override the standard print prices (dollars) per suffix. Omitted suffixes use the built-in defaults (P 30 / FP 40 / MP 55 / MTC 20)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async (args, c) => {
      const targets = [args.productId, args.productIds, args.collectionId].filter(Boolean).length;
      if (targets !== 1) {
        throw new Error("Provide exactly one of productId, productIds, or collectionId.");
      }

      // Resolve product GIDs.
      const productGids: string[] = [];
      if (args.productId) {
        productGids.push(toGid("Product", args.productId));
      } else if (args.productIds) {
        for (const id of args.productIds) productGids.push(toGid("Product", id));
      } else {
        let after: string | null = null;
        do {
          const r: {
            data: {
              collection: {
                products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<{ id: string }> };
              } | null;
            };
          } = await c.request(COLLECTION_PRODUCT_IDS, {
            id: toGid("Collection", args.collectionId!),
            first: 100,
            after,
          });
          if (!r.data.collection) throw new Error(`No collection found with id ${gidToId(args.collectionId!)}.`);
          for (const n of r.data.collection.products.nodes) productGids.push(n.id);
          after = r.data.collection.products.pageInfo.hasNextPage ? r.data.collection.products.pageInfo.endCursor : null;
        } while (after);
      }

      // Plan every product.
      const plans: Plan[] = [];
      for (const gid of productGids) {
        const res = await c.request<{ product: RawProduct | null }>(GET_PRODUCT, { id: gid });
        if (!res.data.product) {
          plans.push({ productId: gid, title: "(not found)", skip: "product not found", valueRenames: [], creates: [], updates: [], reorder: [], leaves: [] });
          continue;
        }
        plans.push(planProduct(res.data.product, args.prices));
      }

      const actionable = plans.filter((p) => !p.skip);
      const skipped = plans.filter((p) => p.skip);
      const totalCreates = actionable.reduce((n, p) => n + p.creates.length, 0);
      const totalReprices = actionable.reduce((n, p) => n + p.updates.filter((u) => u.reprice).length, 0);

      if (args.dryRun) {
        const md =
          `**DRY RUN** — ${actionable.length} product(s) to normalize, ${skipped.length} skipped.\n` +
          `Would create ${totalCreates} variant(s); ⚠️ reprice ${totalReprices} existing variant(s).\n\n` +
          plans.map(renderPlan).join("\n") +
          `\n\n_Nothing was changed. Re-run with dryRun:false to execute._`;
        return {
          markdown: md,
          structured: { dryRun: true, products: plans.length, actionable: actionable.length, skipped: skipped.length, totalCreates, totalReprices, plans },
          cost: undefined,
        };
      }

      // Execute.
      let done = 0;
      const errors: string[] = [];
      for (const plan of actionable) {
        const errs = await executePlan(c, plan);
        if (errs.length) errors.push(...errs);
        else done++;
      }
      const errBlock = errors.length
        ? `\n\n**${errors.length} error(s):**\n` + errors.slice(0, 30).map((e) => `- ${e}`).join("\n")
        : "";
      return {
        markdown:
          `Normalized ${done}/${actionable.length} product(s). Created ${totalCreates} variant(s), ` +
          `repriced ${totalReprices} existing. ${skipped.length} skipped.` + errBlock,
        structured: { dryRun: false, normalized: done, actionable: actionable.length, skipped: skipped.length, totalCreates, totalReprices, errors, skippedProducts: skipped.map((s) => ({ id: gidToId(s.productId), reason: s.skip })) },
        cost: undefined,
      };
    },
  });
}
