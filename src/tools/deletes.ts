/**
 * Delete tools: permanently remove store resources.
 *
 * Every tool here is destructive (destructiveHint: true). Deletes are, for the
 * most part, idempotent — re-running against an already-gone resource surfaces a
 * Shopify userError rather than corrupting state.
 *
 *   shopify_delete_product      — productDelete(input: {id})      → deletedProductId
 *   shopify_delete_collection   — collectionDelete(input: {id})   → deletedCollectionId
 *   shopify_delete_customer     — customerDelete(input: {id})     → deletedCustomerId
 *   shopify_delete_draft_order  — draftOrderDelete(input: {id})   → deletedId
 *   shopify_delete_menu         — menuDelete(id: ID!)             → deletedMenuId
 *   shopify_delete_files        — fileDelete(fileIds: [ID!]!)     → deletedFileIds
 *   shopify_delete_article      — articleDelete(id: ID!)          → deletedArticleId
 *   shopify_delete_blog         — blogDelete(id: ID!)             → deletedBlogId
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ShopifyClient, assertNoUserErrors } from "../shopify-client.js";
import { registerTool } from "./shared.js";
import { gidToId, toGid } from "../format.js";

// ─── Mutations ───────────────────────────────────────────────────────────────

const PRODUCT_DELETE = /* GraphQL */ `
  mutation ProductDelete($input: ProductDeleteInput!) {
    productDelete(input: $input) {
      deletedProductId
      userErrors { field message }
    }
  }
`;

const COLLECTION_DELETE = /* GraphQL */ `
  mutation CollectionDelete($input: CollectionDeleteInput!) {
    collectionDelete(input: $input) {
      deletedCollectionId
      userErrors { field message }
    }
  }
`;

const CUSTOMER_DELETE = /* GraphQL */ `
  mutation CustomerDelete($input: CustomerDeleteInput!) {
    customerDelete(input: $input) {
      deletedCustomerId
      userErrors { field message }
    }
  }
`;

const DRAFT_ORDER_DELETE = /* GraphQL */ `
  mutation DraftOrderDelete($input: DraftOrderDeleteInput!) {
    draftOrderDelete(input: $input) {
      deletedId
      userErrors { field message }
    }
  }
`;

const MENU_DELETE = /* GraphQL */ `
  mutation MenuDelete($id: ID!) {
    menuDelete(id: $id) {
      deletedMenuId
      userErrors { field message }
    }
  }
`;

const FILE_DELETE = /* GraphQL */ `
  mutation FileDelete($fileIds: [ID!]!) {
    fileDelete(fileIds: $fileIds) {
      deletedFileIds
      userErrors { field message }
    }
  }
`;

const ARTICLE_DELETE = /* GraphQL */ `
  mutation ArticleDelete($id: ID!) {
    articleDelete(id: $id) {
      deletedArticleId
      userErrors { field message }
    }
  }
`;

const BLOG_DELETE = /* GraphQL */ `
  mutation BlogDelete($id: ID!) {
    blogDelete(id: $id) {
      deletedBlogId
      userErrors { field message }
    }
  }
`;

interface UserError {
  field: string[] | null;
  message: string;
}

export function registerDeleteTools(server: McpServer, client: ShopifyClient): void {
  registerTool(server, client, {
    name: "shopify_delete_product",
    title: "Delete product",
    description:
      "Permanently delete a product and all its associated data (variants, media, inventory, " +
      "publications, tags, metafields). This cannot be undone. Requires the write_products scope.",
    inputSchema: {
      id: z.string().describe("Product id to delete (numeric or GID)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{
        productDelete: { deletedProductId: string | null; userErrors: UserError[] };
      }>(PRODUCT_DELETE, { input: { id: toGid("Product", args.id) } });
      assertNoUserErrors(res.data.productDelete.userErrors);
      const deletedId = gidToId(res.data.productDelete.deletedProductId);
      return {
        markdown: `Deleted product ${deletedId}.`,
        structured: { deletedProductId: deletedId },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_delete_collection",
    title: "Delete collection",
    description:
      "Permanently delete a collection (smart or manual). Products in the collection are not " +
      "deleted. This cannot be undone. Requires the write_products scope.",
    inputSchema: {
      id: z.string().describe("Collection id to delete (numeric or GID)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{
        collectionDelete: { deletedCollectionId: string | null; userErrors: UserError[] };
      }>(COLLECTION_DELETE, { input: { id: toGid("Collection", args.id) } });
      assertNoUserErrors(res.data.collectionDelete.userErrors);
      const deletedId = gidToId(res.data.collectionDelete.deletedCollectionId);
      return {
        markdown: `Deleted collection ${deletedId}.`,
        structured: { deletedCollectionId: deletedId },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_delete_customer",
    title: "Delete customer",
    description:
      "Permanently delete a customer. Shopify only allows deleting customers who have NOT placed " +
      "any orders; otherwise the operation is rejected. This cannot be undone. Requires the " +
      "write_customers scope.",
    inputSchema: {
      id: z.string().describe("Customer id to delete (numeric or GID)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{
        customerDelete: { deletedCustomerId: string | null; userErrors: UserError[] };
      }>(CUSTOMER_DELETE, { input: { id: toGid("Customer", args.id) } });
      assertNoUserErrors(res.data.customerDelete.userErrors);
      const deletedId = gidToId(res.data.customerDelete.deletedCustomerId);
      return {
        markdown: `Deleted customer ${deletedId}.`,
        structured: { deletedCustomerId: deletedId },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_delete_draft_order",
    title: "Delete draft order",
    description:
      "Permanently delete a draft order. This cannot be undone. Requires the write_draft_orders " +
      "scope.",
    inputSchema: {
      id: z.string().describe("Draft order id to delete (numeric or GID)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{
        draftOrderDelete: { deletedId: string | null; userErrors: UserError[] };
      }>(DRAFT_ORDER_DELETE, { input: { id: toGid("DraftOrder", args.id) } });
      assertNoUserErrors(res.data.draftOrderDelete.userErrors);
      const deletedId = gidToId(res.data.draftOrderDelete.deletedId);
      return {
        markdown: `Deleted draft order ${deletedId}.`,
        structured: { deletedId },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_delete_menu",
    title: "Delete navigation menu",
    description:
      "Permanently delete an online store navigation menu. This cannot be undone. Requires the " +
      "write_online_store_navigation scope.",
    inputSchema: {
      id: z.string().describe("Menu id to delete (numeric or GID)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{
        menuDelete: { deletedMenuId: string | null; userErrors: UserError[] };
      }>(MENU_DELETE, { id: toGid("Menu", args.id) });
      assertNoUserErrors(res.data.menuDelete.userErrors);
      const deletedId = gidToId(res.data.menuDelete.deletedMenuId);
      return {
        markdown: `Deleted menu ${deletedId}.`,
        structured: { deletedMenuId: deletedId },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_delete_files",
    title: "Delete files",
    description:
      "Permanently delete one or more file assets (images, videos, generic files) from the store's " +
      "Files library. This cannot be undone. Because file GIDs use varying resource types " +
      "(MediaImage, Video, GenericFile), pass full GIDs, e.g. gid://shopify/MediaImage/123. " +
      "Requires the write_files scope.",
    inputSchema: {
      fileIds: z
        .array(z.string())
        .min(1)
        .describe("File GIDs to delete, e.g. gid://shopify/MediaImage/123."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{
        fileDelete: { deletedFileIds: string[] | null; userErrors: UserError[] };
      }>(FILE_DELETE, { fileIds: args.fileIds });
      assertNoUserErrors(res.data.fileDelete.userErrors);
      const deletedFileIds = (res.data.fileDelete.deletedFileIds ?? []).map((id) => gidToId(id));
      return {
        markdown: `Deleted ${deletedFileIds.length} file(s).`,
        structured: { deletedFileIds },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_delete_article",
    title: "Delete blog article",
    description:
      "Permanently delete a blog article and its associated metadata. This cannot be undone. " +
      "Requires the write_content scope.",
    inputSchema: {
      id: z.string().describe("Article id to delete (numeric or GID)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{
        articleDelete: { deletedArticleId: string | null; userErrors: UserError[] };
      }>(ARTICLE_DELETE, { id: toGid("Article", args.id) });
      assertNoUserErrors(res.data.articleDelete.userErrors);
      const deletedId = gidToId(res.data.articleDelete.deletedArticleId);
      return {
        markdown: `Deleted article ${deletedId}.`,
        structured: { deletedArticleId: deletedId },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_delete_blog",
    title: "Delete blog",
    description:
      "Permanently delete a blog AND all of its articles. This cannot be undone. Requires the " +
      "write_content scope.",
    inputSchema: {
      id: z.string().describe("Blog id to delete (numeric or GID)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{
        blogDelete: { deletedBlogId: string | null; userErrors: UserError[] };
      }>(BLOG_DELETE, { id: toGid("Blog", args.id) });
      assertNoUserErrors(res.data.blogDelete.userErrors);
      const deletedId = gidToId(res.data.blogDelete.deletedBlogId);
      return {
        markdown: `Deleted blog ${deletedId}.`,
        structured: { deletedBlogId: deletedId },
        cost: res.cost,
      };
    },
  });
}
