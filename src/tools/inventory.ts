/**
 * Inventory tools: get levels by SKU or inventory item (read); adjust (write).
 */

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

const ADJUST_INVENTORY = /* GraphQL */ `
  mutation AdjustInventory($input: InventoryAdjustQuantitiesInput!) {
    inventoryAdjustQuantities(input: $input) {
      inventoryAdjustmentGroup {
        reason
        changes { name delta quantityAfterChange }
      }
      userErrors { field message }
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

export function registerInventoryWriteTools(server: McpServer, client: ShopifyClient): void {
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
              inventoryItemId: toGid("InventoryItem", args.inventoryItemId),
              locationId: toGid("Location", args.locationId),
            },
          ],
        },
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
