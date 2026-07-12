/**
 * Store operations tools: list locations and read shop info (read); upload a
 * file, set an absolute inventory quantity, and activate an inventory item at a
 * location (write).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ShopifyClient, assertNoUserErrors } from "../shopify-client.js";
import { registerTool, paginationShape } from "./shared.js";
import { gidToId, toGid, markdownTable, detailLines, stripGids } from "../format.js";

// ─── Read tools ──────────────────────────────────────────────────────────────

interface LocationAddress {
  city: string | null;
  province: string | null;
  country: string | null;
}

interface LocationNode {
  id: string;
  name: string;
  isActive: boolean;
  address: LocationAddress | null;
}

const LIST_LOCATIONS = /* GraphQL */ `
  query ListLocations($first: Int!, $after: String) {
    locations(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        isActive
        address { city province country }
      }
    }
  }
`;

interface ShopNode {
  id: string;
  name: string;
  email: string | null;
  myshopifyDomain: string;
  primaryDomain: { url: string } | null;
  currencyCode: string;
  plan: { displayName: string } | null;
  billingAddress: { country: string | null } | null;
  ianaTimezone: string;
}

const GET_SHOP = /* GraphQL */ `
  query GetShop {
    shop {
      id
      name
      email
      myshopifyDomain
      primaryDomain { url }
      currencyCode
      plan { displayName }
      billingAddress { country }
      ianaTimezone
    }
  }
`;

export function registerStoreOpsReadTools(server: McpServer, client: ShopifyClient): void {
  registerTool(server, client, {
    name: "shopify_list_locations",
    title: "List locations",
    description:
      "List the store's inventory locations (warehouses, retail stores, fulfillment centers) with " +
      "their id, name, active state and address. Use the returned location ids for inventory tools.",
    inputSchema: { ...paginationShape },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{
        locations: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: LocationNode[];
        };
      }>(LIST_LOCATIONS, { first: args.first, after: args.after ?? null });

      const nodes = res.data.locations.nodes;
      const rows: Array<unknown[]> = nodes.map((loc) => [
        gidToId(loc.id),
        loc.name,
        loc.isActive ? "yes" : "no",
        [loc.address?.city, loc.address?.province, loc.address?.country]
          .filter((v) => v)
          .join(", "),
      ]);

      return {
        markdown:
          nodes.length === 0
            ? "No locations found."
            : markdownTable(["Location", "Name", "Active", "Address"], rows),
        structured: {
          locations: stripGids(nodes),
          pageInfo: res.data.locations.pageInfo,
        },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_get_shop",
    title: "Get shop info",
    description:
      "Get key information about the store: name, contact email, myshopify domain, primary storefront " +
      "URL, default currency, plan, billing country and IANA timezone.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (_args, c) => {
      const res = await c.request<{ shop: ShopNode }>(GET_SHOP);
      const shop = res.data.shop;

      const markdown = [
        `## ${shop.name}`,
        detailLines([
          ["Email", shop.email],
          ["myshopify domain", shop.myshopifyDomain],
          ["Primary domain", shop.primaryDomain?.url],
          ["Currency", shop.currencyCode],
          ["Plan", shop.plan?.displayName],
          ["Billing country", shop.billingAddress?.country],
          ["Timezone", shop.ianaTimezone],
        ]),
      ].join("\n\n");

      return {
        markdown,
        structured: { shop: stripGids(shop) },
        cost: res.cost,
      };
    },
  });
}

// ─── Write tools ─────────────────────────────────────────────────────────────

interface FileNode {
  id: string;
  alt: string | null;
  fileStatus: string;
  createdAt: string;
}

const FILE_CREATE = /* GraphQL */ `
  mutation FileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files {
        id
        alt
        fileStatus
        createdAt
      }
      userErrors { field message code }
    }
  }
`;

const INVENTORY_SET_QUANTITIES = /* GraphQL */ `
  mutation InventorySetQuantities($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      inventoryAdjustmentGroup {
        reason
        changes { name delta quantityAfterChange }
      }
      userErrors { field message code }
    }
  }
`;

const INVENTORY_ACTIVATE = /* GraphQL */ `
  mutation InventoryActivate($inventoryItemId: ID!, $locationId: ID!, $available: Int) {
    inventoryActivate(
      inventoryItemId: $inventoryItemId
      locationId: $locationId
      available: $available
    ) {
      inventoryLevel {
        id
        location { id name }
        quantities(names: ["available", "on_hand"]) { name quantity }
      }
      userErrors { field message }
    }
  }
`;

export function registerStoreOpsWriteTools(server: McpServer, client: ShopifyClient): void {
  registerTool(server, client, {
    name: "shopify_upload_file",
    title: "Upload file",
    description:
      "Upload a file (default: an image) to the store's Files from a publicly accessible URL. Shopify " +
      "downloads the file from the URL asynchronously; the returned fileStatus may be UPLOADED/PROCESSING " +
      "until processing completes.",
    inputSchema: {
      url: z
        .string()
        .url()
        .describe("Publicly accessible URL Shopify will download the file from (originalSource)."),
      alt: z.string().optional().describe("Alt text description of the file, for accessibility."),
      contentType: z
        .enum(["IMAGE", "VIDEO", "EXTERNAL_VIDEO", "MODEL_3D", "FILE"])
        .default("IMAGE")
        .describe("File content type. Defaults to IMAGE."),
      filename: z
        .string()
        .optional()
        .describe("Optional filename to create the file with; otherwise the URL's filename is used."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (args, c) => {
      const file: Record<string, unknown> = {
        originalSource: args.url,
        contentType: args.contentType,
      };
      if (args.alt !== undefined) file.alt = args.alt;
      if (args.filename !== undefined) file.filename = args.filename;

      const res = await c.request<{
        fileCreate: {
          files: FileNode[] | null;
          userErrors: Array<{ field: string[] | null; message: string; code: string | null }>;
        };
      }>(FILE_CREATE, { files: [file] });

      assertNoUserErrors(res.data.fileCreate.userErrors);
      const created = res.data.fileCreate.files?.[0];

      return {
        markdown: created
          ? `Uploaded file ${gidToId(created.id)} (status: ${created.fileStatus}).`
          : "File upload accepted.",
        structured: { file: created ? stripGids(created) : null },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_set_inventory_quantity",
    title: "Set inventory quantity (absolute)",
    description:
      "Set the ABSOLUTE quantity of an inventory item at a location (not a delta). Use " +
      "shopify_adjust_inventory for relative changes. Sets the 'available' or 'on_hand' quantity and " +
      "ignores the compare-quantity check so the value is applied unconditionally.",
    inputSchema: {
      inventoryItemId: z.string().describe("Inventory item id (numeric or GID)."),
      locationId: z.string().describe("Location id (numeric or GID)."),
      quantity: z.number().int().describe("The absolute quantity to set at the location."),
      name: z
        .enum(["available", "on_hand"])
        .default("available")
        .describe("Which quantity to set: 'available' or 'on_hand'. Default 'available'."),
      reason: z
        .string()
        .default("correction")
        .describe('Reason for the change, e.g. "correction", "cycle_count_available". Default "correction".'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{
        inventorySetQuantities: {
          inventoryAdjustmentGroup: {
            reason: string;
            changes: Array<{ name: string; delta: number; quantityAfterChange: number | null }>;
          } | null;
          userErrors: Array<{ field: string[] | null; message: string; code: string | null }>;
        };
      }>(INVENTORY_SET_QUANTITIES, {
        input: {
          name: args.name,
          reason: args.reason,
          ignoreCompareQuantity: true,
          quantities: [
            {
              inventoryItemId: toGid("InventoryItem", args.inventoryItemId),
              locationId: toGid("Location", args.locationId),
              quantity: args.quantity,
            },
          ],
        },
      });

      assertNoUserErrors(res.data.inventorySetQuantities.userErrors);
      const group = res.data.inventorySetQuantities.inventoryAdjustmentGroup;
      const change = group?.changes?.[0];

      return {
        markdown:
          `Set ${args.name} to ${args.quantity} for inventory item ${gidToId(args.inventoryItemId)} ` +
          `at location ${gidToId(args.locationId)}` +
          (change ? ` (new quantity: ${change.quantityAfterChange ?? "?"}, delta: ${change.delta}).` : ".") +
          ` Reason: ${group?.reason ?? args.reason}.`,
        structured: { adjustment: group },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_activate_inventory",
    title: "Activate inventory at location",
    description:
      "Enable stocking an inventory item at a location by creating an inventory level there. Optionally " +
      "seeds the available quantity (defaults to 0). Required before setting/adjusting quantities at a " +
      "location where the item is not yet stocked.",
    inputSchema: {
      inventoryItemId: z.string().describe("Inventory item id (numeric or GID)."),
      locationId: z.string().describe("Location id (numeric or GID)."),
      available: z
        .number()
        .int()
        .optional()
        .describe("Optional initial available quantity to stock. Defaults to 0 if omitted."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (args, c) => {
      const res = await c.request<{
        inventoryActivate: {
          inventoryLevel: {
            id: string;
            location: { id: string; name: string } | null;
            quantities: Array<{ name: string; quantity: number }>;
          } | null;
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(INVENTORY_ACTIVATE, {
        inventoryItemId: toGid("InventoryItem", args.inventoryItemId),
        locationId: toGid("Location", args.locationId),
        available: args.available ?? null,
      });

      assertNoUserErrors(res.data.inventoryActivate.userErrors);
      const level = res.data.inventoryActivate.inventoryLevel;
      const availableQty = level?.quantities.find((q) => q.name === "available")?.quantity;

      return {
        markdown:
          `Activated inventory item ${gidToId(args.inventoryItemId)} at location ` +
          `${level?.location?.name ?? gidToId(args.locationId)}` +
          (availableQty !== undefined ? ` (available: ${availableQty}).` : "."),
        structured: { inventoryLevel: level ? stripGids(level) : null },
        cost: res.cost,
      };
    },
  });
}
