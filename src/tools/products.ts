/**
 * Product tools: list, get (read); create, update, update-variant (write).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ShopifyClient, assertNoUserErrors } from "../shopify-client.js";
import { registerTool, paginationShape } from "./shared.js";
import {
  gidToId,
  toGid,
  markdownTable,
  detailLines,
  money,
  stripGids,
} from "../format.js";

interface Money {
  amount: string;
  currencyCode: string;
}

interface ProductNode {
  id: string;
  title: string;
  status: string;
  handle: string;
  totalInventory: number | null;
  variantsCount: { count: number } | null;
  priceRangeV2: {
    minVariantPrice: Money;
    maxVariantPrice: Money;
  } | null;
}

interface ProductsConnection {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: ProductNode[];
}

/** Combines a free-text query with a status filter into Shopify search syntax. */
function buildProductQuery(query: string | undefined, status: string | undefined): string | undefined {
  const parts: string[] = [];
  if (query && query.trim()) parts.push(query.trim());
  if (status) parts.push(`status:${status.toLowerCase()}`);
  return parts.length ? parts.join(" ") : undefined;
}

const LIST_PRODUCTS = /* GraphQL */ `
  query ListProducts($first: Int!, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id title status handle totalInventory
        variantsCount { count }
        priceRangeV2 {
          minVariantPrice { amount currencyCode }
          maxVariantPrice { amount currencyCode }
        }
      }
    }
  }
`;

const LIST_PRODUCTS_IN_COLLECTION = /* GraphQL */ `
  query ListCollectionProducts($id: ID!, $first: Int!, $after: String) {
    collection(id: $id) {
      products(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id title status handle totalInventory
          variantsCount { count }
          priceRangeV2 {
            minVariantPrice { amount currencyCode }
            maxVariantPrice { amount currencyCode }
          }
        }
      }
    }
  }
`;

const GET_PRODUCT = /* GraphQL */ `
  query GetProduct($id: ID!) {
    product(id: $id) {
      id title handle status descriptionHtml productType vendor tags
      totalInventory createdAt updatedAt onlineStoreUrl
      priceRangeV2 {
        minVariantPrice { amount currencyCode }
        maxVariantPrice { amount currencyCode }
      }
      variants(first: 100) {
        nodes {
          id title sku price compareAtPrice inventoryQuantity inventoryPolicy
          selectedOptions { name value }
          inventoryItem { id }
        }
      }
      metafields(first: 50) {
        nodes { namespace key value type }
      }
    }
  }
`;

function renderProductRow(p: ProductNode): Array<unknown> {
  const min = p.priceRangeV2?.minVariantPrice;
  const max = p.priceRangeV2?.maxVariantPrice;
  const price =
    min && max
      ? min.amount === max.amount
        ? money(min)
        : `${money(min)} – ${money(max)}`
      : "";
  return [
    gidToId(p.id),
    p.title,
    p.status,
    p.handle,
    p.variantsCount?.count ?? 0,
    price,
  ];
}

export function registerProductTools(server: McpServer, client: ShopifyClient): void {
  registerTool(server, client, {
    name: "shopify_list_products",
    title: "List products",
    description:
      "List products, optionally filtered by a free-text search query, status, or collection. " +
      "Returns id, title, status, handle, variant count and price range. Supports cursor pagination.",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe('Free-text search, e.g. "title:Shirt", "vendor:Acme", "tag:sale".'),
      status: z
        .enum(["ACTIVE", "ARCHIVED", "DRAFT"])
        .optional()
        .describe("Filter by product status."),
      collectionId: z
        .string()
        .optional()
        .describe("Limit to products in this collection (numeric id or GID)."),
      ...paginationShape,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      let connection: ProductsConnection;
      let cost: number | undefined;

      if (args.collectionId) {
        const res = await c.request<{ collection: { products: ProductsConnection } | null }>(
          LIST_PRODUCTS_IN_COLLECTION,
          { id: toGid("Collection", args.collectionId), first: args.first, after: args.after },
        );
        cost = res.cost;
        if (!res.data.collection) {
          return {
            markdown: `No collection found with id ${gidToId(args.collectionId)}.`,
            structured: { products: [], pageInfo: { hasNextPage: false, endCursor: null } },
            cost,
          };
        }
        connection = res.data.collection.products;
      } else {
        const res = await c.request<{ products: ProductsConnection }>(LIST_PRODUCTS, {
          first: args.first,
          after: args.after,
          query: buildProductQuery(args.query, args.status),
        });
        cost = res.cost;
        connection = res.data.products;
      }

      const rows = connection.nodes.map(renderProductRow);
      const markdown =
        connection.nodes.length === 0
          ? "No products matched."
          : markdownTable(
              ["ID", "Title", "Status", "Handle", "Variants", "Price"],
              rows,
              args.first,
            ) +
            (connection.pageInfo.hasNextPage
              ? `\n\n_More available. Pass \`after: "${connection.pageInfo.endCursor}"\` for the next page._`
              : "");

      return {
        markdown,
        structured: {
          products: stripGids(connection.nodes),
          pageInfo: connection.pageInfo,
        },
        cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_get_product",
    title: "Get product",
    description:
      "Get a single product with full detail: variants (SKUs, prices, inventory quantities, " +
      "inventory policy), options, and metafields.",
    inputSchema: {
      id: z.string().describe("Product id (numeric, e.g. 123) or GID."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{
        product: {
          id: string;
          title: string;
          handle: string;
          status: string;
          descriptionHtml: string;
          productType: string;
          vendor: string;
          tags: string[];
          totalInventory: number | null;
          createdAt: string;
          updatedAt: string;
          onlineStoreUrl: string | null;
          priceRangeV2: { minVariantPrice: Money; maxVariantPrice: Money } | null;
          variants: {
            nodes: Array<{
              id: string;
              title: string;
              sku: string | null;
              price: string;
              compareAtPrice: string | null;
              inventoryQuantity: number | null;
              inventoryPolicy: string;
              selectedOptions: Array<{ name: string; value: string }>;
              inventoryItem: { id: string } | null;
            }>;
          };
          metafields: {
            nodes: Array<{ namespace: string; key: string; value: string; type: string }>;
          };
        } | null;
      }>(GET_PRODUCT, { id: toGid("Product", args.id) });

      const product = res.data.product;
      if (!product) {
        return {
          markdown: `No product found with id ${gidToId(args.id)}.`,
          structured: { product: null },
          cost: res.cost,
        };
      }

      const header = detailLines([
        ["ID", gidToId(product.id)],
        ["Title", product.title],
        ["Status", product.status],
        ["Handle", product.handle],
        ["Vendor", product.vendor],
        ["Type", product.productType],
        ["Tags", product.tags.join(", ")],
        ["Total inventory", product.totalInventory],
        ["URL", product.onlineStoreUrl],
      ]);

      const variantRows = product.variants.nodes.map((v) => [
        gidToId(v.id),
        v.title,
        v.sku ?? "",
        v.price,
        v.compareAtPrice ?? "",
        v.inventoryQuantity ?? "",
        v.inventoryPolicy,
      ]);
      const variantTable = markdownTable(
        ["Variant ID", "Title", "SKU", "Price", "Compare-at", "Qty", "Policy"],
        variantRows,
      );

      const metaTable =
        product.metafields.nodes.length > 0
          ? "\n\n**Metafields**\n\n" +
            markdownTable(
              ["Namespace", "Key", "Type", "Value"],
              product.metafields.nodes.map((m) => [m.namespace, m.key, m.type, m.value]),
            )
          : "";

      return {
        markdown: `### ${product.title}\n\n${header}\n\n**Variants**\n\n${variantTable}${metaTable}`,
        structured: { product: stripGids(product) },
        cost: res.cost,
      };
    },
  });
}

// ─── Write tools ───────────────────────────────────────────────────────────

const CREATE_PRODUCT = /* GraphQL */ `
  mutation CreateProduct($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product { id title handle status }
      userErrors { field message }
    }
  }
`;

const UPDATE_PRODUCT = /* GraphQL */ `
  mutation UpdateProduct($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product { id title handle status }
      userErrors { field message }
    }
  }
`;

const UPDATE_VARIANTS = /* GraphQL */ `
  mutation UpdateVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id title sku price compareAtPrice inventoryPolicy }
      userErrors { field message }
    }
  }
`;

export function registerProductWriteTools(server: McpServer, client: ShopifyClient): void {
  registerTool(server, client, {
    name: "shopify_create_product",
    title: "Create product",
    description:
      "Create a product. Sets product-level fields; a default variant is created automatically. " +
      "Use shopify_update_variant to set the variant's price/SKU/inventory.",
    inputSchema: {
      title: z.string().describe("Product title."),
      descriptionHtml: z.string().optional().describe("Product description (HTML allowed)."),
      vendor: z.string().optional(),
      productType: z.string().optional(),
      tags: z.array(z.string()).optional().describe('Tags, e.g. ["sale", "new"].'),
      status: z
        .enum(["ACTIVE", "ARCHIVED", "DRAFT"])
        .default("DRAFT")
        .describe("Initial status. Defaults to DRAFT."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (args, c) => {
      const res = await c.request<{
        productCreate: {
          product: { id: string; title: string; handle: string; status: string } | null;
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(CREATE_PRODUCT, {
        product: {
          title: args.title,
          descriptionHtml: args.descriptionHtml,
          vendor: args.vendor,
          productType: args.productType,
          tags: args.tags,
          status: args.status,
        },
      });
      assertNoUserErrors(res.data.productCreate.userErrors);
      const product = res.data.productCreate.product!;
      return {
        markdown: `Created product **${product.title}** (id ${gidToId(product.id)}, status ${product.status}).`,
        structured: { product: stripGids(product) },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_update_product",
    title: "Update product",
    description: "Partially update a product. Only the fields you provide are changed.",
    inputSchema: {
      id: z.string().describe("Product id (numeric or GID)."),
      title: z.string().optional(),
      descriptionHtml: z.string().optional(),
      vendor: z.string().optional(),
      productType: z.string().optional(),
      tags: z.array(z.string()).optional().describe("Replaces the full tag list."),
      status: z.enum(["ACTIVE", "ARCHIVED", "DRAFT"]).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const input: Record<string, unknown> = { id: toGid("Product", args.id) };
      if (args.title !== undefined) input.title = args.title;
      if (args.descriptionHtml !== undefined) input.descriptionHtml = args.descriptionHtml;
      if (args.vendor !== undefined) input.vendor = args.vendor;
      if (args.productType !== undefined) input.productType = args.productType;
      if (args.tags !== undefined) input.tags = args.tags;
      if (args.status !== undefined) input.status = args.status;

      const res = await c.request<{
        productUpdate: {
          product: { id: string; title: string; handle: string; status: string } | null;
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(UPDATE_PRODUCT, { product: input });
      assertNoUserErrors(res.data.productUpdate.userErrors);
      const product = res.data.productUpdate.product!;
      return {
        markdown: `Updated product **${product.title}** (id ${gidToId(product.id)}, status ${product.status}).`,
        structured: { product: stripGids(product) },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_update_variant",
    title: "Update product variant",
    description:
      "Update a single variant's price, compare-at price, SKU, or inventory policy. " +
      "Requires both the product id and the variant id.",
    inputSchema: {
      productId: z.string().describe("Parent product id (numeric or GID)."),
      variantId: z.string().describe("Variant id (numeric or GID)."),
      price: z.string().optional().describe('New price as a decimal string, e.g. "19.99".'),
      compareAtPrice: z.string().optional().describe('Compare-at price, e.g. "29.99". Empty string clears it.'),
      sku: z.string().optional().describe("New SKU (stored on the inventory item)."),
      inventoryPolicy: z
        .enum(["DENY", "CONTINUE"])
        .optional()
        .describe("Whether to allow selling when out of stock (CONTINUE) or not (DENY)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const variant: Record<string, unknown> = { id: toGid("ProductVariant", args.variantId) };
      if (args.price !== undefined) variant.price = args.price;
      if (args.compareAtPrice !== undefined) variant.compareAtPrice = args.compareAtPrice || null;
      if (args.inventoryPolicy !== undefined) variant.inventoryPolicy = args.inventoryPolicy;
      if (args.sku !== undefined) variant.inventoryItem = { sku: args.sku };

      const res = await c.request<{
        productVariantsBulkUpdate: {
          productVariants: Array<{
            id: string;
            title: string;
            sku: string | null;
            price: string;
            compareAtPrice: string | null;
            inventoryPolicy: string;
          }> | null;
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(UPDATE_VARIANTS, {
        productId: toGid("Product", args.productId),
        variants: [variant],
      });
      assertNoUserErrors(res.data.productVariantsBulkUpdate.userErrors);
      const updated = res.data.productVariantsBulkUpdate.productVariants?.[0];
      return {
        markdown: updated
          ? `Updated variant ${gidToId(updated.id)} (SKU ${updated.sku ?? "—"}): price ${updated.price}, policy ${updated.inventoryPolicy}.`
          : "Variant updated.",
        structured: { variant: updated ? stripGids(updated) : null },
        cost: res.cost,
      };
    },
  });
}
