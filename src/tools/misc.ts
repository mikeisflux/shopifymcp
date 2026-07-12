/**
 * Miscellaneous tools:
 *   read  — list_collections, search, graphql_query (read-only escape hatch)
 *   write — create_discount_code, tag_resource
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ShopifyClient, ShopifyError, assertNoUserErrors } from "../shopify-client.js";
import { registerTool, paginationShape } from "./shared.js";
import { gidToId, toGid, markdownTable, stripGids } from "../format.js";

// ─── Collections ─────────────────────────────────────────────────────────────

const LIST_COLLECTIONS = /* GraphQL */ `
  query ListCollections($first: Int!, $after: String, $query: String) {
    collections(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id title handle updatedAt
        productsCount { count }
        ruleSet { appliedDisjunctively rules { column relation condition } }
      }
    }
  }
`;

// ─── Generic search ──────────────────────────────────────────────────────────

const SEARCH = /* GraphQL */ `
  query Search($query: String!, $first: Int!) {
    products(first: $first, query: $query) { nodes { id title status } }
    orders(first: $first, query: $query) { nodes { id name displayFinancialStatus } }
    customers(first: $first, query: $query) { nodes { id displayName email } }
  }
`;

// ─── Discounts & tags ────────────────────────────────────────────────────────

const CREATE_DISCOUNT = /* GraphQL */ `
  mutation CreateDiscount($basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode {
        id
        codeDiscount {
          ... on DiscountCodeBasic {
            title
            codes(first: 1) { nodes { code } }
          }
        }
      }
      userErrors { field message }
    }
  }
`;

const TAGS_ADD = /* GraphQL */ `
  mutation TagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

const TAGS_REMOVE = /* GraphQL */ `
  mutation TagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

const RESOURCE_GID: Record<string, string> = {
  product: "Product",
  order: "Order",
  customer: "Customer",
  draft_order: "DraftOrder",
};

const UPDATE_SHIPPING_PACKAGE = /* GraphQL */ `
  mutation UpdateShippingPackage($id: ID!, $shippingPackage: CustomShippingPackageInput!) {
    shippingPackageUpdate(id: $id, shippingPackage: $shippingPackage) {
      userErrors { field message }
    }
  }
`;

const CREATE_COLLECTION = /* GraphQL */ `
  mutation CreateCollection($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection {
        id title handle sortOrder
        ruleSet { appliedDisjunctively rules { column relation condition } }
      }
      userErrors { field message }
    }
  }
`;

const UPDATE_COLLECTION = /* GraphQL */ `
  mutation UpdateCollection($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection {
        id title handle sortOrder
        ruleSet { appliedDisjunctively rules { column relation condition } }
      }
      userErrors { field message }
    }
  }
`;

const ADD_PRODUCTS_TO_COLLECTION = /* GraphQL */ `
  mutation AddProductsToCollection($id: ID!, $productIds: [ID!]!) {
    collectionAddProducts(id: $id, productIds: $productIds) {
      collection { id title }
      userErrors { field message }
    }
  }
`;

const REMOVE_PRODUCTS_FROM_COLLECTION = /* GraphQL */ `
  mutation RemoveProductsFromCollection($id: ID!, $productIds: [ID!]!) {
    collectionRemoveProducts(id: $id, productIds: $productIds) {
      job { id done }
      userErrors { field message }
    }
  }
`;

/** Zod shape for a smart-collection rule set, shared by create/update. */
const ruleSetShape = z
  .object({
    appliedDisjunctively: z
      .boolean()
      .default(false)
      .describe("true = product matches ANY rule (OR); false = must match ALL rules (AND)."),
    rules: z
      .array(
        z.object({
          column: z
            .string()
            .describe(
              'Rule column, e.g. "TAG", "TITLE", "TYPE", "VENDOR", "VARIANT_PRICE", "IS_PRICE_REDUCED".',
            ),
          relation: z
            .string()
            .describe(
              'Relation, e.g. "EQUALS", "NOT_EQUALS", "CONTAINS", "STARTS_WITH", "ENDS_WITH", ' +
                '"GREATER_THAN", "LESS_THAN", "IS_SET", "IS_NOT_SET".',
            ),
          condition: z.string().describe('Value to compare against, e.g. "sale" or "200".'),
        }),
      )
      .min(1)
      .describe("One or more rules."),
  })
  .describe("Smart/automated collection rules. Omit entirely for a manual collection.");

const COLLECTION_SORT_ORDERS = [
  "MANUAL",
  "BEST_SELLING",
  "ALPHA_ASC",
  "ALPHA_DESC",
  "PRICE_DESC",
  "PRICE_ASC",
  "CREATED",
  "CREATED_DESC",
] as const;

function buildCollectionInput(args: {
  title?: string;
  descriptionHtml?: string;
  handle?: string;
  sortOrder?: string;
  seoTitle?: string;
  seoDescription?: string;
  ruleSet?: { appliedDisjunctively: boolean; rules: Array<{ column: string; relation: string; condition: string }> };
}): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (args.title !== undefined) input.title = args.title;
  if (args.descriptionHtml !== undefined) input.descriptionHtml = args.descriptionHtml;
  if (args.handle !== undefined) input.handle = args.handle;
  if (args.sortOrder !== undefined) input.sortOrder = args.sortOrder;
  if (args.seoTitle !== undefined || args.seoDescription !== undefined) {
    input.seo = { title: args.seoTitle, description: args.seoDescription };
  }
  if (args.ruleSet !== undefined) {
    input.ruleSet = {
      appliedDisjunctively: args.ruleSet.appliedDisjunctively,
      rules: args.ruleSet.rules.map((r) => ({
        column: r.column,
        relation: r.relation,
        condition: r.condition,
      })),
    };
  }
  return input;
}

/** Rejects any operation containing a GraphQL `mutation` keyword. */
function assertReadOnly(query: string): void {
  if (/\bmutation\b/i.test(query)) {
    throw new ShopifyError(
      "This tool only runs read-only queries. The query contains a `mutation` — use the dedicated write tools instead.",
    );
  }
}

export function registerReadMiscTools(server: McpServer, client: ShopifyClient): void {
  registerTool(server, client, {
    name: "shopify_list_collections",
    title: "List collections",
    description:
      "List collections (both smart/automated and custom/manual). Returns id, title, handle, " +
      "product count, and whether the collection is smart or custom.",
    inputSchema: {
      query: z.string().optional().describe('Free-text search, e.g. "title:Summer".'),
      ...paginationShape,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{
        collections: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<{
            id: string;
            title: string;
            handle: string;
            productsCount: { count: number } | null;
            ruleSet: unknown | null;
          }>;
        };
      }>(LIST_COLLECTIONS, { first: args.first, after: args.after, query: args.query });

      const { collections } = res.data;
      const rows = collections.nodes.map((col) => [
        gidToId(col.id),
        col.title,
        col.handle,
        col.productsCount?.count ?? 0,
        col.ruleSet ? "smart" : "custom",
      ]);

      const markdown =
        collections.nodes.length === 0
          ? "No collections matched."
          : markdownTable(["ID", "Title", "Handle", "Products", "Type"], rows, args.first) +
            (collections.pageInfo.hasNextPage
              ? `\n\n_More available. Pass \`after: "${collections.pageInfo.endCursor}"\` for the next page._`
              : "");

      return {
        markdown,
        structured: { collections: stripGids(collections.nodes), pageInfo: collections.pageInfo },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_search",
    title: "Search across resources",
    description:
      "Quick cross-resource search: returns the top matching products, orders and customers for a " +
      "single query string. For deeper filtering use the dedicated list tools.",
    inputSchema: {
      query: z.string().describe("Search term applied to products, orders and customers."),
      limit: z.number().int().min(1).max(20).default(5).describe("Max results per resource type."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{
        products: { nodes: Array<{ id: string; title: string; status: string }> };
        orders: { nodes: Array<{ id: string; name: string; displayFinancialStatus: string | null }> };
        customers: { nodes: Array<{ id: string; displayName: string; email: string | null }> };
      }>(SEARCH, { query: args.query, first: args.limit });

      const sections: string[] = [];
      if (res.data.products.nodes.length) {
        sections.push(
          "**Products**\n\n" +
            markdownTable(
              ["ID", "Title", "Status"],
              res.data.products.nodes.map((p) => [gidToId(p.id), p.title, p.status]),
            ),
        );
      }
      if (res.data.orders.nodes.length) {
        sections.push(
          "**Orders**\n\n" +
            markdownTable(
              ["ID", "Order", "Financial"],
              res.data.orders.nodes.map((o) => [gidToId(o.id), o.name, o.displayFinancialStatus ?? ""]),
            ),
        );
      }
      if (res.data.customers.nodes.length) {
        sections.push(
          "**Customers**\n\n" +
            markdownTable(
              ["ID", "Name", "Email"],
              res.data.customers.nodes.map((cu) => [gidToId(cu.id), cu.displayName, cu.email ?? ""]),
            ),
        );
      }

      return {
        markdown: sections.length ? sections.join("\n\n") : `No matches for "${args.query}".`,
        structured: stripGids(res.data),
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_graphql_query",
    title: "Run a read-only GraphQL query",
    description:
      "Escape hatch: run an arbitrary READ-ONLY Shopify Admin GraphQL query. Mutations are rejected. " +
      "Pass variables as a JSON object. Returns the raw data.",
    inputSchema: {
      query: z.string().describe("A GraphQL query (read-only). Must not contain a mutation."),
      variables: z
        .record(z.unknown())
        .optional()
        .describe("Optional variables object for the query."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      assertReadOnly(args.query);
      const res = await c.request<Record<string, unknown>>(args.query, args.variables);
      return {
        markdown: "```json\n" + JSON.stringify(stripGids(res.data), null, 2) + "\n```",
        structured: { data: stripGids(res.data) },
        cost: res.cost,
      };
    },
  });
}

export function registerWriteMiscTools(server: McpServer, client: ShopifyClient): void {
  registerTool(server, client, {
    name: "shopify_create_discount_code",
    title: "Create discount code",
    description:
      "Create a basic code discount (percentage or fixed amount) that applies to the whole order " +
      "for all customers.",
    inputSchema: {
      code: z.string().describe("The discount code customers enter, e.g. SUMMER10."),
      title: z.string().optional().describe("Internal title. Defaults to the code."),
      valueType: z.enum(["PERCENTAGE", "FIXED_AMOUNT"]).default("PERCENTAGE"),
      value: z
        .number()
        .positive()
        .describe("For PERCENTAGE, e.g. 10 = 10%. For FIXED_AMOUNT, the currency amount, e.g. 5."),
      startsAt: z
        .string()
        .optional()
        .describe("ISO datetime the code becomes active. Defaults to now."),
      endsAt: z.string().optional().describe("ISO datetime the code expires. Optional."),
      appliesOncePerCustomer: z.boolean().default(false),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (args, c) => {
      const customerGetsValue =
        args.valueType === "PERCENTAGE"
          ? { percentage: args.value / 100 }
          : { discountAmount: { amount: args.value, appliesOnEachItem: false } };

      const basicCodeDiscount: Record<string, unknown> = {
        title: args.title ?? args.code,
        code: args.code,
        startsAt: args.startsAt ?? new Date().toISOString(),
        customerSelection: { all: true },
        customerGets: { value: customerGetsValue, items: { all: true } },
        appliesOncePerCustomer: args.appliesOncePerCustomer,
      };
      if (args.endsAt) basicCodeDiscount.endsAt = args.endsAt;

      const res = await c.request<{
        discountCodeBasicCreate: {
          codeDiscountNode: {
            id: string;
            codeDiscount: { title: string; codes: { nodes: Array<{ code: string }> } };
          } | null;
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(CREATE_DISCOUNT, { basicCodeDiscount });

      assertNoUserErrors(res.data.discountCodeBasicCreate.userErrors);
      const node = res.data.discountCodeBasicCreate.codeDiscountNode!;
      const code = node.codeDiscount.codes.nodes[0]?.code ?? args.code;
      return {
        markdown: `Created discount code **${code}** (id ${gidToId(node.id)}, ${args.value}${args.valueType === "PERCENTAGE" ? "%" : ""} off).`,
        structured: { discount: stripGids(node) },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_tag_resource",
    title: "Add or remove tags",
    description: "Add or remove tags on a product, order, customer, or draft order.",
    inputSchema: {
      resourceType: z
        .enum(["product", "order", "customer", "draft_order"])
        .describe("The kind of resource to tag."),
      id: z.string().describe("Resource id (numeric or GID)."),
      tags: z.array(z.string()).min(1).describe("Tags to add or remove."),
      action: z.enum(["add", "remove"]).default("add"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const gid = toGid(RESOURCE_GID[args.resourceType]!, args.id);
      const res = await c.request<{
        tagsAdd?: { node: { id: string } | null; userErrors: Array<{ field: string[] | null; message: string }> };
        tagsRemove?: { node: { id: string } | null; userErrors: Array<{ field: string[] | null; message: string }> };
      }>(args.action === "add" ? TAGS_ADD : TAGS_REMOVE, { id: gid, tags: args.tags });

      const payload = args.action === "add" ? res.data.tagsAdd : res.data.tagsRemove;
      assertNoUserErrors(payload?.userErrors);
      return {
        markdown: `${args.action === "add" ? "Added" : "Removed"} tag(s) [${args.tags.join(", ")}] ${args.action === "add" ? "to" : "from"} ${args.resourceType} ${gidToId(args.id)}.`,
        structured: { id: gidToId(gid), tags: args.tags, action: args.action },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_update_shipping_package",
    title: "Update a saved shipping package",
    description:
      "Update one of the store's saved shipping packages (Settings → Shipping → Packages) — its " +
      "name, type, empty weight, dimensions, and/or default flag. Requires a shipping/delivery " +
      "scope (e.g. write_shipping). Note: Shopify's Admin API has NO query to list packages, so " +
      "you must supply the package's GID (find it in the admin URL when editing the package).",
    inputSchema: {
      id: z
        .string()
        .describe(
          "The shipping package GID, e.g. gid://shopify/CustomShippingPackage/123. Find it in the " +
            "admin URL when editing the package (there is no API to list packages).",
        ),
      name: z.string().optional().describe("Package name/label."),
      type: z
        .string()
        .optional()
        .describe('Shopify ShippingPackageType, e.g. "BOX", "ENVELOPE", "SOFT_PACKAGE".'),
      weight: z
        .object({
          value: z.number().describe("Empty package weight value."),
          unit: z.enum(["GRAMS", "KILOGRAMS", "OUNCES", "POUNDS"]).describe("Weight unit."),
        })
        .optional()
        .describe("Weight of the empty package."),
      dimensions: z
        .object({
          length: z.number(),
          width: z.number(),
          height: z.number(),
          unit: z
            .enum(["MILLIMETERS", "CENTIMETERS", "METERS", "INCHES", "FEET", "YARDS"])
            .describe("Length unit for all three dimensions."),
        })
        .optional()
        .describe("Package dimensions."),
      isDefault: z
        .boolean()
        .optional()
        .describe("Set true to make this the store's default package."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const shippingPackage: Record<string, unknown> = {};
      if (args.name !== undefined) shippingPackage.name = args.name;
      if (args.type !== undefined) shippingPackage.type = args.type;
      if (args.weight !== undefined) {
        shippingPackage.weight = { value: args.weight.value, unit: args.weight.unit };
      }
      if (args.dimensions !== undefined) {
        shippingPackage.dimensions = {
          length: args.dimensions.length,
          width: args.dimensions.width,
          height: args.dimensions.height,
          unit: args.dimensions.unit,
        };
      }
      if (args.isDefault !== undefined) shippingPackage.default = args.isDefault;

      const res = await c.request<{
        shippingPackageUpdate: {
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(UPDATE_SHIPPING_PACKAGE, {
        // Pass the GID through as-is (there's no numeric->GID mapping we can rely on here).
        id: args.id,
        shippingPackage,
      });
      assertNoUserErrors(res.data.shippingPackageUpdate.userErrors);
      return {
        markdown: `Updated shipping package ${gidToId(args.id)}.`,
        structured: { id: gidToId(args.id), updated: shippingPackage },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_create_collection",
    title: "Create collection",
    description:
      "Create a collection. Omit `ruleSet` for a manual collection (add products with " +
      "shopify_add_products_to_collection), or provide `ruleSet` for a smart/automated collection " +
      "whose membership is defined by rules.",
    inputSchema: {
      title: z.string().describe("Collection title."),
      descriptionHtml: z.string().optional().describe("Description (HTML allowed)."),
      handle: z.string().optional().describe("URL handle/slug. Auto-generated from the title if omitted."),
      sortOrder: z
        .enum(COLLECTION_SORT_ORDERS)
        .optional()
        .describe("How products are ordered within the collection."),
      seoTitle: z.string().optional().describe("SEO/browser title tag."),
      seoDescription: z.string().optional().describe("SEO meta description."),
      ruleSet: ruleSetShape.optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (args, c) => {
      const res = await c.request<{
        collectionCreate: {
          collection: {
            id: string;
            title: string;
            handle: string;
            sortOrder: string;
            ruleSet: unknown | null;
          } | null;
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(CREATE_COLLECTION, { input: buildCollectionInput(args) });
      assertNoUserErrors(res.data.collectionCreate.userErrors);
      const col = res.data.collectionCreate.collection!;
      return {
        markdown: `Created ${col.ruleSet ? "smart" : "manual"} collection **${col.title}** (id ${gidToId(col.id)}, handle ${col.handle}).`,
        structured: { collection: stripGids(col) },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_update_collection",
    title: "Update collection",
    description:
      "Update a collection: title, description, handle, sort order, SEO, and — for smart " +
      "collections — its rule set. Only the fields you provide are changed.",
    inputSchema: {
      id: z.string().describe("Collection id (numeric or GID)."),
      title: z.string().optional(),
      descriptionHtml: z.string().optional(),
      handle: z.string().optional(),
      sortOrder: z.enum(COLLECTION_SORT_ORDERS).optional(),
      seoTitle: z.string().optional(),
      seoDescription: z.string().optional(),
      ruleSet: ruleSetShape.optional().describe("Replaces the smart collection's rules (smart collections only)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const input = buildCollectionInput(args);
      input.id = toGid("Collection", args.id);
      const res = await c.request<{
        collectionUpdate: {
          collection: { id: string; title: string; handle: string } | null;
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(UPDATE_COLLECTION, { input });
      assertNoUserErrors(res.data.collectionUpdate.userErrors);
      const col = res.data.collectionUpdate.collection!;
      return {
        markdown: `Updated collection **${col.title}** (id ${gidToId(col.id)}, handle ${col.handle}).`,
        structured: { collection: stripGids(col) },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_add_products_to_collection",
    title: "Add products to collection",
    description:
      "Add products to a MANUAL collection. Fails for smart collections (their membership is " +
      "rule-based) and if a product is already in the collection.",
    inputSchema: {
      collectionId: z.string().describe("Manual collection id (numeric or GID)."),
      productIds: z.array(z.string()).min(1).describe("Product ids to add (numeric or GID)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (args, c) => {
      const res = await c.request<{
        collectionAddProducts: {
          collection: { id: string; title: string } | null;
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(ADD_PRODUCTS_TO_COLLECTION, {
        id: toGid("Collection", args.collectionId),
        productIds: args.productIds.map((id) => toGid("Product", id)),
      });
      assertNoUserErrors(res.data.collectionAddProducts.userErrors);
      return {
        markdown: `Added ${args.productIds.length} product(s) to collection ${gidToId(args.collectionId)}.`,
        structured: {
          collectionId: gidToId(args.collectionId),
          productIds: args.productIds.map((id) => gidToId(id)),
        },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_remove_products_from_collection",
    title: "Remove products from collection",
    description:
      "Remove products from a MANUAL collection. Shopify processes this asynchronously and returns " +
      "a job id.",
    inputSchema: {
      collectionId: z.string().describe("Manual collection id (numeric or GID)."),
      productIds: z.array(z.string()).min(1).describe("Product ids to remove (numeric or GID)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{
        collectionRemoveProducts: {
          job: { id: string; done: boolean } | null;
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(REMOVE_PRODUCTS_FROM_COLLECTION, {
        id: toGid("Collection", args.collectionId),
        productIds: args.productIds.map((id) => toGid("Product", id)),
      });
      assertNoUserErrors(res.data.collectionRemoveProducts.userErrors);
      const job = res.data.collectionRemoveProducts.job;
      return {
        markdown:
          `Queued removal of ${args.productIds.length} product(s) from collection ${gidToId(args.collectionId)}` +
          (job ? ` (job ${gidToId(job.id)}${job.done ? ", done" : ", processing"}).` : "."),
        structured: {
          collectionId: gidToId(args.collectionId),
          productIds: args.productIds.map((id) => gidToId(id)),
          job,
        },
        cost: res.cost,
      };
    },
  });
}
