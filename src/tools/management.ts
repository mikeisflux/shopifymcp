/**
 * Store-management tools that filled typed gaps:
 *   read  — list/get metaobjects, list metaobject definitions, list URL redirects
 *   write — create/update/delete metaobjects, bulk product status, create/delete URL redirects
 *
 * Anything not covered by a typed tool is still reachable via
 * shopify_graphql_query (reads) and shopify_graphql_mutation (writes).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ShopifyClient, assertNoUserErrors } from "../shopify-client.js";
import { registerTool } from "./shared.js";
import { gidToId, toGid, markdownTable, stripGids } from "../format.js";
import { collectProductGids } from "./inventory.js";

// ─── Metaobjects ─────────────────────────────────────────────────────────────

const LIST_METAOBJECTS = /* GraphQL */ `
  query ListMetaobjects($type: String!, $first: Int!, $after: String) {
    metaobjects(type: $type, first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id handle type displayName fields { key value type } }
    }
  }
`;

const GET_METAOBJECT_BY_ID = /* GraphQL */ `
  query GetMetaobject($id: ID!) {
    metaobject(id: $id) { id handle type displayName fields { key value type } }
  }
`;

const GET_METAOBJECT_BY_HANDLE = /* GraphQL */ `
  query GetMetaobjectByHandle($handle: MetaobjectHandleInput!) {
    metaobjectByHandle(handle: $handle) { id handle type displayName fields { key value type } }
  }
`;

const LIST_METAOBJECT_DEFINITIONS = /* GraphQL */ `
  query ListMetaobjectDefinitions($first: Int!, $after: String) {
    metaobjectDefinitions(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id name type
        fieldDefinitions { key name required type { name } }
      }
    }
  }
`;

const CREATE_METAOBJECT = /* GraphQL */ `
  mutation CreateMetaobject($metaobject: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $metaobject) {
      metaobject { id handle type displayName fields { key value } }
      userErrors { field message code }
    }
  }
`;

const UPDATE_METAOBJECT = /* GraphQL */ `
  mutation UpdateMetaobject($id: ID!, $metaobject: MetaobjectUpdateInput!) {
    metaobjectUpdate(id: $id, metaobject: $metaobject) {
      metaobject { id handle type displayName fields { key value } }
      userErrors { field message code }
    }
  }
`;

const DELETE_METAOBJECT = /* GraphQL */ `
  mutation DeleteMetaobject($id: ID!) {
    metaobjectDelete(id: $id) {
      deletedId
      userErrors { field message code }
    }
  }
`;

// ─── URL redirects ───────────────────────────────────────────────────────────

const LIST_REDIRECTS = /* GraphQL */ `
  query ListUrlRedirects($first: Int!, $after: String, $query: String) {
    urlRedirects(first: $first, after: $after, query: $query) {
      pageInfo { hasNextPage endCursor }
      nodes { id path target }
    }
  }
`;

const CREATE_REDIRECT = /* GraphQL */ `
  mutation CreateUrlRedirect($urlRedirect: UrlRedirectInput!) {
    urlRedirectCreate(urlRedirect: $urlRedirect) {
      urlRedirect { id path target }
      userErrors { field message }
    }
  }
`;

const DELETE_REDIRECT = /* GraphQL */ `
  mutation DeleteUrlRedirect($id: ID!) {
    urlRedirectDelete(id: $id) {
      deletedUrlRedirectId
      userErrors { field message }
    }
  }
`;

// ─── Collections (detail / reorder / image) ──────────────────────────────────

const GET_COLLECTION = /* GraphQL */ `
  query GetCollection($id: ID!) {
    collection(id: $id) {
      id title handle descriptionHtml sortOrder updatedAt
      seo { title description }
      image { url altText }
      productsCount { count }
      ruleSet { appliedDisjunctively rules { column relation condition } }
    }
  }
`;

const REORDER_COLLECTION_PRODUCTS = /* GraphQL */ `
  mutation CollectionReorder($id: ID!, $moves: [MoveInput!]!) {
    collectionReorderProducts(id: $id, moves: $moves) {
      job { id done }
      userErrors { field message }
    }
  }
`;

const SET_COLLECTION_IMAGE = /* GraphQL */ `
  mutation CollectionSetImage($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection { id title image { url altText } }
      userErrors { field message }
    }
  }
`;

// ─── Bulk product status ─────────────────────────────────────────────────────

const PRODUCT_STATUS_UPDATE = /* GraphQL */ `
  mutation ProductStatusUpdate($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product { id status }
      userErrors { field message }
    }
  }
`;

const PRODUCTS_BY_TYPE = /* GraphQL */ `
  query ProductsByType($first: Int!, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query) {
      pageInfo { hasNextPage endCursor }
      nodes { id }
    }
  }
`;

interface MetaobjectNode {
  id: string;
  handle: string;
  type: string;
  displayName: string | null;
  fields: Array<{ key: string; value: string | null; type?: string }>;
}

export function registerManagementReadTools(server: McpServer, client: ShopifyClient): void {
  registerTool(server, client, {
    name: "shopify_list_metaobjects",
    title: "List metaobjects",
    description:
      "List metaobject entries of a given type (e.g. custom content records). Use " +
      "shopify_list_metaobject_definitions first to discover the available types.",
    inputSchema: {
      type: z.string().describe('Metaobject definition type, e.g. "author" or "faq_item".'),
      first: z.number().int().min(1).max(100).default(50).describe("Max entries to return. Default 50."),
      after: z.string().optional().describe("Pagination cursor from a previous page."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{
        metaobjects: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: MetaobjectNode[] };
      }>(LIST_METAOBJECTS, { type: args.type, first: args.first, after: args.after ?? null });
      const nodes = res.data.metaobjects.nodes;
      return {
        markdown: nodes.length
          ? markdownTable(["ID", "Handle", "Display name"], nodes.map((n) => [gidToId(n.id), n.handle, n.displayName ?? ""]))
          : `No metaobjects of type "${args.type}".`,
        structured: { metaobjects: stripGids(nodes), pageInfo: res.data.metaobjects.pageInfo },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_get_metaobject",
    title: "Get a metaobject",
    description: "Fetch one metaobject and all its fields, by id OR by type + handle.",
    inputSchema: {
      id: z.string().optional().describe("Metaobject id (numeric or GID)."),
      type: z.string().optional().describe("Metaobject type (required with `handle`)."),
      handle: z.string().optional().describe("Metaobject handle (required with `type`)."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      let node: MetaobjectNode | null;
      let cost: number | undefined;
      if (args.id) {
        const res = await c.request<{ metaobject: MetaobjectNode | null }>(GET_METAOBJECT_BY_ID, { id: toGid("Metaobject", args.id) });
        node = res.data.metaobject;
        cost = res.cost;
      } else if (args.type && args.handle) {
        const res = await c.request<{ metaobjectByHandle: MetaobjectNode | null }>(GET_METAOBJECT_BY_HANDLE, { handle: { type: args.type, handle: args.handle } });
        node = res.data.metaobjectByHandle;
        cost = res.cost;
      } else {
        throw new Error("Provide either `id`, or both `type` and `handle`.");
      }
      if (!node) throw new Error("Metaobject not found.");
      const fieldTable = markdownTable(["Field", "Value"], node.fields.map((f) => [f.key, f.value ?? ""]));
      return {
        markdown: `## ${node.displayName ?? node.handle} (${node.type})\n\n${fieldTable}`,
        structured: { metaobject: stripGids(node) },
        cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_list_metaobject_definitions",
    title: "List metaobject definitions",
    description: "List the store's metaobject definitions (the schemas) with their types and field definitions. Use the `type` values with shopify_list_metaobjects / create.",
    inputSchema: {
      first: z.number().int().min(1).max(100).default(50).describe("Max definitions to return. Default 50."),
      after: z.string().optional().describe("Pagination cursor from a previous page."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{
        metaobjectDefinitions: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<{ id: string; name: string; type: string; fieldDefinitions: Array<{ key: string; name: string; required: boolean; type: { name: string } }> }>;
        };
      }>(LIST_METAOBJECT_DEFINITIONS, { first: args.first, after: args.after ?? null });
      const nodes = res.data.metaobjectDefinitions.nodes;
      return {
        markdown: nodes.length
          ? nodes.map((d) => `- **${d.name}** (type \`${d.type}\`): ${d.fieldDefinitions.map((f) => `${f.key}:${f.type.name}${f.required ? "*" : ""}`).join(", ")}`).join("\n")
          : "No metaobject definitions found.",
        structured: { definitions: stripGids(nodes), pageInfo: res.data.metaobjectDefinitions.pageInfo },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_list_url_redirects",
    title: "List URL redirects",
    description: "List the store's URL redirects (old path → target). Optionally filter with a search query, e.g. a path fragment.",
    inputSchema: {
      first: z.number().int().min(1).max(250).default(100).describe("Max redirects to return. Default 100."),
      after: z.string().optional().describe("Pagination cursor."),
      query: z.string().optional().describe('Optional search, e.g. "path:/old-url".'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{
        urlRedirects: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<{ id: string; path: string; target: string }> };
      }>(LIST_REDIRECTS, { first: args.first, after: args.after ?? null, query: args.query ?? null });
      const nodes = res.data.urlRedirects.nodes;
      return {
        markdown: nodes.length
          ? markdownTable(["ID", "From path", "Target"], nodes.map((r) => [gidToId(r.id), r.path, r.target]))
          : "No URL redirects found.",
        structured: { redirects: stripGids(nodes), pageInfo: res.data.urlRedirects.pageInfo },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_get_collection",
    title: "Get a collection",
    description:
      "Fetch one collection's detail: title, handle, description, sort order, SEO, image, product " +
      "count, and — for smart collections — its rule set. Use before editing to see the current state.",
    inputSchema: { id: z.string().describe("Collection id (numeric or GID).") },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{
        collection: {
          id: string; title: string; handle: string; descriptionHtml: string | null; sortOrder: string;
          seo: { title: string | null; description: string | null } | null;
          image: { url: string; altText: string | null } | null;
          productsCount: { count: number } | null;
          ruleSet: { appliedDisjunctively: boolean; rules: Array<{ column: string; relation: string; condition: string }> } | null;
        } | null;
      }>(GET_COLLECTION, { id: toGid("Collection", args.id) });
      const col = res.data.collection;
      if (!col) throw new Error(`No collection found with id ${gidToId(args.id)}.`);
      const kind = col.ruleSet ? "smart" : "manual";
      const rules = col.ruleSet
        ? `\n\nRules (${col.ruleSet.appliedDisjunctively ? "ANY" : "ALL"}):\n` +
          col.ruleSet.rules.map((r) => `- ${r.column} ${r.relation} ${r.condition}`).join("\n")
        : "";
      return {
        markdown:
          `## ${col.title} (${kind}, id ${gidToId(col.id)})\n` +
          `- Handle: ${col.handle}\n- Sort order: ${col.sortOrder}\n- Products: ${col.productsCount?.count ?? "?"}` +
          rules,
        structured: { collection: stripGids(col) },
        cost: res.cost,
      };
    },
  });
}

export function registerManagementWriteTools(server: McpServer, client: ShopifyClient): void {
  const publishableCapability = (status: "ACTIVE" | "DRAFT" | undefined): Record<string, unknown> | undefined =>
    status ? { capabilities: { publishable: { status } } } : undefined;

  registerTool(server, client, {
    name: "shopify_create_metaobject",
    title: "Create metaobject",
    description:
      "Create a metaobject entry of a given type. Fields are key/value pairs; values are strings " +
      "(JSON-encode list/reference values as Shopify expects for that field type). Optionally set a " +
      "handle and publish status.",
    inputSchema: {
      type: z.string().describe('Metaobject definition type, e.g. "author".'),
      fields: z
        .array(z.object({ key: z.string(), value: z.string() }))
        .describe("Field values as [{key, value}] pairs. Values are strings."),
      handle: z.string().optional().describe("Optional unique handle for this entry."),
      status: z.enum(["ACTIVE", "DRAFT"]).optional().describe("Publish status (for publishable definitions)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (args, c) => {
      const metaobject: Record<string, unknown> = { type: args.type, fields: args.fields };
      if (args.handle !== undefined) metaobject.handle = args.handle;
      const cap = publishableCapability(args.status);
      if (cap) Object.assign(metaobject, cap);
      const res = await c.request<{
        metaobjectCreate: { metaobject: MetaobjectNode | null; userErrors: Array<{ field: string[] | null; message: string; code: string | null }> };
      }>(CREATE_METAOBJECT, { metaobject });
      assertNoUserErrors(res.data.metaobjectCreate.userErrors);
      const m = res.data.metaobjectCreate.metaobject!;
      return {
        markdown: `Created metaobject **${m.displayName ?? m.handle}** (${m.type}, id ${gidToId(m.id)}).`,
        structured: { metaobject: stripGids(m) },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_update_metaobject",
    title: "Update metaobject",
    description: "Update a metaobject's fields, handle, or publish status. Only the fields you pass are changed; fields not listed are left as-is.",
    inputSchema: {
      id: z.string().describe("Metaobject id (numeric or GID)."),
      fields: z.array(z.object({ key: z.string(), value: z.string() })).optional().describe("Field values to set, as [{key, value}]."),
      handle: z.string().optional().describe("New handle."),
      status: z.enum(["ACTIVE", "DRAFT"]).optional().describe("Publish status."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const metaobject: Record<string, unknown> = {};
      if (args.fields !== undefined) metaobject.fields = args.fields;
      if (args.handle !== undefined) metaobject.handle = args.handle;
      const cap = publishableCapability(args.status);
      if (cap) Object.assign(metaobject, cap);
      const res = await c.request<{
        metaobjectUpdate: { metaobject: MetaobjectNode | null; userErrors: Array<{ field: string[] | null; message: string; code: string | null }> };
      }>(UPDATE_METAOBJECT, { id: toGid("Metaobject", args.id), metaobject });
      assertNoUserErrors(res.data.metaobjectUpdate.userErrors);
      const m = res.data.metaobjectUpdate.metaobject!;
      return {
        markdown: `Updated metaobject **${m.displayName ?? m.handle}** (id ${gidToId(m.id)}).`,
        structured: { metaobject: stripGids(m) },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_delete_metaobject",
    title: "Delete metaobject",
    description: "Permanently delete a metaobject entry by id. This cannot be undone.",
    inputSchema: { id: z.string().describe("Metaobject id (numeric or GID).") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{
        metaobjectDelete: { deletedId: string | null; userErrors: Array<{ field: string[] | null; message: string; code: string | null }> };
      }>(DELETE_METAOBJECT, { id: toGid("Metaobject", args.id) });
      assertNoUserErrors(res.data.metaobjectDelete.userErrors);
      return {
        markdown: `Deleted metaobject ${gidToId(args.id)}.`,
        structured: { deletedId: res.data.metaobjectDelete.deletedId ? gidToId(res.data.metaobjectDelete.deletedId) : null },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_bulk_set_product_status",
    title: "Set product status (bulk)",
    description:
      "Set the status (ACTIVE / DRAFT / ARCHIVED) on a list of products, every product in a collection, " +
      "or every product of a productType — in one call. Use to publish a whole line (DRAFT→ACTIVE), " +
      "unpublish, or archive discontinued products. dryRun defaults to TRUE.",
    inputSchema: {
      status: z.enum(["ACTIVE", "DRAFT", "ARCHIVED"]).describe("Target status for every matched product."),
      productIds: z.array(z.string()).optional().describe("Explicit list of product ids."),
      collectionId: z.string().optional().describe("Every product in this collection."),
      productType: z.string().optional().describe('Every product of this type, e.g. "Comic Book".'),
      dryRun: z.boolean().default(true).describe("If true (default), report the count and change nothing."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const targets = [args.productIds, args.collectionId, args.productType].filter((x) => x !== undefined).length;
      if (targets !== 1) throw new Error("Provide exactly one of productIds, collectionId, or productType.");

      // Resolve product GIDs.
      let productGids: string[] = [];
      if (args.productIds) {
        productGids = args.productIds.map((id) => toGid("Product", id));
      } else if (args.collectionId) {
        productGids = await collectProductGids(c, { collectionId: args.collectionId });
      } else {
        let after: string | null = null;
        const query = `product_type:'${args.productType!.replace(/'/g, "")}'`;
        do {
          const r: { data: { products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<{ id: string }> } } } =
            await c.request(PRODUCTS_BY_TYPE, { first: 100, after, query });
          productGids.push(...r.data.products.nodes.map((n) => n.id));
          after = r.data.products.pageInfo.hasNextPage ? r.data.products.pageInfo.endCursor : null;
        } while (after);
      }

      if (args.dryRun) {
        return {
          markdown: `**DRY RUN** — would set status=${args.status} on ${productGids.length} product(s).\n\n_Nothing changed. Re-run with dryRun:false to apply._`,
          structured: { dryRun: true, status: args.status, products: productGids.length },
          cost: undefined,
        };
      }

      let changed = 0;
      const errors: string[] = [];
      for (const id of productGids) {
        const res = await c.request<{ productUpdate: { userErrors: Array<{ message: string }> } }>(PRODUCT_STATUS_UPDATE, { product: { id, status: args.status } });
        const ue = res.data.productUpdate.userErrors;
        if (ue.length) errors.push(`${gidToId(id)}: ${ue.map((e) => e.message).join("; ")}`);
        else changed++;
      }
      const errBlock = errors.length ? `\n\n**${errors.length} error(s):**\n` + errors.slice(0, 20).map((e) => `- ${e}`).join("\n") : "";
      return {
        markdown: `Set status=${args.status} on ${changed}/${productGids.length} product(s).${errBlock}`,
        structured: { dryRun: false, status: args.status, changed, total: productGids.length, errorCount: errors.length, errors },
        cost: undefined,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_create_url_redirect",
    title: "Create URL redirect",
    description:
      "Create a URL redirect from an old storefront path to a new target — e.g. after renaming a " +
      "product handle, redirect the old /products/old-handle to the new one so old links don't 404.",
    inputSchema: {
      path: z.string().describe('The old path to redirect FROM, e.g. "/products/old-handle".'),
      target: z.string().describe('The path or URL to redirect TO, e.g. "/products/new-handle".'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (args, c) => {
      const res = await c.request<{
        urlRedirectCreate: { urlRedirect: { id: string; path: string; target: string } | null; userErrors: Array<{ field: string[] | null; message: string }> };
      }>(CREATE_REDIRECT, { urlRedirect: { path: args.path, target: args.target } });
      assertNoUserErrors(res.data.urlRedirectCreate.userErrors);
      const r = res.data.urlRedirectCreate.urlRedirect!;
      return {
        markdown: `Created redirect ${r.path} → ${r.target} (id ${gidToId(r.id)}).`,
        structured: { redirect: stripGids(r) },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_delete_url_redirect",
    title: "Delete URL redirect",
    description: "Delete a URL redirect by id.",
    inputSchema: { id: z.string().describe("URL redirect id (numeric or GID).") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{
        urlRedirectDelete: { deletedUrlRedirectId: string | null; userErrors: Array<{ field: string[] | null; message: string }> };
      }>(DELETE_REDIRECT, { id: toGid("UrlRedirect", args.id) });
      assertNoUserErrors(res.data.urlRedirectDelete.userErrors);
      return {
        markdown: `Deleted URL redirect ${gidToId(args.id)}.`,
        structured: { deletedId: res.data.urlRedirectDelete.deletedUrlRedirectId ? gidToId(res.data.urlRedirectDelete.deletedUrlRedirectId) : null },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_reorder_collection_products",
    title: "Reorder products in a collection",
    description:
      "Set the position of products within a MANUAL collection (the collection's sort order must be " +
      "MANUAL). Provide products in the exact order you want, OR only the ones to move with explicit " +
      "positions. Position 0 is first. Runs as an async Shopify job.",
    inputSchema: {
      collectionId: z.string().describe("Manual collection id (numeric or GID)."),
      moves: z
        .array(z.object({ productId: z.string(), newPosition: z.number().int().min(0) }))
        .min(1)
        .describe("Each product id and its new 0-based position, e.g. [{productId, newPosition:0}]."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const moves = args.moves.map((m) => ({ id: toGid("Product", m.productId), newPosition: String(m.newPosition) }));
      const res = await c.request<{
        collectionReorderProducts: { job: { id: string; done: boolean } | null; userErrors: Array<{ field: string[] | null; message: string }> };
      }>(REORDER_COLLECTION_PRODUCTS, { id: toGid("Collection", args.collectionId), moves });
      assertNoUserErrors(res.data.collectionReorderProducts.userErrors);
      const job = res.data.collectionReorderProducts.job;
      return {
        markdown: `Reordering ${moves.length} product(s) in collection ${gidToId(args.collectionId)} (job ${job ? gidToId(job.id) : "?"}, ${job?.done ? "done" : "processing"}).`,
        structured: { collectionId: gidToId(args.collectionId), moves: moves.length, job: job ? { id: gidToId(job.id), done: job.done } : null },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_set_collection_image",
    title: "Set collection image",
    description:
      "Set (or replace) a collection's image from a publicly accessible URL. Pass an empty imageUrl to " +
      "clear the image.",
    inputSchema: {
      collectionId: z.string().describe("Collection id (numeric or GID)."),
      imageUrl: z.string().describe('Public image URL. Pass "" to remove the current image.'),
      altText: z.string().optional().describe("Alt text for the image (accessibility/SEO)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const input: Record<string, unknown> = { id: toGid("Collection", args.collectionId) };
      input.image = args.imageUrl ? { src: args.imageUrl, ...(args.altText !== undefined ? { altText: args.altText } : {}) } : null;
      const res = await c.request<{
        collectionUpdate: { collection: { id: string; title: string; image: { url: string; altText: string | null } | null } | null; userErrors: Array<{ field: string[] | null; message: string }> };
      }>(SET_COLLECTION_IMAGE, { input });
      assertNoUserErrors(res.data.collectionUpdate.userErrors);
      const col = res.data.collectionUpdate.collection!;
      return {
        markdown: args.imageUrl
          ? `Set image on collection **${col.title}** (${gidToId(col.id)}).`
          : `Cleared image on collection **${col.title}** (${gidToId(col.id)}).`,
        structured: { collection: stripGids(col) },
        cost: res.cost,
      };
    },
  });
}
