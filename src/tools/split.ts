/**
 * shopify_bulk_split_variants_to_products — turn every variant of every product
 * in the source collection(s) into its own single-variant product (for eBay's
 * one-listing-per-cover sync), add them all to a destination collection, then
 * optionally act on the original.
 *
 * Per new product: title "{base}{sep}{variant}{suffix}", flat price, SKU
 * "{original-or-derived}{suffix}", parent's product_type + tags, parent's
 * image(s). The suffix (default "-ebaylive") keeps titles/SKUs/handles from
 * colliding with the originals when those are left live. Quantity is NOT set
 * here — run shopify_bulk_set_inventory_quantity on the destination afterward.
 *
 * The original is left/drafted/archived/deleted per originalProductAction, but
 * only after ALL its variants split successfully. dryRun defaults TRUE.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ShopifyClient } from "../shopify-client.js";
import { registerTool } from "./shared.js";
import { gidToId, toGid } from "../format.js";

const MAX_PRODUCTS = 300;
const DEFAULT_DELAY_MS = 500;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const COLLECTIONS_SEARCH = /* GraphQL */ `
  query SplitCollectionsSearch($query: String!, $first: Int!) {
    collections(first: $first, query: $query) { nodes { id title } }
  }
`;

const COLLECTION_CREATE = /* GraphQL */ `
  mutation SplitCollectionCreate($input: CollectionInput!) {
    collectionCreate(input: $input) { collection { id title } userErrors { field message } }
  }
`;

const SOURCE_PRODUCTS = /* GraphQL */ `
  query SplitSource($id: ID!, $first: Int!, $after: String) {
    collection(id: $id) {
      id title
      products(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id title productType tags
          media(first: 25) { nodes { mediaContentType ... on MediaImage { image { url altText } } } }
          variants(first: 100) { nodes { id title sku } }
        }
      }
    }
  }
`;

const PRODUCT_CREATE = /* GraphQL */ `
  mutation SplitProductCreate($input: ProductInput!, $media: [CreateMediaInput!]) {
    productCreate(input: $input, media: $media) {
      product { id title variants(first: 1) { nodes { id } } }
      userErrors { field message }
    }
  }
`;

const VARIANT_UPDATE = /* GraphQL */ `
  mutation SplitVariantUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id }
      userErrors { field message }
    }
  }
`;

const COLLECTION_ADD = /* GraphQL */ `
  mutation SplitCollectionAdd($id: ID!, $productIds: [ID!]!) {
    collectionAddProducts(id: $id, productIds: $productIds) {
      collection { id }
      userErrors { field message }
    }
  }
`;

const PRODUCT_STATUS = /* GraphQL */ `
  mutation SplitProductStatus($product: ProductUpdateInput!) {
    productUpdate(product: $product) { product { id status } userErrors { field message } }
  }
`;

const PRODUCT_DELETE = /* GraphQL */ `
  mutation SplitProductDelete($id: ID!) {
    productDelete(input: { id: $id }) { deletedProductId userErrors { field message } }
  }
`;

interface SrcProduct {
  id: string; title: string; productType: string; tags: string[];
  media: { nodes: Array<{ mediaContentType: string; image?: { url: string; altText: string | null } }> };
  variants: { nodes: Array<{ id: string; title: string; sku: string | null }> };
}

/** Slug-safe base used when a variant has no SKU. */
function sanitizeSkuBase(s: string): string {
  return s.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9._-]/g, "");
}

export function registerSplitTools(server: McpServer, client: ShopifyClient): void {
  registerTool(server, client, {
    name: "shopify_bulk_split_variants_to_products",
    title: "Ebay Live Splitoff",
    description:
      "For every product in the source collection(s), create one single-variant product per variant — " +
      "titled \"{base}{sep}{variant}{suffix}\", flat `price`, SKU \"{original-or-derived}{suffix}\", " +
      "carrying the parent's product_type + tags and copying the parent's image — then add all new " +
      "products to a destination collection (created if missing). The `suffix` (default \"-ebaylive\") " +
      "prevents title/SKU/handle collisions with originals left live. Quantity is NOT set here — run " +
      "shopify_bulk_set_inventory_quantity on the destination afterward. The original is left/drafted/" +
      "archived/deleted per originalProductAction, only after ALL its variants split. Provide exactly one " +
      `of sourceCollectionIds or sourceCollectionTitleContains. dryRun defaults TRUE. Cap ${MAX_PRODUCTS} ` +
      "source products per call — batch larger jobs (e.g. per series).",
    inputSchema: {
      sourceCollectionIds: z.array(z.string()).optional().describe("Explicit source collection ids (numeric or GID)."),
      sourceCollectionTitleContains: z.array(z.string()).optional().describe('Match collections whose title contains any of these, e.g. ["Main Books","Main Prints"].'),
      destinationCollectionTitle: z.string().default("EBAYLIVE").describe("Destination collection title. Created (manual) if missing. Default EBAYLIVE."),
      titleSeparator: z.string().default(" ").describe('Joins base + variant title. Default " ".'),
      suffix: z.string().default("-ebaylive").describe('Appended to every new title AND SKU to avoid collisions. Default "-ebaylive". Pass "" for none.'),
      price: z.string().default("5.00").describe('Flat price for every new product, e.g. "5.00".'),
      copyImages: z.enum(["featured", "all"]).default("featured").describe('"featured" copies the parent\'s first image to every split (the ask); "all" copies every image.'),
      newProductStatus: z.enum(["ACTIVE", "DRAFT"]).default("ACTIVE").describe("Status for the new products. Default ACTIVE."),
      originalProductAction: z.enum(["leave", "draft", "archive", "delete"]).default("leave").describe("What to do with each source product after its variants split. Default leave."),
      dryRun: z.boolean().default(true).describe("If true (default), list the new products that would be created without creating anything."),
      delayMs: z.number().int().min(0).max(5000).default(DEFAULT_DELAY_MS).describe("Delay between calls (ms). Default 500."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    handler: async (args, c) => {
      // Defensive defaults (the runtime applies zod defaults, but never let the
      // destructive path run with an undefined dryRun / suffix / price).
      args = {
        ...args,
        titleSeparator: args.titleSeparator ?? " ",
        suffix: args.suffix ?? "-ebaylive",
        price: args.price ?? "5.00",
        copyImages: args.copyImages ?? "featured",
        newProductStatus: args.newProductStatus ?? "ACTIVE",
        originalProductAction: args.originalProductAction ?? "leave",
        dryRun: args.dryRun ?? true,
        delayMs: args.delayMs ?? DEFAULT_DELAY_MS,
        destinationCollectionTitle: args.destinationCollectionTitle ?? "EBAYLIVE",
      };
      const hasIds = Boolean(args.sourceCollectionIds?.length);
      const hasTitles = Boolean(args.sourceCollectionTitleContains?.length);
      if (hasIds === hasTitles) throw new Error("Provide exactly one of sourceCollectionIds or sourceCollectionTitleContains.");

      // Resolve source collection GIDs.
      const collectionGids: string[] = [];
      if (hasIds) {
        for (const id of args.sourceCollectionIds!) collectionGids.push(toGid("Collection", id));
      } else {
        const seen = new Set<string>();
        for (const term of args.sourceCollectionTitleContains!) {
          const r = await c.request<{ collections: { nodes: Array<{ id: string; title: string }> } }>(COLLECTIONS_SEARCH, { query: `title:${JSON.stringify(term)}`, first: 100 });
          for (const n of r.data.collections.nodes) {
            if (n.title.toLowerCase().includes(term.toLowerCase()) && !seen.has(n.id)) { seen.add(n.id); collectionGids.push(n.id); }
          }
        }
        if (collectionGids.length === 0) throw new Error(`No collections matched ${JSON.stringify(args.sourceCollectionTitleContains)}.`);
      }

      // List products across all source collections (dedupe by id, enforce cap).
      const productById = new Map<string, SrcProduct>();
      for (const colGid of collectionGids) {
        let after: string | null = null;
        do {
          const r: { data: { collection: { products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: SrcProduct[] } } | null } } =
            await c.request(SOURCE_PRODUCTS, { id: colGid, first: 50, after });
          if (!r.data.collection) throw new Error(`No collection found with id ${gidToId(colGid)}.`);
          for (const p of r.data.collection.products.nodes) if (!productById.has(p.id)) productById.set(p.id, p);
          if (productById.size > MAX_PRODUCTS) throw new Error(`Source resolves to more than ${MAX_PRODUCTS} products; narrow to fewer collections per call (this job batches across multiple calls).`);
          after = r.data.collection.products.pageInfo.hasNextPage ? r.data.collection.products.pageInfo.endCursor : null;
        } while (after);
      }
      const products = [...productById.values()];

      // Build the plan.
      const plan = products.map((p) => ({
        product: p,
        newProducts: p.variants.nodes.map((v) => {
          const variantPart = v.title && v.title !== "Default Title" ? `${args.titleSeparator}${v.title}` : "";
          const title = `${p.title}${variantPart}${args.suffix}`;
          const baseSku = v.sku ?? sanitizeSkuBase(`${p.title}${v.title && v.title !== "Default Title" ? `-${v.title}` : ""}`);
          const sku = `${baseSku}${args.suffix}`;
          return { title, sku, variantId: v.id };
        }),
      }));
      const totalNew = plan.reduce((n, p) => n + p.newProducts.length, 0);

      // Resolve destination (create only on execute).
      const destSearch = await c.request<{ collections: { nodes: Array<{ id: string; title: string }> } }>(COLLECTIONS_SEARCH, { query: `title:${JSON.stringify(args.destinationCollectionTitle)}`, first: 10 });
      let destGid = destSearch.data.collections.nodes.find((n) => n.title === args.destinationCollectionTitle)?.id ?? null;

      if (args.dryRun) {
        const sample = plan.flatMap((p) => p.newProducts).slice(0, 40);
        return {
          markdown:
            `**DRY RUN** — ${collectionGids.length} source collection(s), ${products.length} product(s) → ` +
            `${totalNew} new ${args.newProductStatus} product(s) @ $${args.price} into "${args.destinationCollectionTitle}"` +
            `${destGid ? "" : " (would be CREATED)"}; originals: ${args.originalProductAction}.\n\n` +
            sample.map((n) => `- ${n.title}  [${n.sku}]`).join("\n") +
            (totalNew > sample.length ? `\n… and ${totalNew - sample.length} more` : "") +
            `\n\n_Quantity is not set here — run shopify_bulk_set_inventory_quantity on the destination after. Nothing created. Re-run with dryRun:false to execute._`,
          structured: { dryRun: true, sourceCollections: collectionGids.length, sourceProducts: products.length, newProductsPlanned: totalNew, destinationExists: Boolean(destGid), newProductStatus: args.newProductStatus, price: args.price, originalProductAction: args.originalProductAction, plan: plan.map((p) => ({ sourceProductId: gidToId(p.product.id), newProducts: p.newProducts.map((n) => ({ title: n.title, sku: n.sku })) })) },
          cost: undefined,
        };
      }

      // Create destination if needed.
      if (!destGid) {
        const cr = await c.request<{ collectionCreate: { collection: { id: string } | null; userErrors: Array<{ message: string }> } }>(COLLECTION_CREATE, { input: { title: args.destinationCollectionTitle } });
        if (cr.data.collectionCreate.userErrors.length) throw new Error(`Could not create destination collection: ${cr.data.collectionCreate.userErrors.map((e) => e.message).join("; ")}`);
        destGid = cr.data.collectionCreate.collection!.id;
      }

      let sourceProductsProcessed = 0;
      let newProductsCreated = 0;
      let originalProductsUpdated = 0;
      const failures: Array<{ sourceProductId: string; variantId?: string; error: string }> = [];

      for (const { product, newProducts } of plan) {
        const imgs = product.media.nodes.filter((m) => m.mediaContentType === "IMAGE" && m.image?.url).map((m) => ({ url: m.image!.url, alt: m.image!.altText }));
        const chosen = args.copyImages === "featured" ? imgs.slice(0, 1) : imgs;
        const media = chosen.map((im) => ({ originalSource: im.url, mediaContentType: "IMAGE", ...(im.alt ? { alt: im.alt } : {}) }));

        const createdIds: string[] = [];
        let productFailed = false;

        for (const np of newProducts) {
          try {
            const cr = await c.request<{ productCreate: { product: { id: string; variants: { nodes: Array<{ id: string }> } } | null; userErrors: Array<{ field: string[] | null; message: string }> } }>(
              PRODUCT_CREATE, { input: { title: np.title, productType: product.productType, tags: product.tags, status: args.newProductStatus }, media: media.length ? media : null },
            );
            if (cr.data.productCreate.userErrors.length) throw new Error(cr.data.productCreate.userErrors.map((e) => e.message).join("; "));
            const newProd = cr.data.productCreate.product!;
            const defaultVariantId = newProd.variants.nodes[0]?.id;
            if (!defaultVariantId) throw new Error("created product has no default variant");

            const vu = await c.request<{ productVariantsBulkUpdate: { userErrors: Array<{ field: string[] | null; message: string }> } }>(
              VARIANT_UPDATE, { productId: newProd.id, variants: [{ id: defaultVariantId, price: args.price, inventoryItem: { sku: np.sku } }] },
            );
            if (vu.data.productVariantsBulkUpdate.userErrors.length) throw new Error(vu.data.productVariantsBulkUpdate.userErrors.map((e) => e.message).join("; "));

            createdIds.push(newProd.id);
            newProductsCreated++;
          } catch (err) {
            productFailed = true;
            failures.push({ sourceProductId: gidToId(product.id), variantId: gidToId(np.variantId), error: err instanceof Error ? err.message : String(err) });
          }
          if (args.delayMs > 0) await sleep(args.delayMs);
        }

        if (createdIds.length) {
          try {
            const add = await c.request<{ collectionAddProducts: { userErrors: Array<{ field: string[] | null; message: string }> } }>(COLLECTION_ADD, { id: destGid, productIds: createdIds });
            if (add.data.collectionAddProducts.userErrors.length) failures.push({ sourceProductId: gidToId(product.id), error: `collection add: ${add.data.collectionAddProducts.userErrors.map((e) => e.message).join("; ")}` });
          } catch (err) {
            failures.push({ sourceProductId: gidToId(product.id), error: `collection add: ${err instanceof Error ? err.message : String(err)}` });
          }
          if (args.delayMs > 0) await sleep(args.delayMs);
        }

        // Act on the original only if every variant split cleanly.
        if (!productFailed) {
          sourceProductsProcessed++;
          if (args.originalProductAction !== "leave") {
            try {
              if (args.originalProductAction === "delete") {
                const del = await c.request<{ productDelete: { userErrors: Array<{ message: string }> } }>(PRODUCT_DELETE, { id: product.id });
                if (del.data.productDelete.userErrors.length) throw new Error(del.data.productDelete.userErrors.map((e) => e.message).join("; "));
              } else {
                const status = args.originalProductAction === "draft" ? "DRAFT" : "ARCHIVED";
                const up = await c.request<{ productUpdate: { userErrors: Array<{ message: string }> } }>(PRODUCT_STATUS, { product: { id: product.id, status } });
                if (up.data.productUpdate.userErrors.length) throw new Error(up.data.productUpdate.userErrors.map((e) => e.message).join("; "));
              }
              originalProductsUpdated++;
            } catch (err) {
              failures.push({ sourceProductId: gidToId(product.id), error: `original ${args.originalProductAction}: ${err instanceof Error ? err.message : String(err)}` });
            }
            if (args.delayMs > 0) await sleep(args.delayMs);
          }
        }
      }

      return {
        markdown:
          `Split ${sourceProductsProcessed}/${products.length} product(s) → **${newProductsCreated} new product(s)** in ` +
          `"${args.destinationCollectionTitle}"` +
          (args.originalProductAction !== "leave" ? `; ${originalProductsUpdated} original(s) ${args.originalProductAction}d` : "; originals left live") +
          `. ${failures.length} failure(s).` +
          (failures.length ? `\n\nFirst failures:\n` + failures.slice(0, 15).map((f) => `- ${f.sourceProductId}${f.variantId ? `/${f.variantId}` : ""}: ${f.error}`).join("\n") : "") +
          `\n\n_Next: set quantity with shopify_bulk_set_inventory_quantity on "${args.destinationCollectionTitle}"._`,
        structured: { sourceProductsProcessed, newProductsCreated, originalProductsUpdated, failed: failures.length, failures: failures.slice(0, 200) },
        cost: undefined,
      };
    },
  });
}
