/**
 * Inventory tools: get levels by SKU or inventory item (read); adjust (write).
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ShopifyClient, assertNoUserErrors } from "../shopify-client.js";
import { registerTool } from "./shared.js";
import { gidToId, toGid, markdownTable, stripGids } from "../format.js";

interface InventoryLevelNode {
  quantities: Array<{ name: string; quantity: number }>;
  location: { id: string; name: string };
}

interface InventoryItemNode {
  id: string;
  sku: string | null;
  variant: { id: string; displayName: string; product: { title: string } | null } | null;
  inventoryLevels: { nodes: InventoryLevelNode[] };
}

const INV_FIELDS = /* GraphQL */ `
  id sku
  variant { id displayName product { title } }
  inventoryLevels(first: 25) {
    nodes {
      quantities(names: ["available", "on_hand", "committed"]) { name quantity }
      location { id name }
    }
  }
`;

const INVENTORY_BY_QUERY = /* GraphQL */ `
  query InventoryByQuery($first: Int!, $query: String) {
    inventoryItems(first: $first, query: $query) {
      nodes { ${INV_FIELDS} }
    }
  }
`;

const INVENTORY_BY_ID = /* GraphQL */ `
  query InventoryById($id: ID!) {
    inventoryItem(id: $id) { ${INV_FIELDS} }
  }
`;

// 2026-04+: the @idempotent directive (with a key) is required, and each change
// must carry changeFromQuantity (compare-and-swap).
const ADJUST_INVENTORY = /* GraphQL */ `
  mutation AdjustInventory($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) {
    inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
      inventoryAdjustmentGroup {
        reason
        changes { name delta quantityAfterChange }
      }
      userErrors { field message }
    }
  }
`;

const CURRENT_AVAILABLE = /* GraphQL */ `
  query CurrentAvailable($inventoryItemId: ID!, $locationId: ID!) {
    inventoryItem(id: $inventoryItemId) {
      inventoryLevel(locationId: $locationId) {
        quantities(names: ["available"]) { name quantity }
      }
    }
  }
`;

function renderLevels(items: InventoryItemNode[]): string {
  const rows: Array<unknown[]> = [];
  for (const item of items) {
    for (const level of item.inventoryLevels.nodes) {
      const byName = Object.fromEntries(level.quantities.map((q) => [q.name, q.quantity]));
      rows.push([
        gidToId(item.id),
        item.sku ?? "",
        item.variant?.product?.title ?? "",
        item.variant?.displayName ?? "",
        level.location.name,
        byName.available ?? "",
        byName.on_hand ?? "",
        byName.committed ?? "",
      ]);
    }
  }
  if (rows.length === 0) return "No inventory levels found.";
  return markdownTable(
    ["Inv. item", "SKU", "Product", "Variant", "Location", "Available", "On hand", "Committed"],
    rows,
  );
}

export function registerInventoryTools(server: McpServer, client: ShopifyClient): void {
  registerTool(server, client, {
    name: "shopify_get_inventory_levels",
    title: "Get inventory levels",
    description:
      "Get inventory levels across locations, looked up by SKU or by inventory item id. " +
      "Reports available, on-hand and committed quantities per location.",
    inputSchema: {
      sku: z.string().optional().describe("Look up inventory items by SKU (exact match)."),
      inventoryItemId: z
        .string()
        .optional()
        .describe("Look up a single inventory item by id (numeric or GID)."),
      first: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(25)
        .describe("Max inventory items to return when searching by SKU. Default 25, max 100."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      if (!args.sku && !args.inventoryItemId) {
        throw new Error("Provide either `sku` or `inventoryItemId`.");
      }

      let items: InventoryItemNode[];
      let cost: number | undefined;

      if (args.inventoryItemId) {
        const res = await c.request<{ inventoryItem: InventoryItemNode | null }>(INVENTORY_BY_ID, {
          id: toGid("InventoryItem", args.inventoryItemId),
        });
        cost = res.cost;
        items = res.data.inventoryItem ? [res.data.inventoryItem] : [];
      } else {
        const res = await c.request<{ inventoryItems: { nodes: InventoryItemNode[] } }>(
          INVENTORY_BY_QUERY,
          { first: args.first, query: `sku:${args.sku}` },
        );
        cost = res.cost;
        items = res.data.inventoryItems.nodes;
      }

      return {
        markdown: renderLevels(items),
        structured: { inventoryItems: stripGids(items) },
        cost,
      };
    },
  });
}

// ─── Bulk inventory-tracking toggle ──────────────────────────────────────────

const COLLECTION_PRODUCT_IDS = /* GraphQL */ `
  query CollectionProductIds($id: ID!, $first: Int!, $after: String) {
    collection(id: $id) {
      products(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id }
      }
    }
  }
`;

const PRODUCT_VARIANT_IDS = /* GraphQL */ `
  query ProductVariantIds($id: ID!, $first: Int!, $after: String) {
    product(id: $id) {
      variants(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id }
      }
    }
  }
`;

const SET_TRACKED = /* GraphQL */ `
  mutation SetTracked($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id }
      userErrors { field message }
    }
  }
`;

/** Collects every product GID for the given target (single product or whole collection). */
async function collectProductGids(
  c: ShopifyClient,
  args: { productId?: string; collectionId?: string },
): Promise<string[]> {
  if (args.productId) return [toGid("Product", args.productId)];

  const gids: string[] = [];
  let after: string | null = null;
  do {
    const res: {
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
    if (!res.data.collection) {
      throw new Error(`No collection found with id ${gidToId(args.collectionId!)}.`);
    }
    for (const n of res.data.collection.products.nodes) gids.push(n.id);
    after = res.data.collection.products.pageInfo.hasNextPage
      ? res.data.collection.products.pageInfo.endCursor
      : null;
  } while (after);
  return gids;
}

/** Collects every variant GID for a product, paginating as needed. */
async function collectVariantGids(c: ShopifyClient, productGid: string): Promise<string[]> {
  const ids: string[] = [];
  let after: string | null = null;
  do {
    const res: {
      data: {
        product: {
          variants: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<{ id: string }> };
        } | null;
      };
    } = await c.request(PRODUCT_VARIANT_IDS, { id: productGid, first: 100, after });
    if (!res.data.product) break;
    for (const v of res.data.product.variants.nodes) ids.push(v.id);
    after = res.data.product.variants.pageInfo.hasNextPage
      ? res.data.product.variants.pageInfo.endCursor
      : null;
  } while (after);
  return ids;
}

export function registerInventoryWriteTools(server: McpServer, client: ShopifyClient): void {
  registerTool(server, client, {
    name: "shopify_set_inventory_tracking",
    title: "Set inventory tracking (bulk)",
    description:
      "Turn Shopify inventory tracking on or off for every variant of a single product OR every " +
      "product in a collection. The server iterates products/variants itself (handling pagination) " +
      "and returns how many variants changed — so a whole collection is one tool call. " +
      "Provide exactly one of productId or collectionId.",
    inputSchema: {
      productId: z
        .string()
        .optional()
        .describe("Apply to all variants of this single product (numeric or GID)."),
      collectionId: z
        .string()
        .optional()
        .describe("Apply to all variants of every product in this collection (numeric or GID)."),
      tracked: z
        .boolean()
        .describe("true to track inventory quantity; false to stop tracking (sells regardless of stock)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      if ((!args.productId && !args.collectionId) || (args.productId && args.collectionId)) {
        throw new Error("Provide exactly one of productId or collectionId.");
      }

      const productGids = await collectProductGids(c, args);

      let variantsChanged = 0;
      let productsProcessed = 0;
      const errors: string[] = [];

      for (const productGid of productGids) {
        const variantGids = await collectVariantGids(c, productGid);
        if (variantGids.length === 0) {
          productsProcessed++;
          continue;
        }
        // productVariantsBulkUpdate accepts many variants per call; chunk to stay well within limits.
        for (let i = 0; i < variantGids.length; i += 100) {
          const chunk = variantGids.slice(i, i + 100);
          const res = await c.request<{
            productVariantsBulkUpdate: {
              productVariants: Array<{ id: string }> | null;
              userErrors: Array<{ field: string[] | null; message: string }>;
            };
          }>(SET_TRACKED, {
            productId: productGid,
            variants: chunk.map((id) => ({ id, inventoryItem: { tracked: args.tracked } })),
          });
          const ue = res.data.productVariantsBulkUpdate.userErrors;
          if (ue && ue.length > 0) {
            errors.push(`${gidToId(productGid)}: ${ue.map((e) => e.message).join("; ")}`);
          } else {
            variantsChanged += res.data.productVariantsBulkUpdate.productVariants?.length ?? chunk.length;
          }
        }
        productsProcessed++;
      }

      const scope = args.collectionId
        ? `collection ${gidToId(args.collectionId)}`
        : `product ${gidToId(args.productId!)}`;
      const summary =
        `Set tracked=${args.tracked} on ${variantsChanged} variant(s) across ${productsProcessed} ` +
        `product(s) in ${scope}.`;
      const errBlock =
        errors.length > 0
          ? `\n\n**${errors.length} product(s) reported errors:**\n` +
            errors.slice(0, 20).map((e) => `- ${e}`).join("\n") +
            (errors.length > 20 ? `\n- …and ${errors.length - 20} more` : "")
          : "";

      return {
        markdown: summary + errBlock,
        structured: {
          tracked: args.tracked,
          productsProcessed,
          variantsChanged,
          errorCount: errors.length,
          errors: errors.slice(0, 50),
        },
        cost: undefined,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_adjust_inventory",
    title: "Adjust inventory",
    description:
      "Adjust the available quantity of an inventory item at a location by a (positive or " +
      "negative) delta. Requires the inventory item id and location id.",
    inputSchema: {
      inventoryItemId: z.string().describe("Inventory item id (numeric or GID)."),
      locationId: z.string().describe("Location id (numeric or GID)."),
      delta: z.number().int().describe("Signed change to available quantity, e.g. 5 or -3."),
      reason: z
        .string()
        .default("correction")
        .describe('Adjustment reason, e.g. "correction", "received", "damaged", "cycle_count_available".'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (args, c) => {
      const inventoryItemGid = toGid("InventoryItem", args.inventoryItemId);
      const locationGid = toGid("Location", args.locationId);

      // Compare-and-swap needs the current available quantity (2026-04+).
      const cur = await c.request<{
        inventoryItem: {
          inventoryLevel: { quantities: Array<{ name: string; quantity: number }> } | null;
        } | null;
      }>(CURRENT_AVAILABLE, { inventoryItemId: inventoryItemGid, locationId: locationGid });
      const level = cur.data.inventoryItem?.inventoryLevel;
      if (!level) {
        throw new Error(
          `Inventory item ${gidToId(args.inventoryItemId)} is not stocked at location ${gidToId(args.locationId)}. ` +
            "Activate it there first with shopify_activate_inventory.",
        );
      }
      const changeFromQuantity = level.quantities.find((q) => q.name === "available")?.quantity ?? 0;

      const res = await c.request<{
        inventoryAdjustQuantities: {
          inventoryAdjustmentGroup: {
            reason: string;
            changes: Array<{ name: string; delta: number; quantityAfterChange: number | null }>;
          } | null;
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(ADJUST_INVENTORY, {
        input: {
          name: "available",
          reason: args.reason,
          changes: [
            {
              delta: args.delta,
              inventoryItemId: inventoryItemGid,
              locationId: locationGid,
              changeFromQuantity,
            },
          ],
        },
        idempotencyKey: randomUUID(),
      });

      assertNoUserErrors(res.data.inventoryAdjustQuantities.userErrors);
      const group = res.data.inventoryAdjustQuantities.inventoryAdjustmentGroup;
      const change = group?.changes?.[0];
      return {
        markdown: change
          ? `Adjusted available by ${change.delta} for inventory item ${gidToId(args.inventoryItemId)} ` +
            `at location ${gidToId(args.locationId)}. New quantity: ${change.quantityAfterChange ?? "?"} (reason: ${group?.reason}).`
          : `Inventory adjusted by ${args.delta}.`,
        structured: { adjustment: group },
        cost: res.cost,
      };
    },
  });
}
