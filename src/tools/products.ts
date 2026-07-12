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
      totalInventory createdAt updatedAt onlineStoreUrl templateSuffix
      seo { title description }
      options { id name position values }
      priceRangeV2 {
        minVariantPrice { amount currencyCode }
        maxVariantPrice { amount currencyCode }
      }
      variants(first: 100) {
        nodes {
          id title sku price compareAtPrice inventoryQuantity inventoryPolicy
          selectedOptions { name value }
          inventoryItem { id tracked }
        }
      }
      media(first: 25) {
        nodes {
          id alt mediaContentType
          ... on MediaImage { image { url } }
        }
      }
      metafields(first: 50) {
        nodes { id namespace key value type }
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
          templateSuffix: string | null;
          seo: { title: string | null; description: string | null } | null;
          options: Array<{ id: string; name: string; position: number; values: string[] }>;
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
              inventoryItem: { id: string; tracked: boolean } | null;
            }>;
          };
          media: {
            nodes: Array<{
              id: string;
              alt: string | null;
              mediaContentType: string;
              image?: { url: string } | null;
            }>;
          };
          metafields: {
            nodes: Array<{ id: string; namespace: string; key: string; value: string; type: string }>;
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
        ["SEO title", product.seo?.title],
        ["SEO description", product.seo?.description],
        ["Theme template", product.templateSuffix],
        ["URL", product.onlineStoreUrl],
      ]);

      const optionsBlock =
        product.options.length > 0
          ? "\n\n**Options:** " +
            product.options.map((o) => `${o.name} (${o.values.join(", ")})`).join(" · ")
          : "";

      const variantRows = product.variants.nodes.map((v) => [
        gidToId(v.id),
        v.title,
        v.sku ?? "",
        v.price,
        v.compareAtPrice ?? "",
        v.inventoryQuantity ?? "",
        v.inventoryPolicy,
        v.inventoryItem?.tracked === false ? "no" : "yes",
      ]);
      const variantTable = markdownTable(
        ["Variant ID", "Title", "SKU", "Price", "Compare-at", "Qty", "Policy", "Tracked"],
        variantRows,
      );

      const mediaTable =
        product.media.nodes.length > 0
          ? "\n\n**Media**\n\n" +
            markdownTable(
              ["Media ID", "Type", "Alt", "URL"],
              product.media.nodes.map((m) => [
                gidToId(m.id),
                m.mediaContentType,
                m.alt ?? "",
                m.image?.url ?? "",
              ]),
            )
          : "";

      const metaTable =
        product.metafields.nodes.length > 0
          ? "\n\n**Metafields**\n\n" +
            markdownTable(
              ["Namespace", "Key", "Type", "Value"],
              product.metafields.nodes.map((m) => [m.namespace, m.key, m.type, m.value]),
            )
          : "";

      return {
        markdown: `### ${product.title}\n\n${header}${optionsBlock}\n\n**Variants**\n\n${variantTable}${mediaTable}${metaTable}`,
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
      productVariants {
        id title sku price compareAtPrice inventoryPolicy
        inventoryItem {
          tracked requiresShipping
          measurement { weight { value unit } }
        }
      }
      userErrors { field message }
    }
  }
`;

const DUPLICATE_PRODUCT = /* GraphQL */ `
  mutation DuplicateProduct($productId: ID!, $newTitle: String!, $newStatus: ProductStatus, $includeImages: Boolean) {
    productDuplicate(productId: $productId, newTitle: $newTitle, newStatus: $newStatus, includeImages: $includeImages) {
      newProduct { id title handle status }
      userErrors { field message }
    }
  }
`;

const CREATE_VARIANTS = /* GraphQL */ `
  mutation CreateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkCreate(productId: $productId, variants: $variants) {
      productVariants {
        id title sku price compareAtPrice inventoryPolicy
        selectedOptions { name value }
      }
      userErrors { field message }
    }
  }
`;

const DELETE_VARIANTS = /* GraphQL */ `
  mutation DeleteVariants($productId: ID!, $variantsIds: [ID!]!) {
    productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
      product { id title }
      userErrors { field message }
    }
  }
`;

const CREATE_MEDIA = /* GraphQL */ `
  mutation CreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media {
        alt mediaContentType status
        ... on MediaImage { id image { url } }
      }
      mediaUserErrors { field message }
    }
  }
`;

const DELETE_MEDIA = /* GraphQL */ `
  mutation DeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
    productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
      deletedMediaIds
      mediaUserErrors { field message }
    }
  }
`;

const SET_METAFIELDS = /* GraphQL */ `
  mutation SetMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key value type ownerType }
      userErrors { field message }
    }
  }
`;

const VARIANT_MEDIA = /* GraphQL */ `
  query VariantMedia($id: ID!, $first: Int!, $after: String) {
    product(id: $id) {
      variants(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          media(first: 50) { nodes { id } }
        }
      }
    }
  }
`;

const APPEND_VARIANT_MEDIA = /* GraphQL */ `
  mutation AppendVariantMedia($productId: ID!, $variantMedia: [ProductVariantAppendMediaInput!]!) {
    productVariantAppendMedia(productId: $productId, variantMedia: $variantMedia) {
      product { id }
      userErrors { code field message }
    }
  }
`;

const REORDER_OPTION_VALUES = /* GraphQL */ `
  mutation ReorderOptionValues($productId: ID!, $options: [OptionReorderInput!]!) {
    productOptionsReorder(productId: $productId, options: $options) {
      userErrors { field message }
    }
  }
`;

const GET_PRODUCT_OPTIONS = /* GraphQL */ `
  query GetProductOptions($id: ID!) {
    product(id: $id) {
      options { id name position optionValues { id name } }
    }
  }
`;

const UPDATE_PRODUCT_OPTION = /* GraphQL */ `
  mutation UpdateProductOption(
    $productId: ID!
    $option: OptionUpdateInput!
    $optionValuesToAdd: [OptionValueCreateInput!]
    $optionValuesToUpdate: [OptionValueUpdateInput!]
    $optionValuesToDelete: [ID!]
    $variantStrategy: ProductOptionUpdateVariantStrategy
  ) {
    productOptionUpdate(
      productId: $productId
      option: $option
      optionValuesToAdd: $optionValuesToAdd
      optionValuesToUpdate: $optionValuesToUpdate
      optionValuesToDelete: $optionValuesToDelete
      variantStrategy: $variantStrategy
    ) {
      product { id }
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
      handle: z.string().optional().describe("URL handle/slug. Auto-generated from the title if omitted."),
      seoTitle: z.string().optional().describe("SEO/browser title tag."),
      seoDescription: z.string().optional().describe("SEO meta description."),
      status: z
        .enum(["ACTIVE", "ARCHIVED", "DRAFT"])
        .default("DRAFT")
        .describe("Initial status. Defaults to DRAFT."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (args, c) => {
      const productInput: Record<string, unknown> = {
        title: args.title,
        descriptionHtml: args.descriptionHtml,
        vendor: args.vendor,
        productType: args.productType,
        tags: args.tags,
        handle: args.handle,
        status: args.status,
      };
      if (args.seoTitle !== undefined || args.seoDescription !== undefined) {
        productInput.seo = { title: args.seoTitle, description: args.seoDescription };
      }
      const res = await c.request<{
        productCreate: {
          product: { id: string; title: string; handle: string; status: string } | null;
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(CREATE_PRODUCT, { product: productInput });
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
      handle: z.string().optional().describe("URL handle/slug."),
      seoTitle: z.string().optional().describe("SEO/browser title tag."),
      seoDescription: z.string().optional().describe("SEO meta description."),
      templateSuffix: z
        .string()
        .optional()
        .describe('Theme template suffix, e.g. "wholesale". Empty string resets to the default template.'),
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
      if (args.handle !== undefined) input.handle = args.handle;
      if (args.templateSuffix !== undefined) input.templateSuffix = args.templateSuffix || null;
      if (args.status !== undefined) input.status = args.status;
      if (args.seoTitle !== undefined || args.seoDescription !== undefined) {
        input.seo = { title: args.seoTitle, description: args.seoDescription };
      }

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
      "Update a single variant's price, compare-at price, SKU, inventory policy, inventory tracking, " +
      "weight, or whether it requires shipping. Requires both the product id and the variant id.",
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
      tracked: z
        .boolean()
        .optional()
        .describe(
          "Whether Shopify tracks this variant's inventory quantity. Set false to stop tracking " +
            "(sells regardless of stock); true to track. Requires the write_inventory scope.",
        ),
      weight: z
        .number()
        .optional()
        .describe("Variant weight for shipping. Provide weightUnit too (defaults to GRAMS)."),
      weightUnit: z
        .enum(["GRAMS", "KILOGRAMS", "OUNCES", "POUNDS"])
        .optional()
        .describe("Unit for `weight`. Defaults to GRAMS when weight is given."),
      requiresShipping: z
        .boolean()
        .optional()
        .describe("Whether this variant is a physical item that requires shipping."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const variant: Record<string, unknown> = { id: toGid("ProductVariant", args.variantId) };
      if (args.price !== undefined) variant.price = args.price;
      if (args.compareAtPrice !== undefined) variant.compareAtPrice = args.compareAtPrice || null;
      if (args.inventoryPolicy !== undefined) variant.inventoryPolicy = args.inventoryPolicy;

      // sku, tracked, weight, and requiresShipping all live on the inventoryItem.
      const inventoryItem: Record<string, unknown> = {};
      if (args.sku !== undefined) inventoryItem.sku = args.sku;
      if (args.tracked !== undefined) inventoryItem.tracked = args.tracked;
      if (args.requiresShipping !== undefined) inventoryItem.requiresShipping = args.requiresShipping;
      if (args.weight !== undefined) {
        inventoryItem.measurement = {
          weight: { value: args.weight, unit: args.weightUnit ?? "GRAMS" },
        };
      }
      if (Object.keys(inventoryItem).length > 0) variant.inventoryItem = inventoryItem;

      const res = await c.request<{
        productVariantsBulkUpdate: {
          productVariants: Array<{
            id: string;
            title: string;
            sku: string | null;
            price: string;
            compareAtPrice: string | null;
            inventoryPolicy: string;
            inventoryItem: {
              tracked: boolean;
              requiresShipping: boolean;
              measurement: { weight: { value: number; unit: string } | null } | null;
            } | null;
          }> | null;
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(UPDATE_VARIANTS, {
        productId: toGid("Product", args.productId),
        variants: [variant],
      });
      assertNoUserErrors(res.data.productVariantsBulkUpdate.userErrors);
      const updated = res.data.productVariantsBulkUpdate.productVariants?.[0];
      const weight = updated?.inventoryItem?.measurement?.weight;
      return {
        markdown: updated
          ? `Updated variant ${gidToId(updated.id)} (SKU ${updated.sku ?? "—"}): price ${updated.price}, ` +
            `policy ${updated.inventoryPolicy}, tracked ${updated.inventoryItem?.tracked ?? "?"}` +
            (weight ? `, weight ${weight.value} ${weight.unit}` : "") +
            (updated.inventoryItem ? `, requiresShipping ${updated.inventoryItem.requiresShipping}` : "") +
            "."
          : "Variant updated.",
        structured: { variant: updated ? stripGids(updated) : null },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_duplicate_product",
    title: "Duplicate product",
    description:
      "Duplicate an existing product into a new one, copying all variants, options, and (optionally) " +
      "images. Give it a new title and an optional status for the copy.",
    inputSchema: {
      id: z.string().describe("Source product id to duplicate (numeric or GID)."),
      newTitle: z.string().describe("Title for the new duplicated product."),
      status: z
        .enum(["ACTIVE", "ARCHIVED", "DRAFT"])
        .optional()
        .describe("Status for the new product. Omit to inherit the source product's status."),
      includeImages: z
        .boolean()
        .default(true)
        .describe("Copy the source product's images into the duplicate."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (args, c) => {
      const res = await c.request<{
        productDuplicate: {
          newProduct: { id: string; title: string; handle: string; status: string } | null;
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(DUPLICATE_PRODUCT, {
        productId: toGid("Product", args.id),
        newTitle: args.newTitle,
        newStatus: args.status,
        includeImages: args.includeImages,
      });
      assertNoUserErrors(res.data.productDuplicate.userErrors);
      const product = res.data.productDuplicate.newProduct!;
      return {
        markdown:
          `Duplicated product ${gidToId(args.id)} into **${product.title}** ` +
          `(id ${gidToId(product.id)}, status ${product.status}). All variants and options were copied.`,
        structured: { product: stripGids(product) },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_create_variant",
    title: "Create product variants",
    description:
      "Add one or more variants to an existing product. For products with options (e.g. Size/Color), " +
      "give each variant its optionValues so Shopify knows which combination it represents.",
    inputSchema: {
      productId: z.string().describe("Product to add variants to (numeric or GID)."),
      variants: z
        .array(
          z.object({
            price: z.string().optional().describe('Price as a decimal string, e.g. "19.99".'),
            compareAtPrice: z.string().optional().describe('Compare-at price, e.g. "29.99".'),
            sku: z.string().optional().describe("SKU (stored on the inventory item)."),
            inventoryPolicy: z
              .enum(["DENY", "CONTINUE"])
              .optional()
              .describe("Allow selling when out of stock (CONTINUE) or not (DENY)."),
            optionValues: z
              .array(
                z.object({
                  optionName: z.string().describe('The product option name, e.g. "Size".'),
                  name: z.string().describe('The value for this variant, e.g. "XL".'),
                }),
              )
              .optional()
              .describe(
                "Option values for this variant. Required when the product has options; " +
                  "one entry per option, e.g. [{optionName:\"Size\",name:\"XL\"},{optionName:\"Color\",name:\"Red\"}].",
              ),
          }),
        )
        .min(1)
        .describe("One or more variants to create."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (args, c) => {
      const variants = args.variants.map((v) => {
        const out: Record<string, unknown> = {};
        if (v.price !== undefined) out.price = v.price;
        if (v.compareAtPrice !== undefined) out.compareAtPrice = v.compareAtPrice || null;
        if (v.inventoryPolicy !== undefined) out.inventoryPolicy = v.inventoryPolicy;
        if (v.sku !== undefined) out.inventoryItem = { sku: v.sku };
        if (v.optionValues !== undefined) {
          out.optionValues = v.optionValues.map((o) => ({ optionName: o.optionName, name: o.name }));
        }
        return out;
      });

      const res = await c.request<{
        productVariantsBulkCreate: {
          productVariants: Array<{
            id: string;
            title: string;
            sku: string | null;
            price: string;
            compareAtPrice: string | null;
            inventoryPolicy: string;
            selectedOptions: Array<{ name: string; value: string }>;
          }> | null;
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(CREATE_VARIANTS, { productId: toGid("Product", args.productId), variants });

      assertNoUserErrors(res.data.productVariantsBulkCreate.userErrors);
      const created = res.data.productVariantsBulkCreate.productVariants ?? [];
      return {
        markdown: created.length
          ? `Added ${created.length} variant(s) to product ${gidToId(args.productId)}:\n\n` +
            markdownTable(
              ["Variant ID", "Title", "SKU", "Price"],
              created.map((v) => [gidToId(v.id), v.title, v.sku ?? "", v.price]),
            )
          : "No variants were created.",
        structured: { variants: stripGids(created) },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_delete_variant",
    title: "Delete product variants",
    description:
      "Delete one or more variants from a product. A product must keep at least one variant. " +
      "This is irreversible.",
    inputSchema: {
      productId: z.string().describe("Parent product id (numeric or GID)."),
      variantIds: z
        .array(z.string())
        .min(1)
        .describe("Variant ids to delete (numeric or GID)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    handler: async (args, c) => {
      const res = await c.request<{
        productVariantsBulkDelete: {
          product: { id: string; title: string } | null;
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(DELETE_VARIANTS, {
        productId: toGid("Product", args.productId),
        variantsIds: args.variantIds.map((id) => toGid("ProductVariant", id)),
      });
      assertNoUserErrors(res.data.productVariantsBulkDelete.userErrors);
      return {
        markdown: `Deleted ${args.variantIds.length} variant(s) from product ${gidToId(args.productId)}.`,
        structured: { product: stripGids(res.data.productVariantsBulkDelete.product) },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_add_product_media",
    title: "Add product media",
    description:
      "Add image(s) to a product from public image URLs, with optional alt text. Shopify fetches " +
      "each URL asynchronously. Use shopify_get_product afterward to see the resulting media.",
    inputSchema: {
      productId: z.string().describe("Product to add media to (numeric or GID)."),
      images: z
        .array(
          z.object({
            url: z.string().describe("Public URL of the image to import."),
            alt: z.string().optional().describe("Alt text for accessibility/SEO."),
          }),
        )
        .min(1)
        .describe("One or more images to add."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (args, c) => {
      const media = args.images.map((img) => ({
        originalSource: img.url,
        alt: img.alt,
        mediaContentType: "IMAGE",
      }));
      const res = await c.request<{
        productCreateMedia: {
          media: Array<{
            alt: string | null;
            mediaContentType: string;
            status: string;
            id?: string;
            image?: { url: string } | null;
          }> | null;
          mediaUserErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(CREATE_MEDIA, { productId: toGid("Product", args.productId), media });
      assertNoUserErrors(res.data.productCreateMedia.mediaUserErrors);
      const added = res.data.productCreateMedia.media ?? [];
      return {
        markdown:
          `Queued ${added.length} image(s) for product ${gidToId(args.productId)} ` +
          `(Shopify processes them asynchronously; check shopify_get_product shortly).`,
        structured: { media: stripGids(added) },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_delete_product_media",
    title: "Delete product media",
    description:
      "Remove media (images/videos) from a product by media id. Get media ids from " +
      "shopify_get_product. This is irreversible.",
    inputSchema: {
      productId: z.string().describe("Parent product id (numeric or GID)."),
      mediaIds: z
        .array(z.string())
        .min(1)
        .describe("Media ids to delete (numeric or GID; from shopify_get_product's Media table)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    handler: async (args, c) => {
      const res = await c.request<{
        productDeleteMedia: {
          deletedMediaIds: string[] | null;
          mediaUserErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(DELETE_MEDIA, {
        productId: toGid("Product", args.productId),
        mediaIds: args.mediaIds.map((id) => toGid("MediaImage", id)),
      });
      assertNoUserErrors(res.data.productDeleteMedia.mediaUserErrors);
      const deleted = res.data.productDeleteMedia.deletedMediaIds ?? [];
      return {
        markdown: `Deleted ${deleted.length} media item(s) from product ${gidToId(args.productId)}.`,
        structured: { deletedMediaIds: deleted.map((id) => gidToId(id)) },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_set_metafield",
    title: "Set a metafield",
    description:
      "Set (create or overwrite) a metafield on a product or variant. Metafields store custom " +
      "structured data. Provide the value as a string matching the given type.",
    inputSchema: {
      ownerType: z
        .enum(["product", "variant"])
        .default("product")
        .describe("Which resource the metafield belongs to."),
      ownerId: z.string().describe("Id of the product or variant (numeric or GID)."),
      namespace: z.string().describe('Metafield namespace, e.g. "custom".'),
      key: z.string().describe('Metafield key, e.g. "material".'),
      value: z.string().describe("The value, as a string matching `type`."),
      type: z
        .string()
        .default("single_line_text_field")
        .describe(
          'Metafield type, e.g. "single_line_text_field", "number_integer", "boolean", "json", ' +
            '"multi_line_text_field". Defaults to single_line_text_field.',
        ),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const ownerResource = args.ownerType === "variant" ? "ProductVariant" : "Product";
      const res = await c.request<{
        metafieldsSet: {
          metafields: Array<{
            id: string;
            namespace: string;
            key: string;
            value: string;
            type: string;
          }> | null;
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(SET_METAFIELDS, {
        metafields: [
          {
            ownerId: toGid(ownerResource, args.ownerId),
            namespace: args.namespace,
            key: args.key,
            value: args.value,
            type: args.type,
          },
        ],
      });
      assertNoUserErrors(res.data.metafieldsSet.userErrors);
      const metafield = res.data.metafieldsSet.metafields?.[0];
      return {
        markdown: metafield
          ? `Set metafield **${metafield.namespace}.${metafield.key}** = \`${metafield.value}\` (${metafield.type}) on ${args.ownerType} ${gidToId(args.ownerId)}.`
          : "Metafield set.",
        structured: { metafield: metafield ? stripGids(metafield) : null },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_assign_variant_media",
    title: "Assign media to variants",
    description:
      "Attach existing product media (images) to specific variants. Two modes: give `mediaId` alone " +
      "to attach that one image to EVERY variant of the product, or give `variantMedia` for explicit " +
      "control. The media must already belong to the product (see shopify_get_product / " +
      "shopify_add_product_media) and be finished processing. Already-attached links are skipped, so " +
      "re-running is safe (no duplicates).",
    inputSchema: {
      productId: z.string().describe("Product that owns the media and variants (numeric or GID)."),
      mediaId: z
        .string()
        .optional()
        .describe(
          "Convenience mode: attach this one media id to every variant of the product. " +
            "Get media ids from shopify_get_product's Media table. Omit `variantMedia` when using this.",
        ),
      variantMedia: z
        .array(
          z.object({
            variantId: z.string().describe("Variant id (numeric or GID)."),
            mediaIds: z.array(z.string()).min(1).describe("Media ids to attach to this variant."),
          }),
        )
        .optional()
        .describe("Explicit mode: attach specific media to specific variants."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const hasExplicit = Array.isArray(args.variantMedia) && args.variantMedia.length > 0;
      const hasConvenience = args.mediaId !== undefined;
      if (hasExplicit === hasConvenience) {
        throw new Error(
          "Provide exactly one of: `mediaId` (attach to all variants) or `variantMedia` (explicit).",
        );
      }

      const productGid = toGid("Product", args.productId);

      // Fetch each variant's currently-attached media for dedupe.
      const existing = new Map<string, Set<string>>();
      let after: string | null = null;
      do {
        const r: {
          data: {
            product: {
              variants: {
                pageInfo: { hasNextPage: boolean; endCursor: string | null };
                nodes: Array<{ id: string; media: { nodes: Array<{ id: string }> } }>;
              };
            } | null;
          };
        } = await c.request(VARIANT_MEDIA, { id: productGid, first: 100, after });
        if (!r.data.product) throw new Error(`No product found with id ${gidToId(args.productId)}.`);
        for (const v of r.data.product.variants.nodes) {
          existing.set(v.id, new Set(v.media.nodes.map((m) => m.id)));
        }
        after = r.data.product.variants.pageInfo.hasNextPage
          ? r.data.product.variants.pageInfo.endCursor
          : null;
      } while (after);

      // Build deduped assignments.
      const assignments: Array<{ variantId: string; mediaIds: string[] }> = [];
      if (hasConvenience) {
        const mediaGid = toGid("MediaImage", args.mediaId!);
        for (const [variantGid, mediaSet] of existing) {
          if (!mediaSet.has(mediaGid)) assignments.push({ variantId: variantGid, mediaIds: [mediaGid] });
        }
      } else {
        for (const vm of args.variantMedia!) {
          const variantGid = toGid("ProductVariant", vm.variantId);
          const mediaSet = existing.get(variantGid) ?? new Set<string>();
          const toAdd = vm.mediaIds
            .map((id) => toGid("MediaImage", id))
            .filter((g) => !mediaSet.has(g));
          if (toAdd.length > 0) assignments.push({ variantId: variantGid, mediaIds: toAdd });
        }
      }

      if (assignments.length === 0) {
        return {
          markdown: "No changes — the media is already attached to the target variant(s).",
          structured: { productId: gidToId(args.productId), assigned: 0 },
          cost: undefined,
        };
      }

      const res = await c.request<{
        productVariantAppendMedia: {
          product: { id: string } | null;
          userErrors: Array<{ code?: string; field: string[] | null; message: string }>;
        };
      }>(APPEND_VARIANT_MEDIA, { productId: productGid, variantMedia: assignments });
      assertNoUserErrors(res.data.productVariantAppendMedia.userErrors);

      const linksAdded = assignments.reduce((n, a) => n + a.mediaIds.length, 0);
      return {
        markdown:
          `Attached media to ${assignments.length} variant(s) on product ${gidToId(args.productId)} ` +
          `(${linksAdded} link(s) added; already-attached ones skipped).`,
        structured: {
          productId: gidToId(args.productId),
          assignments: assignments.map((a) => ({
            variantId: gidToId(a.variantId),
            mediaIds: a.mediaIds.map((m) => gidToId(m)),
          })),
        },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_reorder_option_values",
    title: "Reorder a product option's values",
    description:
      "Set the display order of a product option's values (e.g. put Standard, Foil, B&W, Sketch in " +
      "that order). The order you list the values in IS their new position — the storefront renders " +
      "them accordingly. Identify the option by name or id, and pass ALL of its values in the " +
      "desired order.",
    inputSchema: {
      productId: z.string().describe("Product id (numeric or GID)."),
      optionName: z.string().optional().describe('The option to reorder, by name, e.g. "Print Type".'),
      optionId: z.string().optional().describe("The option to reorder, by id (numeric or GID). Use this OR optionName."),
      values: z
        .array(z.string())
        .min(1)
        .describe(
          'The option values in the desired display order, e.g. ["Standard","Foil","B&W","Sketch"]. ' +
            "Use value names (or GIDs). List every value of the option.",
        ),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      if ((!args.optionName && !args.optionId) || (args.optionName && args.optionId)) {
        throw new Error("Provide exactly one of `optionName` or `optionId`.");
      }

      const optionRef: Record<string, unknown> = args.optionId
        ? { id: toGid("ProductOption", args.optionId) }
        : { name: args.optionName };
      // A value is referenced by GID if it looks like one, otherwise by name.
      optionRef.values = args.values.map((v) =>
        v.startsWith("gid://shopify/") ? { id: v } : { name: v },
      );

      const res = await c.request<{
        productOptionsReorder: {
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(REORDER_OPTION_VALUES, {
        productId: toGid("Product", args.productId),
        options: [optionRef],
      });
      assertNoUserErrors(res.data.productOptionsReorder.userErrors);
      return {
        markdown:
          `Reordered option ${args.optionName ?? gidToId(args.optionId!)} on product ${gidToId(args.productId)} to: ` +
          args.values.join(" → ") +
          ".",
        structured: {
          productId: gidToId(args.productId),
          option: args.optionName ?? gidToId(args.optionId!),
          order: args.values,
        },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_update_product_option",
    title: "Rename a product option and/or its values",
    description:
      "Rename a product option (e.g. \"Print\" → \"Style\") and/or rename its values (e.g. \"Nice\" → " +
      '"11x17 Art Print"). Can also add or delete values. Identify the option by name or id, and ' +
      "rename values by their current name or id. Resolves names to ids for you.",
    inputSchema: {
      productId: z.string().describe("Product id (numeric or GID)."),
      optionName: z.string().optional().describe("The option to change, by its current name."),
      optionId: z.string().optional().describe("The option to change, by id (numeric or GID). Use this OR optionName."),
      name: z.string().optional().describe("New name for the option itself."),
      valuesToRename: z
        .array(
          z.object({
            from: z.string().optional().describe("Current value name to rename (use this or id)."),
            id: z.string().optional().describe("Value id to rename (numeric or GID)."),
            to: z.string().describe("New value name."),
          }),
        )
        .optional()
        .describe('Rename option values, e.g. [{from:"Nice", to:"11x17 Art Print"}].'),
      valuesToAdd: z.array(z.string()).optional().describe("New value names to add to the option."),
      valuesToDelete: z
        .array(z.string())
        .optional()
        .describe("Value names or ids to delete from the option."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (args, c) => {
      if ((!args.optionName && !args.optionId) || (args.optionName && args.optionId)) {
        throw new Error("Provide exactly one of `optionName` or `optionId`.");
      }

      // Resolve the option and its value name→id map from the product.
      const optRes = await c.request<{
        product: {
          options: Array<{
            id: string;
            name: string;
            position: number;
            optionValues: Array<{ id: string; name: string }>;
          }>;
        } | null;
      }>(GET_PRODUCT_OPTIONS, { id: toGid("Product", args.productId) });
      if (!optRes.data.product) throw new Error(`No product found with id ${gidToId(args.productId)}.`);

      const wantOptionGid = args.optionId ? toGid("ProductOption", args.optionId) : undefined;
      const option = optRes.data.product.options.find((o) =>
        wantOptionGid ? o.id === wantOptionGid : o.name === args.optionName,
      );
      if (!option) {
        throw new Error(
          `Option ${args.optionName ?? gidToId(args.optionId!)} not found on product ${gidToId(args.productId)}.`,
        );
      }
      const valueIdByName = new Map(option.optionValues.map((v) => [v.name, v.id]));

      /** Resolves a value reference (id or name) to its GID. */
      const resolveValueGid = (ref: { id?: string; from?: string }): string => {
        if (ref.id) return toGid("ProductOptionValue", ref.id);
        const id = ref.from ? valueIdByName.get(ref.from) : undefined;
        if (!id) throw new Error(`Option value "${ref.from}" not found on option "${option.name}".`);
        return id;
      };

      const variables: Record<string, unknown> = {
        productId: toGid("Product", args.productId),
        option: { id: option.id, ...(args.name !== undefined ? { name: args.name } : {}) },
        variantStrategy: "LEAVE_AS_IS",
      };
      if (args.valuesToRename && args.valuesToRename.length > 0) {
        variables.optionValuesToUpdate = args.valuesToRename.map((v) => ({
          id: resolveValueGid(v),
          name: v.to,
        }));
      }
      if (args.valuesToAdd && args.valuesToAdd.length > 0) {
        variables.optionValuesToAdd = args.valuesToAdd.map((name) => ({ name }));
      }
      if (args.valuesToDelete && args.valuesToDelete.length > 0) {
        variables.optionValuesToDelete = args.valuesToDelete.map((v) =>
          v.startsWith("gid://shopify/") ? v : valueIdByName.get(v) ?? toGid("ProductOptionValue", v),
        );
      }

      const res = await c.request<{
        productOptionUpdate: {
          product: { id: string } | null;
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(UPDATE_PRODUCT_OPTION, variables);
      assertNoUserErrors(res.data.productOptionUpdate.userErrors);

      const changes: string[] = [];
      if (args.name !== undefined) changes.push(`option → "${args.name}"`);
      if (args.valuesToRename?.length) {
        changes.push(...args.valuesToRename.map((v) => `"${v.from ?? gidToId(v.id!)}" → "${v.to}"`));
      }
      if (args.valuesToAdd?.length) changes.push(`added [${args.valuesToAdd.join(", ")}]`);
      if (args.valuesToDelete?.length) changes.push(`deleted [${args.valuesToDelete.join(", ")}]`);
      return {
        markdown:
          `Updated option "${option.name}" on product ${gidToId(args.productId)}: ` +
          (changes.length ? changes.join("; ") : "no changes") +
          ".",
        structured: { productId: gidToId(args.productId), option: option.name, changes },
        cost: res.cost,
      };
    },
  });
}
