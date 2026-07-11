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
}
