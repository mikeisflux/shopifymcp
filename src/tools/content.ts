/**
 * Online-store content tools:
 *   read  — list_pages, list_blogs, list_articles
 *   write — create_page, update_page, delete_page, create_blog,
 *           create_article, update_article
 *
 * Pages, blogs and articles are part of the online-store content surface,
 * which is fully available in the Admin GraphQL API (pageCreate/pageUpdate/
 * pageDelete, blogCreate, articleCreate/articleUpdate). No REST fallback is
 * needed.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ShopifyClient, assertNoUserErrors } from "../shopify-client.js";
import { registerTool, paginationShape } from "./shared.js";
import { gidToId, toGid, markdownTable, stripGids } from "../format.js";

// ─── Queries ─────────────────────────────────────────────────────────────────

const LIST_PAGES = /* GraphQL */ `
  query ListPages($first: Int!, $after: String, $query: String) {
    pages(first: $first, after: $after, query: $query) {
      pageInfo { hasNextPage endCursor }
      nodes { id title handle isPublished publishedAt updatedAt body }
    }
  }
`;

const LIST_BLOGS = /* GraphQL */ `
  query ListBlogs($first: Int!, $after: String) {
    blogs(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id title handle }
    }
  }
`;

const LIST_ARTICLES = /* GraphQL */ `
  query ListArticles($first: Int!, $after: String, $query: String) {
    articles(first: $first, after: $after, query: $query) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id title handle isPublished publishedAt summary
        blog { id title }
      }
    }
  }
`;

// ─── Mutations ───────────────────────────────────────────────────────────────

const CREATE_PAGE = /* GraphQL */ `
  mutation CreatePage($page: PageCreateInput!) {
    pageCreate(page: $page) {
      page { id title handle isPublished publishedAt }
      userErrors { field message }
    }
  }
`;

const UPDATE_PAGE = /* GraphQL */ `
  mutation UpdatePage($id: ID!, $page: PageUpdateInput!) {
    pageUpdate(id: $id, page: $page) {
      page { id title handle isPublished publishedAt }
      userErrors { field message }
    }
  }
`;

const DELETE_PAGE = /* GraphQL */ `
  mutation DeletePage($id: ID!) {
    pageDelete(id: $id) {
      deletedPageId
      userErrors { field message }
    }
  }
`;

const CREATE_BLOG = /* GraphQL */ `
  mutation CreateBlog($blog: BlogCreateInput!) {
    blogCreate(blog: $blog) {
      blog { id title handle }
      userErrors { field message }
    }
  }
`;

const CREATE_ARTICLE = /* GraphQL */ `
  mutation CreateArticle($article: ArticleCreateInput!) {
    articleCreate(article: $article) {
      article { id title handle isPublished publishedAt blog { id title } }
      userErrors { field message }
    }
  }
`;

const UPDATE_ARTICLE = /* GraphQL */ `
  mutation UpdateArticle($id: ID!, $article: ArticleUpdateInput!) {
    articleUpdate(id: $id, article: $article) {
      article { id title handle isPublished publishedAt blog { id title } }
      userErrors { field message }
    }
  }
`;

// ─── Shared types ────────────────────────────────────────────────────────────

interface UserError {
  field: string[] | null;
  message: string;
}

/** Strips HTML tags and trims a body/summary to a short table-friendly snippet. */
function snippet(html: string | null | undefined, max = 60): string {
  if (!html) return "";
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Builds the shared page input for create/update (only provided fields). */
function buildPageInput(args: {
  title?: string;
  body?: string;
  handle?: string;
  isPublished?: boolean;
  templateSuffix?: string;
}): Record<string, unknown> {
  const page: Record<string, unknown> = {};
  if (args.title !== undefined) page.title = args.title;
  if (args.body !== undefined) page.body = args.body;
  if (args.handle !== undefined) page.handle = args.handle;
  if (args.isPublished !== undefined) page.isPublished = args.isPublished;
  if (args.templateSuffix !== undefined) page.templateSuffix = args.templateSuffix;
  return page;
}

/** Builds the shared article input for create/update (only provided fields). */
function buildArticleInput(args: {
  blogId?: string;
  title?: string;
  body?: string;
  handle?: string;
  author?: string;
  isPublished?: boolean;
  summary?: string;
}): Record<string, unknown> {
  const article: Record<string, unknown> = {};
  if (args.blogId !== undefined) article.blogId = toGid("Blog", args.blogId);
  if (args.title !== undefined) article.title = args.title;
  if (args.body !== undefined) article.body = args.body;
  if (args.handle !== undefined) article.handle = args.handle;
  if (args.author !== undefined) article.author = { name: args.author };
  if (args.isPublished !== undefined) article.isPublished = args.isPublished;
  if (args.summary !== undefined) article.summary = args.summary;
  return article;
}

export function registerContentReadTools(server: McpServer, client: ShopifyClient): void {
  registerTool(server, client, {
    name: "shopify_list_pages",
    title: "List pages",
    description:
      "List the online store's content pages (e.g. About Us, Contact, policy pages). Returns id, " +
      "title, handle, whether the page is published, its publish date, and a short body snippet. " +
      "Requires the read_online_store_pages / read_content scope.",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe('Free-text search, e.g. "title:About" or "published_status:published".'),
      ...paginationShape,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{
        pages: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<{
            id: string;
            title: string;
            handle: string;
            isPublished: boolean;
            publishedAt: string | null;
            updatedAt: string | null;
            body: string | null;
          }>;
        };
      }>(LIST_PAGES, { first: args.first, after: args.after, query: args.query });

      const { pages } = res.data;
      const rows = pages.nodes.map((p) => [
        gidToId(p.id),
        p.title,
        p.handle,
        p.isPublished ? "yes" : "no",
        p.publishedAt ?? "",
        snippet(p.body),
      ]);

      const markdown =
        pages.nodes.length === 0
          ? "No pages matched."
          : markdownTable(["ID", "Title", "Handle", "Published", "Published At", "Body"], rows, args.first) +
            (pages.pageInfo.hasNextPage
              ? `\n\n_More available. Pass \`after: "${pages.pageInfo.endCursor}"\` for the next page._`
              : "");

      return {
        markdown,
        structured: { pages: stripGids(pages.nodes), pageInfo: pages.pageInfo },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_list_blogs",
    title: "List blogs",
    description:
      "List the online store's blogs (each blog is a container for articles). Returns id, title, and " +
      "handle. Use a blog's id with shopify_create_article. Requires the read_content scope.",
    inputSchema: { ...paginationShape },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{
        blogs: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<{ id: string; title: string; handle: string }>;
        };
      }>(LIST_BLOGS, { first: args.first, after: args.after });

      const { blogs } = res.data;
      const rows = blogs.nodes.map((b) => [gidToId(b.id), b.title, b.handle]);

      const markdown =
        blogs.nodes.length === 0
          ? "No blogs found."
          : markdownTable(["ID", "Title", "Handle"], rows, args.first) +
            (blogs.pageInfo.hasNextPage
              ? `\n\n_More available. Pass \`after: "${blogs.pageInfo.endCursor}"\` for the next page._`
              : "");

      return {
        markdown,
        structured: { blogs: stripGids(blogs.nodes), pageInfo: blogs.pageInfo },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_list_articles",
    title: "List blog articles",
    description:
      "List blog articles across all of the store's blogs. Returns id, title, handle, owning blog, " +
      "published status, publish date, and summary. Requires the read_content scope.",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe('Free-text search, e.g. "title:Welcome", "blog_title:News", or "author:Jane".'),
      ...paginationShape,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{
        articles: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<{
            id: string;
            title: string;
            handle: string;
            isPublished: boolean;
            publishedAt: string | null;
            summary: string | null;
            blog: { id: string; title: string } | null;
          }>;
        };
      }>(LIST_ARTICLES, { first: args.first, after: args.after, query: args.query });

      const { articles } = res.data;
      const rows = articles.nodes.map((a) => [
        gidToId(a.id),
        a.title,
        a.handle,
        a.blog?.title ?? "",
        a.isPublished ? "yes" : "no",
        a.publishedAt ?? "",
      ]);

      const markdown =
        articles.nodes.length === 0
          ? "No articles matched."
          : markdownTable(["ID", "Title", "Handle", "Blog", "Published", "Published At"], rows, args.first) +
            (articles.pageInfo.hasNextPage
              ? `\n\n_More available. Pass \`after: "${articles.pageInfo.endCursor}"\` for the next page._`
              : "");

      return {
        markdown,
        structured: { articles: stripGids(articles.nodes), pageInfo: articles.pageInfo },
        cost: res.cost,
      };
    },
  });
}

export function registerContentWriteTools(server: McpServer, client: ShopifyClient): void {
  registerTool(server, client, {
    name: "shopify_create_page",
    title: "Create page",
    description:
      "Create an online-store content page (e.g. About Us, shipping policy). Body accepts HTML. " +
      "Requires the write_online_store_pages / write_content scope.",
    inputSchema: {
      title: z.string().describe("Page title."),
      body: z.string().optional().describe("Page content as HTML."),
      handle: z
        .string()
        .optional()
        .describe("URL handle/slug. Auto-generated from the title if omitted."),
      isPublished: z
        .boolean()
        .optional()
        .describe("Whether the page is visible. Defaults to published if omitted."),
      templateSuffix: z
        .string()
        .optional()
        .describe('Theme template suffix, e.g. "contact" for page.contact.liquid. Omit for the default template.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (args, c) => {
      const res = await c.request<{
        pageCreate: {
          page: { id: string; title: string; handle: string; isPublished: boolean } | null;
          userErrors: UserError[];
        };
      }>(CREATE_PAGE, { page: buildPageInput(args) });
      assertNoUserErrors(res.data.pageCreate.userErrors);
      const page = res.data.pageCreate.page!;
      return {
        markdown: `Created page **${page.title}** (id ${gidToId(page.id)}, handle ${page.handle}, ${page.isPublished ? "published" : "hidden"}).`,
        structured: { page: stripGids(page) },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_update_page",
    title: "Update page",
    description:
      "Update an online-store content page. Only the fields you provide are changed. Body accepts " +
      "HTML. Requires the write_content scope.",
    inputSchema: {
      id: z.string().describe("Page id (numeric or GID)."),
      title: z.string().optional(),
      body: z.string().optional().describe("Page content as HTML."),
      handle: z.string().optional().describe("URL handle/slug."),
      isPublished: z.boolean().optional().describe("Set true to publish, false to hide the page."),
      templateSuffix: z
        .string()
        .optional()
        .describe('Theme template suffix. Pass an empty string to reset to the default template.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{
        pageUpdate: {
          page: { id: string; title: string; handle: string; isPublished: boolean } | null;
          userErrors: UserError[];
        };
      }>(UPDATE_PAGE, { id: toGid("Page", args.id), page: buildPageInput(args) });
      assertNoUserErrors(res.data.pageUpdate.userErrors);
      const page = res.data.pageUpdate.page!;
      return {
        markdown: `Updated page **${page.title}** (id ${gidToId(page.id)}, handle ${page.handle}, ${page.isPublished ? "published" : "hidden"}).`,
        structured: { page: stripGids(page) },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_delete_page",
    title: "Delete page",
    description:
      "Permanently delete an online-store content page. This cannot be undone. Requires the " +
      "write_content scope.",
    inputSchema: {
      id: z.string().describe("Page id to delete (numeric or GID)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{
        pageDelete: { deletedPageId: string | null; userErrors: UserError[] };
      }>(DELETE_PAGE, { id: toGid("Page", args.id) });
      assertNoUserErrors(res.data.pageDelete.userErrors);
      const deletedId = res.data.pageDelete.deletedPageId;
      return {
        markdown: `Deleted page ${gidToId(deletedId ?? args.id)}.`,
        structured: { deletedPageId: gidToId(deletedId ?? "") },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_create_blog",
    title: "Create blog",
    description:
      "Create a blog (a container for articles). Add articles to it with shopify_create_article. " +
      "Requires the write_content scope.",
    inputSchema: {
      title: z.string().describe("Blog title."),
      handle: z
        .string()
        .optional()
        .describe("URL handle/slug. Auto-generated from the title if omitted."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (args, c) => {
      const blog: Record<string, unknown> = { title: args.title };
      if (args.handle !== undefined) blog.handle = args.handle;
      const res = await c.request<{
        blogCreate: {
          blog: { id: string; title: string; handle: string } | null;
          userErrors: UserError[];
        };
      }>(CREATE_BLOG, { blog });
      assertNoUserErrors(res.data.blogCreate.userErrors);
      const created = res.data.blogCreate.blog!;
      return {
        markdown: `Created blog **${created.title}** (id ${gidToId(created.id)}, handle ${created.handle}).`,
        structured: { blog: stripGids(created) },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_create_article",
    title: "Create blog article",
    description:
      "Create an article in a blog. Provide the target blog's id (from shopify_list_blogs). Body " +
      "accepts HTML. Requires the write_content scope.",
    inputSchema: {
      blogId: z.string().describe("Id of the blog to create the article in (numeric or GID)."),
      title: z.string().describe("Article title."),
      body: z.string().optional().describe("Article content as HTML."),
      handle: z
        .string()
        .optional()
        .describe("URL handle/slug. Auto-generated from the title if omitted."),
      author: z.string().optional().describe("Author name displayed on the article."),
      summary: z.string().optional().describe("Short summary/excerpt of the article."),
      isPublished: z
        .boolean()
        .optional()
        .describe("Whether the article is visible. Defaults to Shopify's default if omitted."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (args, c) => {
      const res = await c.request<{
        articleCreate: {
          article: {
            id: string;
            title: string;
            handle: string;
            isPublished: boolean;
            blog: { id: string; title: string } | null;
          } | null;
          userErrors: UserError[];
        };
      }>(CREATE_ARTICLE, { article: buildArticleInput(args) });
      assertNoUserErrors(res.data.articleCreate.userErrors);
      const article = res.data.articleCreate.article!;
      return {
        markdown: `Created article **${article.title}** (id ${gidToId(article.id)}, handle ${article.handle}) in blog ${article.blog?.title ?? gidToId(args.blogId)} (${article.isPublished ? "published" : "hidden"}).`,
        structured: { article: stripGids(article) },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_update_article",
    title: "Update blog article",
    description:
      "Update a blog article. Only the fields you provide are changed. Pass `blogId` to move the " +
      "article to a different blog. Body accepts HTML. Requires the write_content scope.",
    inputSchema: {
      id: z.string().describe("Article id (numeric or GID)."),
      blogId: z.string().optional().describe("Move the article to this blog id (numeric or GID)."),
      title: z.string().optional(),
      body: z.string().optional().describe("Article content as HTML."),
      handle: z.string().optional().describe("URL handle/slug."),
      author: z.string().optional().describe("Author name displayed on the article."),
      summary: z.string().optional().describe("Short summary/excerpt of the article."),
      isPublished: z.boolean().optional().describe("Set true to publish, false to hide the article."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{
        articleUpdate: {
          article: {
            id: string;
            title: string;
            handle: string;
            isPublished: boolean;
            blog: { id: string; title: string } | null;
          } | null;
          userErrors: UserError[];
        };
      }>(UPDATE_ARTICLE, { id: toGid("Article", args.id), article: buildArticleInput(args) });
      assertNoUserErrors(res.data.articleUpdate.userErrors);
      const article = res.data.articleUpdate.article!;
      return {
        markdown: `Updated article **${article.title}** (id ${gidToId(article.id)}, handle ${article.handle}, ${article.isPublished ? "published" : "hidden"}).`,
        structured: { article: stripGids(article) },
        cost: res.cost,
      };
    },
  });
}
