/**
 * shopify_normalize_book_variants — normalize comic *book* products to the
 * standard five-cover variant set, MERGING standalone sibling products (e.g. a
 * separate "B1-01F Foil" listing) into the base product as a variant, carrying
 * their inventory across, then deleting the emptied sibling.
 *
 *   suffix  option value ("Cover")   price
 *   (bare)  Regular                  15.00
 *   F       Foil                     35.00
 *   M       Metal                    55.00
 *   GITD    Glow in the Dark         55.00
 *   RM      Raised Metal             55.00
 *
 * SAFETY: this is destructive and moves live stock. dryRun defaults to true and
 * reports deletes / inventory-moves / reprices as separate sections. On execute,
 * a sibling is deleted ONLY after the carried stock is verified present on the
 * new variant — a failure leaves a duplicate product, never lost inventory.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ShopifyClient } from "../shopify-client.js";
import { registerTool } from "./shared.js";
import { gidToId, toGid } from "../format.js";

interface Slot {
  suffix: string; // "" for the bare Regular
  title: string;
  price: string;
}
const BOOK_STANDARD: Slot[] = [
  { suffix: "", title: "Regular", price: "15.00" },
  { suffix: "F", title: "Foil", price: "35.00" },
  { suffix: "M", title: "Metal", price: "55.00" },
  { suffix: "GITD", title: "Glow in the Dark", price: "55.00" },
  { suffix: "RM", title: "Raised Metal", price: "55.00" },
];
const OPTION_NAME = "Cover";
const DEFAULT_EXCLUDE_NAMES = ["LTD", "Exclusive", "Sketch", "Damaged", "Pin-Up"];
// Longest-match first. Bare stem = Regular.
const SUFFIX_ORDER = ["GITD", "RM", "F", "M"] as const;
// SKUs that are not numbered covers — never merged or normalized.
const SKIP_TOKENS = ["BLANK", "CYC", "SHAFT"];

function splitBookSku(sku: string): { stem: string; suffix: string } {
  for (const suf of SUFFIX_ORDER) {
    if (sku.endsWith(suf)) return { stem: sku.slice(0, sku.length - suf.length), suffix: suf };
  }
  return { stem: sku, suffix: "" };
}
function isSkippable(sku: string): boolean {
  const upper = sku.toUpperCase();
  return SKIP_TOKENS.some((t) => upper.includes(t));
}
function slotFor(suffix: string): Slot | undefined {
  return BOOK_STANDARD.find((s) => s.suffix === suffix);
}

// ─── GraphQL ─────────────────────────────────────────────────────────────────

const COLLECTION_PRODUCT_IDS = /* GraphQL */ `
  query BookCollectionProducts($id: ID!, $first: Int!, $after: String) {
    collection(id: $id) {
      products(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id }
      }
    }
  }
`;

const GET_PRODUCT = /* GraphQL */ `
  query BookProduct($id: ID!) {
    product(id: $id) {
      id title
      options { id name optionValues { id name } }
      media(first: 10) { nodes { id } }
      variants(first: 25) {
        nodes {
          id sku price
          selectedOptions { name value }
          media(first: 3) { nodes { id } }
          inventoryItem {
            id
            measurement { weight { value unit } }
            inventoryLevels(first: 20) {
              nodes { location { id name } quantities(names: ["available"]) { name quantity } }
            }
          }
        }
      }
    }
  }
`;

const OPTION_UPDATE = /* GraphQL */ `
  mutation BookOptionUpdate($productId: ID!, $option: OptionUpdateInput!, $optionValuesToUpdate: [OptionValueUpdateInput!]) {
    productOptionUpdate(productId: $productId, option: $option, optionValuesToUpdate: $optionValuesToUpdate) {
      userErrors { field message }
    }
  }
`;

const VARIANTS_CREATE = /* GraphQL */ `
  mutation BookVariantsCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkCreate(productId: $productId, variants: $variants) {
      productVariants { id sku inventoryItem { id } }
      userErrors { field message }
    }
  }
`;

const VARIANTS_UPDATE = /* GraphQL */ `
  mutation BookVariantsUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id sku }
      userErrors { field message }
    }
  }
`;

const INVENTORY_ACTIVATE = /* GraphQL */ `
  mutation BookInventoryActivate($inventoryItemId: ID!, $locationId: ID!, $available: Int, $idempotencyKey: String!) {
    inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId, available: $available) @idempotent(key: $idempotencyKey) {
      inventoryLevel { quantities(names: ["available"]) { name quantity } }
      userErrors { field message }
    }
  }
`;

const APPEND_MEDIA = /* GraphQL */ `
  mutation BookAppendMedia($productId: ID!, $variantMedia: [ProductVariantAppendMediaInput!]!) {
    productVariantAppendMedia(productId: $productId, variantMedia: $variantMedia) {
      userErrors { code field message }
    }
  }
`;

const OPTIONS_REORDER = /* GraphQL */ `
  mutation BookOptionsReorder($productId: ID!, $options: [OptionReorderInput!]!) {
    productOptionsReorder(productId: $productId, options: $options) {
      userErrors { field message }
    }
  }
`;

const PRODUCT_DELETE = /* GraphQL */ `
  mutation BookProductDelete($id: ID!) {
    productDelete(input: { id: $id }) {
      deletedProductId
      userErrors { field message }
    }
  }
`;

const VARIANT_INV = /* GraphQL */ `
  query BookVariantInv($id: ID!) {
    productVariant(id: $id) {
      inventoryItem {
        id
        inventoryLevels(first: 20) {
          nodes { location { id name } quantities(names: ["available"]) { name quantity } }
        }
      }
    }
  }
`;

// ─── Types ───────────────────────────────────────────────────────────────────

interface InvLevel { locationId: string; locationName: string; available: number }
interface RawVariant {
  id: string;
  sku: string | null;
  price: string;
  selectedOptions: Array<{ name: string; value: string }>;
  media: { nodes: Array<{ id: string }> };
  inventoryItem: {
    id: string;
    measurement: { weight: { value: number; unit: string } | null } | null;
    inventoryLevels: { nodes: Array<{ location: { id: string; name: string }; quantities: Array<{ name: string; quantity: number }> }> };
  } | null;
}

interface Weights { base?: number; F?: number; M?: number; GITD?: number; RM?: number }
function weightForSuffix(weights: Weights | undefined, suffix: string): number | undefined {
  if (!weights) return undefined;
  const key = suffix === "" ? "base" : suffix;
  return (weights as Record<string, number | undefined>)[key];
}
function weightInput(oz: number): Record<string, unknown> {
  return { measurement: { weight: { value: oz, unit: "OUNCES" } } };
}
/** Current weight in ounces, or null if unset / a non-ounce unit. */
function currentWeightOz(v: RawVariant): number | null {
  const w = v.inventoryItem?.measurement?.weight;
  if (!w || w.unit !== "OUNCES") return null;
  return w.value;
}
interface RawProduct {
  id: string;
  title: string;
  options: Array<{ id: string; name: string; optionValues: Array<{ id: string; name: string }> }>;
  media: { nodes: Array<{ id: string }> };
  variants: { nodes: RawVariant[] };
}

interface Merge { siblingId: string; siblingTitle: string; suffix: string; title: string; price: string; weightOz?: number; levels: InvLevel[]; total: number }
interface GroupPlan {
  stem: string;
  primaryId: string;
  primaryTitle: string;
  optionRename?: { from: string; to: string };
  valueRenames: Array<{ from: string; to: string }>;
  merges: Merge[];
  creates: Array<{ suffix: string; title: string; price: string; weightOz?: number }>;
  updates: Array<{ suffix: string; sku: string; setPrice: string; reprice?: { from: string; to: string }; weightOz?: number; reweight?: { from: number | null; to: number } }>;
  reorder: string[];
  mediaId?: string;
}
interface Skip { id: string; title: string; reason: string }

function levelsOf(v: RawVariant): InvLevel[] {
  return (v.inventoryItem?.inventoryLevels.nodes ?? []).map((n) => ({
    locationId: n.location.id,
    locationName: n.location.name,
    available: n.quantities.find((q) => q.name === "available")?.quantity ?? 0,
  }));
}

/** Builds the plan for the whole collection: groups products by stem and merges siblings. */
function planCollection(
  products: RawProduct[],
  excludeAbovePrice: number | undefined,
  weights: Weights | undefined,
  excludeNames: string[],
): { groups: GroupPlan[]; skips: Skip[] } {
  const skips: Skip[] = [];
  const excludeTerms = excludeNames.map((t) => t.toLowerCase()).filter((t) => t.length > 0);

  // Derive each product's stem (from non-skippable, single-option variants).
  const byStem = new Map<string, RawProduct[]>();
  for (const p of products) {
    // Name exclusion: leave special covers (LTD/Exclusive/Sketch/Damaged/Pin-Up,
    // by title or option value) untouched so they don't get re-normalized.
    if (excludeTerms.length > 0) {
      const haystack = [
        p.title,
        ...p.options.flatMap((o) => o.optionValues.map((v) => v.name)),
        ...p.variants.nodes.flatMap((v) => v.selectedOptions.map((s) => s.value)),
      ]
        .join(" | ")
        .toLowerCase();
      const hit = excludeTerms.find((t) => haystack.includes(t));
      if (hit) {
        skips.push({ id: p.id, title: p.title, reason: `excluded by name: contains "${hit}"` });
        continue;
      }
    }
    // Price exclusion: leave premium/special products (a variant above the
    // threshold) completely untouched — never reprice or merge them.
    if (excludeAbovePrice != null) {
      const over = p.variants.nodes.find((v) => Number.parseFloat(v.price) > excludeAbovePrice);
      if (over) {
        skips.push({
          id: p.id,
          title: p.title,
          reason: `excluded: variant ${over.sku ?? "(no sku)"} price $${over.price} > $${excludeAbovePrice}`,
        });
        continue;
      }
    }
    if (p.options.length !== 1) {
      skips.push({ id: p.id, title: p.title, reason: `expected 1 option, found ${p.options.length}` });
      continue;
    }
    const skus = p.variants.nodes.map((v) => v.sku).filter((s): s is string => !!s);
    if (skus.length === 0) {
      skips.push({ id: p.id, title: p.title, reason: "no SKUs" });
      continue;
    }
    if (skus.every(isSkippable)) {
      skips.push({ id: p.id, title: p.title, reason: `non-cover SKU (BLANK/CYC/SHAFT): ${skus[0]}` });
      continue;
    }
    const stems = new Set(skus.filter((s) => !isSkippable(s)).map((s) => splitBookSku(s).stem));
    if (stems.size !== 1) {
      skips.push({ id: p.id, title: p.title, reason: `ambiguous stem: ${[...stems].join(", ")}` });
      continue;
    }
    const stem = [...stems][0]!;
    (byStem.get(stem) ?? byStem.set(stem, []).get(stem)!).push(p);
  }

  const groups: GroupPlan[] = [];
  for (const [stem, group] of byStem) {
    // Primary = the product holding the bare Regular variant (sku === stem).
    const primaries = group.filter((p) => p.variants.nodes.some((v) => v.sku === stem));
    if (primaries.length === 0) {
      for (const p of group) skips.push({ id: p.id, title: p.title, reason: `no Regular (base ${stem}) product in group` });
      continue;
    }
    if (primaries.length > 1) {
      for (const p of group) skips.push({ id: p.id, title: p.title, reason: `multiple base products for stem ${stem}` });
      continue;
    }
    const primary = primaries[0]!;
    const option = primary.options[0]!;
    const siblings = group.filter((p) => p.id !== primary.id);

    const plan: GroupPlan = {
      stem,
      primaryId: primary.id,
      primaryTitle: primary.title,
      valueRenames: [],
      merges: [],
      creates: [],
      updates: [],
      reorder: BOOK_STANDARD.map((s) => s.title),
    };
    if (option.name !== OPTION_NAME) plan.optionRename = { from: option.name, to: OPTION_NAME };
    const valueId = new Map(option.optionValues.map((ov) => [ov.name, ov.id] as const));

    // Existing suffixes already on the primary.
    const primaryBySuffix = new Map<string, RawVariant>();
    for (const v of primary.variants.nodes) {
      if (!v.sku || isSkippable(v.sku)) continue;
      const { suffix } = splitBookSku(v.sku);
      if (slotFor(suffix)) primaryBySuffix.set(suffix, v);
    }
    // Siblings grouped by the suffix they provide.
    const siblingBySuffix = new Map<string, RawProduct>();
    for (const sib of siblings) {
      const sku = sib.variants.nodes.map((v) => v.sku).find((s): s is string => !!s && !isSkippable(s));
      if (!sku) { skips.push({ id: sib.id, title: sib.title, reason: "sibling has no cover SKU" }); continue; }
      const { suffix } = splitBookSku(sku);
      if (!slotFor(suffix) || suffix === "") { skips.push({ id: sib.id, title: sib.title, reason: `sibling suffix "${suffix}" not a standard non-base cover` }); continue; }
      if (primaryBySuffix.has(suffix) || siblingBySuffix.has(suffix)) { skips.push({ id: sib.id, title: sib.title, reason: `duplicate ${suffix} for stem ${stem}` }); continue; }
      siblingBySuffix.set(suffix, sib);
    }

    for (const slot of BOOK_STANDARD) {
      const w = weightForSuffix(weights, slot.suffix);
      const existing = primaryBySuffix.get(slot.suffix);
      if (existing) {
        const cur = existing.selectedOptions[0]?.value;
        if (cur && cur !== slot.title && valueId.has(cur)) plan.valueRenames.push({ from: cur, to: slot.title });
        const upd: GroupPlan["updates"][number] = { suffix: slot.suffix, sku: stem + slot.suffix, setPrice: slot.price };
        if (existing.price !== slot.price) upd.reprice = { from: existing.price, to: slot.price };
        if (w !== undefined) {
          upd.weightOz = w;
          const curW = currentWeightOz(existing);
          if (curW !== w) upd.reweight = { from: curW, to: w };
        }
        plan.updates.push(upd);
        continue;
      }
      const sib = siblingBySuffix.get(slot.suffix);
      if (sib) {
        const v = sib.variants.nodes.find((x) => x.sku && !isSkippable(x.sku))!;
        const levels = levelsOf(v).filter((l) => l.available > 0);
        plan.merges.push({
          siblingId: sib.id,
          siblingTitle: sib.title,
          suffix: slot.suffix,
          title: slot.title,
          price: slot.price,
          weightOz: w,
          levels,
          total: levels.reduce((n, l) => n + l.available, 0),
        });
        continue;
      }
      // Regular must exist on primary; any other missing slot is a plain create.
      if (slot.suffix !== "") plan.creates.push({ suffix: slot.suffix, title: slot.title, price: slot.price, weightOz: w });
    }

    if (primary.media.nodes.length === 1) plan.mediaId = primary.media.nodes[0]!.id;
    groups.push(plan);
  }

  return { groups, skips };
}

function renderGroup(g: GroupPlan): string {
  const l: string[] = [`- **${g.primaryTitle}** (${gidToId(g.primaryId)}, stem ${g.stem})`];
  if (g.optionRename) l.push(`    - rename option "${g.optionRename.from}" → "${g.optionRename.to}"`);
  for (const r of g.valueRenames) l.push(`    - rename value "${r.from}" → "${r.to}"`);
  for (const m of g.merges) {
    l.push(`    - 🔀 MERGE ${m.title} from "${m.siblingTitle}" (${gidToId(m.siblingId)}) → create ${g.stem}${m.suffix} @ $${m.price}`);
    for (const lv of m.levels) l.push(`        - 📦 MOVE ${lv.available} units @ ${lv.locationName}`);
    l.push(`        - 🗑️ DELETE product ${gidToId(m.siblingId)} after stock verified (was ${m.total} units)`);
  }
  for (const c of g.creates) l.push(`    - CREATE ${g.stem}${c.suffix} — "${c.title}" @ $${c.price} (0 stock${c.weightOz !== undefined ? `, ${c.weightOz} oz` : ""})`);
  for (const u of g.updates) {
    const parts = [u.reprice ? `⚠️ REPRICE $${u.reprice.from} → $${u.reprice.to}` : "price ok"];
    if (u.reweight) parts.push(`weight ${u.reweight.from ?? "unset"} → ${u.reweight.to} oz`);
    l.push(`    - update ${u.sku} — ${parts.join(", ")}`);
  }
  return l.join("\n");
}

async function readVariantTotal(c: ShopifyClient, variantId: string): Promise<number> {
  const res = await c.request<{
    productVariant: { inventoryItem: { inventoryLevels: { nodes: Array<{ quantities: Array<{ name: string; quantity: number }> }> } } | null } | null;
  }>(VARIANT_INV, { id: variantId });
  const nodes = res.data.productVariant?.inventoryItem?.inventoryLevels.nodes ?? [];
  return nodes.reduce((n, lvl) => n + (lvl.quantities.find((q) => q.name === "available")?.quantity ?? 0), 0);
}

async function executeGroup(c: ShopifyClient, g: GroupPlan): Promise<string[]> {
  const errs: string[] = [];
  const label = `${g.primaryTitle} (${gidToId(g.primaryId)})`;
  const collect = (ue: Array<{ message: string }> | undefined, step: string) => {
    if (ue && ue.length) errs.push(`${label} [${step}]: ${ue.map((e) => e.message).join("; ")}`);
  };
  const optRes = await c.request<{ product: RawProduct | null }>(GET_PRODUCT, { id: g.primaryId });
  const option = optRes.data.product?.options[0];
  if (!option) return [`${label}: could not re-read option`];

  // 1. Option + value renames.
  if (g.optionRename || g.valueRenames.length) {
    const vid = new Map(option.optionValues.map((ov) => [ov.name, ov.id] as const));
    const ovu = g.valueRenames.map((r) => ({ id: vid.get(r.from), name: r.to })).filter((v) => v.id) as Array<{ id: string; name: string }>;
    const r = await c.request<{ productOptionUpdate: { userErrors: Array<{ message: string }> } }>(OPTION_UPDATE, {
      productId: g.primaryId,
      option: { id: option.id, name: OPTION_NAME },
      optionValuesToUpdate: ovu.length ? ovu : undefined,
    });
    collect(r.data.productOptionUpdate.userErrors, "option");
  }

  // 2. Create non-merged missing variants (tracked, 0 stock).
  if (g.creates.length) {
    const variants = g.creates.map((cr) => ({
      optionValues: [{ optionName: OPTION_NAME, name: cr.title }],
      price: cr.price,
      inventoryItem: {
        sku: g.stem + cr.suffix,
        tracked: true,
        ...(cr.weightOz !== undefined ? weightInput(cr.weightOz) : {}),
      },
    }));
    const r = await c.request<{ productVariantsBulkCreate: { userErrors: Array<{ message: string }> } }>(VARIANTS_CREATE, { productId: g.primaryId, variants });
    collect(r.data.productVariantsBulkCreate.userErrors, "create");
  }

  // 3. Merges — create variant, seed carried stock, VERIFY, then delete sibling.
  for (const m of g.merges) {
    const created = await c.request<{
      productVariantsBulkCreate: { productVariants: Array<{ id: string; sku: string | null; inventoryItem: { id: string } | null }> | null; userErrors: Array<{ message: string }> };
    }>(VARIANTS_CREATE, {
      productId: g.primaryId,
      variants: [{
        optionValues: [{ optionName: OPTION_NAME, name: m.title }],
        price: m.price,
        inventoryItem: { sku: g.stem + m.suffix, tracked: true, ...(m.weightOz !== undefined ? weightInput(m.weightOz) : {}) },
      }],
    });
    if (created.data.productVariantsBulkCreate.userErrors.length) {
      collect(created.data.productVariantsBulkCreate.userErrors, `merge-create ${m.suffix}`);
      continue; // do not delete sibling
    }
    const newVariant = created.data.productVariantsBulkCreate.productVariants?.[0];
    const invItemId = newVariant?.inventoryItem?.id;
    if (!newVariant || !invItemId) { errs.push(`${label} [merge ${m.suffix}]: created variant missing inventory item; sibling NOT deleted`); continue; }

    // Seed carried stock per location.
    let seedError = false;
    for (const lv of m.levels) {
      const r = await c.request<{ inventoryActivate: { userErrors: Array<{ message: string }> } }>(INVENTORY_ACTIVATE, {
        inventoryItemId: invItemId,
        locationId: lv.locationId,
        available: lv.available,
        idempotencyKey: randomUUID(),
      });
      if (r.data.inventoryActivate.userErrors.length) { collect(r.data.inventoryActivate.userErrors, `merge-seed ${m.suffix}@${lv.locationName}`); seedError = true; }
    }
    if (seedError) { errs.push(`${label} [merge ${m.suffix}]: seeding failed; sibling ${gidToId(m.siblingId)} NOT deleted (no stock lost)`); continue; }

    // Verify the new variant holds the full carried amount before deleting.
    const landed = await readVariantTotal(c, newVariant.id);
    if (landed !== m.total) {
      errs.push(`${label} [merge ${m.suffix}]: verification failed (expected ${m.total}, found ${landed}); sibling ${gidToId(m.siblingId)} NOT deleted`);
      continue;
    }
    const del = await c.request<{ productDelete: { userErrors: Array<{ message: string }> } }>(PRODUCT_DELETE, { id: m.siblingId });
    collect(del.data.productDelete.userErrors, `delete ${gidToId(m.siblingId)}`);
  }

  // 4. Reprice/fix existing variants.
  if (g.updates.length) {
    const fresh = await c.request<{ product: RawProduct | null }>(GET_PRODUCT, { id: g.primaryId });
    const idBySuffix = new Map<string, string>();
    for (const v of fresh.data.product?.variants.nodes ?? []) {
      if (!v.sku || isSkippable(v.sku)) continue;
      const sp = splitBookSku(v.sku);
      if (sp.stem === g.stem && slotFor(sp.suffix)) idBySuffix.set(sp.suffix, v.id);
    }
    const variants: Array<Record<string, unknown>> = [];
    for (const u of g.updates) {
      const id = idBySuffix.get(u.suffix);
      if (!id) continue;
      variants.push({
        id,
        price: u.setPrice,
        inventoryItem: { sku: u.sku, ...(u.weightOz !== undefined ? weightInput(u.weightOz) : {}) },
      });
    }
    if (variants.length) {
      const r = await c.request<{ productVariantsBulkUpdate: { userErrors: Array<{ message: string }> } }>(VARIANTS_UPDATE, { productId: g.primaryId, variants });
      collect(r.data.productVariantsBulkUpdate.userErrors, "update");
    }
  }

  // 5. Attach the single product image to every variant.
  if (g.mediaId) {
    const fresh = await c.request<{ product: RawProduct | null }>(GET_PRODUCT, { id: g.primaryId });
    const variantMedia = (fresh.data.product?.variants.nodes ?? [])
      .filter((v) => !v.media.nodes.some((mm) => mm.id === g.mediaId))
      .map((v) => ({ variantId: v.id, mediaIds: [g.mediaId!] }));
    if (variantMedia.length) {
      const r = await c.request<{ productVariantAppendMedia: { userErrors: Array<{ message: string }> } }>(APPEND_MEDIA, { productId: g.primaryId, variantMedia });
      collect(r.data.productVariantAppendMedia.userErrors, "media");
    }
  }

  // 6. Reorder covers.
  const r = await c.request<{ productOptionsReorder: { userErrors: Array<{ message: string }> } }>(OPTIONS_REORDER, {
    productId: g.primaryId,
    options: [{ id: option.id, values: g.reorder.map((name) => ({ name })) }],
  });
  collect(r.data.productOptionsReorder.userErrors, "reorder");

  return errs;
}

export function registerNormalizeBookTools(server: McpServer, client: ShopifyClient): void {
  registerTool(server, client, {
    name: "shopify_normalize_book_variants",
    title: "Normalize book variants + merge foils (bulk)",
    description:
      "Normalize comic-book products in a collection to the standard 5 covers — Regular $15 / Foil " +
      "$35 / Metal $55 / Glow in the Dark $55 / Raised Metal $55, option 'Cover' — MERGING standalone " +
      "sibling listings (e.g. a separate Foil product) into the base product as a variant, carrying " +
      "their inventory across, then DELETING the emptied sibling. BLANK/CYC/SHAFT and -2ND covers are " +
      "handled as their own sets, never merged. dryRun defaults to TRUE and reports deletes, " +
      "inventory moves, and reprices separately — review them before executing. On execute, a sibling " +
      "is deleted only AFTER its carried stock is verified on the new variant (a failure leaves a " +
      "duplicate, never lost stock).",
    inputSchema: {
      collectionId: z.string().describe("Collection whose book products to normalize (numeric or GID)."),
      dryRun: z
        .boolean()
        .default(true)
        .describe("If true (default), report the full plan and change nothing. Set false to execute."),
      excludeAbovePrice: z
        .number()
        .positive()
        .optional()
        .describe(
          "Skip (leave untouched) any product that has a variant priced above this amount — e.g. 75 " +
            "excludes premium/special covers so they're never repriced to the standard set or merged.",
        ),
      weights: z
        .object({
          base: z.number().positive().optional().describe("Regular cover weight (oz)."),
          F: z.number().positive().optional().describe("Foil weight (oz)."),
          M: z.number().positive().optional().describe("Metal weight (oz)."),
          GITD: z.number().positive().optional().describe("Glow in the Dark weight (oz)."),
          RM: z.number().positive().optional().describe("Raised Metal weight (oz)."),
        })
        .optional()
        .describe(
          "Per-cover weight in OUNCES, applied to EVERY variant the tool touches — existing ones too, " +
            "not just newly-created. Omit to leave weights unchanged; omit individual keys to leave " +
            "those covers unchanged.",
        ),
      excludeNames: z
        .array(z.string())
        .default(DEFAULT_EXCLUDE_NAMES)
        .describe(
          "Skip (leave untouched) any product whose title or an option value contains one of these " +
            "(case-insensitive substring). Defaults to LTD/Exclusive/Sketch/Damaged/Pin-Up so special " +
            "covers aren't normalized. Pass your own list to override; pass [] to disable.",
        ),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    handler: async (args, c) => {
      // Gather product ids in the collection.
      const productGids: string[] = [];
      let after: string | null = null;
      do {
        const r: {
          data: { collection: { products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<{ id: string }> } } | null };
        } = await c.request(COLLECTION_PRODUCT_IDS, { id: toGid("Collection", args.collectionId), first: 100, after });
        if (!r.data.collection) throw new Error(`No collection found with id ${gidToId(args.collectionId)}.`);
        for (const n of r.data.collection.products.nodes) productGids.push(n.id);
        after = r.data.collection.products.pageInfo.hasNextPage ? r.data.collection.products.pageInfo.endCursor : null;
      } while (after);

      // Load full detail for each product.
      const products: RawProduct[] = [];
      for (const gid of productGids) {
        const r = await c.request<{ product: RawProduct | null }>(GET_PRODUCT, { id: gid });
        if (r.data.product) products.push(r.data.product);
      }

      const { groups, skips } = planCollection(products, args.excludeAbovePrice, args.weights, args.excludeNames ?? DEFAULT_EXCLUDE_NAMES);
      const deletes = groups.flatMap((g) => g.merges.map((m) => m));
      const totalMoves = deletes.reduce((n, m) => n + m.levels.length, 0);
      const totalUnits = deletes.reduce((n, m) => n + m.total, 0);
      const totalReprices = groups.reduce((n, g) => n + g.updates.filter((u) => u.reprice).length, 0);
      const totalCreates = groups.reduce((n, g) => n + g.creates.length, 0);

      if (args.dryRun) {
        const md =
          `**DRY RUN — ${groups.length} base product(s), ${skips.length} skipped**\n` +
          `- 🗑️ Would DELETE ${deletes.length} sibling product(s) (after stock verified)\n` +
          `- 📦 Would MOVE stock: ${totalUnits} unit(s) across ${totalMoves} location-transfer(s)\n` +
          `- ⚠️ Would REPRICE ${totalReprices} existing variant(s)\n` +
          `- Would CREATE ${totalCreates} empty variant(s)\n\n` +
          groups.map(renderGroup).join("\n") +
          (skips.length ? `\n\n**Skipped:**\n` + skips.map((s) => `- ${s.title} (${gidToId(s.id)}): ${s.reason}`).join("\n") : "") +
          `\n\n_Nothing was changed. Re-run with dryRun:false to execute._`;
        return {
          markdown: md,
          structured: { dryRun: true, groups: groups.length, skipped: skips.length, deletes: deletes.map((m) => ({ siblingId: gidToId(m.siblingId), suffix: m.suffix, units: m.total })), totalUnits, totalReprices, totalCreates, plan: groups, skips: skips.map((s) => ({ id: gidToId(s.id), reason: s.reason })) },
          cost: undefined,
        };
      }

      let done = 0;
      const errors: string[] = [];
      for (const g of groups) {
        const e = await executeGroup(c, g);
        if (e.length) errors.push(...e);
        else done++;
      }
      const errBlock = errors.length ? `\n\n**${errors.length} issue(s):**\n` + errors.slice(0, 40).map((e) => `- ${e}`).join("\n") : "";
      return {
        markdown:
          `Normalized ${done}/${groups.length} base product(s). Moved ${totalUnits} unit(s), ` +
          `repriced ${totalReprices}, created ${totalCreates}. ${skips.length} skipped.` + errBlock,
        structured: { dryRun: false, normalized: done, groups: groups.length, skipped: skips.length, totalUnits, totalReprices, totalCreates, errors },
        cost: undefined,
      };
    },
  });
}
