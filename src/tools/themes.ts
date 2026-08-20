/**
 * Theme editing/management tools (Online Store themes).
 *   read  — list themes (with role), read theme files
 *   write — edit (upsert) files, delete files, publish a theme, delete a theme
 *
 * SAFETY: editing or deleting files on the LIVE theme (role MAIN) changes the
 * storefront immediately, so those operations refuse the live theme unless
 * `allowLiveTheme: true` is passed, and default to dryRun. The write mutations
 * require the `write_themes` scope AND a Shopify-granted theme-modification
 * exemption; without the exemption they return a permissions error.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ShopifyClient } from "../shopify-client.js";
import { registerTool } from "./shared.js";
import { gidToId, toGid, markdownTable, stripGids } from "../format.js";

const LIST_THEMES = /* GraphQL */ `
  query ListThemes($first: Int!, $roles: [ThemeRole!]) {
    themes(first: $first, roles: $roles) {
      nodes { id name role processing createdAt updatedAt }
    }
  }
`;

const THEME_ROLE = /* GraphQL */ `
  query ThemeRole($id: ID!) { theme(id: $id) { id name role } }
`;

const GET_THEME_FILES = /* GraphQL */ `
  query GetThemeFiles($id: ID!, $filenames: [String!], $first: Int!) {
    theme(id: $id) {
      id name role
      files(filenames: $filenames, first: $first) {
        nodes {
          filename size contentType checksumMd5
          body {
            __typename
            ... on OnlineStoreThemeFileBodyText { content }
            ... on OnlineStoreThemeFileBodyBase64 { contentBase64 }
            ... on OnlineStoreThemeFileBodyUrl { url }
          }
        }
      }
    }
  }
`;

const THEME_FILES_UPSERT = /* GraphQL */ `
  mutation ThemeFilesUpsert($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
    themeFilesUpsert(themeId: $themeId, files: $files) {
      upsertedThemeFiles { filename }
      job { id done }
      userErrors { filename code message }
    }
  }
`;

const THEME_FILES_DELETE = /* GraphQL */ `
  mutation ThemeFilesDelete($themeId: ID!, $files: [String!]!) {
    themeFilesDelete(themeId: $themeId, files: $files) {
      deletedThemeFiles { filename }
      userErrors { filename code message }
    }
  }
`;

const THEME_PUBLISH = /* GraphQL */ `
  mutation ThemePublish($id: ID!) {
    themePublish(id: $id) {
      theme { id name role }
      userErrors { field message }
    }
  }
`;

const THEME_DELETE = /* GraphQL */ `
  mutation ThemeDelete($id: ID!) {
    themeDelete(id: $id) {
      deletedThemeId
      userErrors { field message }
    }
  }
`;

interface ThemeRef { id: string; name: string; role: string }

/** Throws with an actionable message if the theme is live (MAIN) and not opted in. Returns the theme. */
async function resolveThemeGuard(c: ShopifyClient, themeGid: string, allowLiveTheme: boolean): Promise<ThemeRef> {
  const r = await c.request<{ theme: ThemeRef | null }>(THEME_ROLE, { id: themeGid });
  if (!r.data.theme) throw new Error(`No theme found with id ${gidToId(themeGid)}.`);
  if (r.data.theme.role === "MAIN" && !allowLiveTheme) {
    throw new Error(
      `Theme "${r.data.theme.name}" is the LIVE theme (role MAIN) — this changes the storefront ` +
        "immediately. Pass allowLiveTheme:true to proceed, or edit an unpublished copy and publish it.",
    );
  }
  return r.data.theme;
}

/** Formats a themeFiles* userErrors array (filename/code/message) into one message. */
function themeFileErrors(errs: Array<{ filename?: string | null; code?: string | null; message: string }>): string | null {
  if (!errs || errs.length === 0) return null;
  return errs.map((e) => `${e.filename ? `${e.filename}: ` : ""}${e.message}${e.code ? ` (${e.code})` : ""}`).join("; ");
}

export function registerThemeReadTools(server: McpServer, client: ShopifyClient): void {
  registerTool(server, client, {
    name: "shopify_list_themes",
    title: "List themes",
    description:
      "List the store's Online Store themes with their role (MAIN = live/published, UNPUBLISHED, " +
      "DEMO, DEVELOPMENT) and ids. Use the id with the theme file/edit tools. The MAIN theme is the " +
      "one currently live on the storefront.",
    inputSchema: {
      first: z.number().int().min(1).max(50).default(20).describe("Max themes to return. Default 20."),
      roles: z
        .array(z.enum(["MAIN", "UNPUBLISHED", "DEMO", "DEVELOPMENT", "LOCKED", "MOBILE"]))
        .optional()
        .describe("Optionally filter to specific roles, e.g. [\"MAIN\"] for just the live theme."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{ themes: { nodes: Array<{ id: string; name: string; role: string; processing: boolean; updatedAt: string }> } }>(
        LIST_THEMES, { first: args.first, roles: args.roles ?? null },
      );
      const nodes = res.data.themes.nodes;
      return {
        markdown: nodes.length
          ? markdownTable(["ID", "Name", "Role", "Processing", "Updated"], nodes.map((t) => [gidToId(t.id), t.name, t.role + (t.role === "MAIN" ? " (LIVE)" : ""), t.processing ? "yes" : "no", t.updatedAt]))
          : "No themes found.",
        structured: { themes: stripGids(nodes) },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_get_theme_files",
    title: "Read theme files",
    description:
      "Read files from a theme. Pass specific `filenames` (e.g. [\"templates/product.json\", " +
      "\"sections/header.liquid\"]) to get their contents, or omit to list the first N files. Text " +
      "files return their content; binary/asset files return a URL or base64 reference.",
    inputSchema: {
      themeId: z.string().describe("Theme id (numeric or GID). Get it from shopify_list_themes."),
      filenames: z.array(z.string()).optional().describe("Specific file paths to read. Omit to list files."),
      first: z.number().int().min(1).max(250).default(50).describe("Max files when listing (no filenames). Default 50."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{
        theme: {
          id: string; name: string; role: string;
          files: { nodes: Array<{ filename: string; size: number; contentType: string; checksumMd5: string | null; body: { __typename: string; content?: string; contentBase64?: string; url?: string } }> };
        } | null;
      }>(GET_THEME_FILES, { id: toGid("OnlineStoreTheme", args.themeId), filenames: args.filenames ?? null, first: args.first });
      if (!res.data.theme) throw new Error(`No theme found with id ${gidToId(args.themeId)}.`);
      const files = res.data.theme.files.nodes;

      let markdown: string;
      if (args.filenames && args.filenames.length) {
        markdown = files.map((f) => {
          const body = f.body.content !== undefined
            ? "```\n" + f.body.content + "\n```"
            : f.body.url ? `(binary — ${f.body.url})` : "(binary/base64 content)";
          return `### ${f.filename} (${f.contentType}, ${f.size} bytes)\n${body}`;
        }).join("\n\n") || "No matching files.";
      } else {
        markdown = files.length
          ? markdownTable(["File", "Type", "Bytes"], files.map((f) => [f.filename, f.contentType, String(f.size)]))
          : "No files found.";
      }
      return {
        markdown: `Theme **${res.data.theme.name}** (${res.data.theme.role}${res.data.theme.role === "MAIN" ? " — LIVE" : ""})\n\n${markdown}`,
        structured: { theme: { id: gidToId(res.data.theme.id), name: res.data.theme.name, role: res.data.theme.role }, files },
        cost: res.cost,
      };
    },
  });
}

export function registerThemeWriteTools(server: McpServer, client: ShopifyClient): void {
  registerTool(server, client, {
    name: "shopify_edit_theme_files",
    title: "Edit theme files (create/update)",
    description:
      "Create or update files in a theme (Liquid, JSON templates/settings, assets) — up to 50 per call. " +
      "Editing the LIVE theme (role MAIN) changes the storefront immediately and requires " +
      "allowLiveTheme:true. dryRun defaults to TRUE (shows the target theme + files, writes nothing). " +
      "Requires write_themes + a Shopify theme-modification exemption. TIP: read the current file first " +
      "(shopify_get_theme_files) and, for live edits, consider editing an unpublished copy then publishing.",
    inputSchema: {
      themeId: z.string().describe("Theme id (numeric or GID)."),
      files: z
        .array(z.object({
          filename: z.string().describe('File path, e.g. "sections/header.liquid" or "templates/product.json".'),
          content: z.string().describe("The full new file content."),
          encoding: z.enum(["TEXT", "BASE64", "URL"]).default("TEXT").describe("How `content` is encoded. TEXT for source files (default); BASE64 for binary; URL to fetch from a URL."),
        }))
        .min(1).max(50)
        .describe("Files to create/overwrite (max 50)."),
      allowLiveTheme: z.boolean().default(false).describe("Required true to edit the LIVE (MAIN) theme."),
      dryRun: z.boolean().default(true).describe("If true (default), show what would change without writing."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async (args, c) => {
      const themeGid = toGid("OnlineStoreTheme", args.themeId);
      const theme = await resolveThemeGuard(c, themeGid, args.allowLiveTheme);
      const liveTag = theme.role === "MAIN" ? " ⚠️ LIVE" : "";

      if (args.dryRun) {
        return {
          markdown:
            `**DRY RUN** — would write ${args.files.length} file(s) to theme **${theme.name}** (${theme.role}${liveTag}):\n` +
            args.files.map((f) => `- ${f.filename} (${f.content.length} chars, ${f.encoding})`).join("\n") +
            `\n\n_Nothing written. Re-run with dryRun:false${theme.role === "MAIN" ? " and allowLiveTheme:true" : ""} to apply._`,
          structured: { dryRun: true, theme: { id: gidToId(themeGid), name: theme.name, role: theme.role }, files: args.files.map((f) => f.filename) },
          cost: undefined,
        };
      }

      const files = args.files.map((f) => ({ filename: f.filename, body: { type: f.encoding ?? "TEXT", value: f.content } }));
      const res = await c.request<{
        themeFilesUpsert: { upsertedThemeFiles: Array<{ filename: string }> | null; job: { id: string; done: boolean } | null; userErrors: Array<{ filename: string | null; code: string | null; message: string }> };
      }>(THEME_FILES_UPSERT, { themeId: themeGid, files });
      const err = themeFileErrors(res.data.themeFilesUpsert.userErrors);
      if (err) throw new Error(`themeFilesUpsert failed: ${err}`);
      const written = res.data.themeFilesUpsert.upsertedThemeFiles ?? [];
      return {
        markdown: `Wrote ${written.length} file(s) to theme **${theme.name}** (${theme.role}${liveTag}): ${written.map((f) => f.filename).join(", ")}.`,
        structured: { theme: { id: gidToId(themeGid), name: theme.name, role: theme.role }, written: written.map((f) => f.filename), job: res.data.themeFilesUpsert.job },
        cost: undefined,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_delete_theme_files",
    title: "Delete theme files",
    description:
      "Delete files from a theme by path. Deleting from the LIVE theme requires allowLiveTheme:true. " +
      "dryRun defaults to TRUE. Requires write_themes + a Shopify theme-modification exemption.",
    inputSchema: {
      themeId: z.string().describe("Theme id (numeric or GID)."),
      filenames: z.array(z.string()).min(1).describe("File paths to delete."),
      allowLiveTheme: z.boolean().default(false).describe("Required true to delete files from the LIVE (MAIN) theme."),
      dryRun: z.boolean().default(true).describe("If true (default), show what would be deleted without deleting."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async (args, c) => {
      const themeGid = toGid("OnlineStoreTheme", args.themeId);
      const theme = await resolveThemeGuard(c, themeGid, args.allowLiveTheme);
      const liveTag = theme.role === "MAIN" ? " ⚠️ LIVE" : "";

      if (args.dryRun) {
        return {
          markdown:
            `**DRY RUN** — would delete ${args.filenames.length} file(s) from theme **${theme.name}** (${theme.role}${liveTag}):\n` +
            args.filenames.map((f) => `- ${f}`).join("\n") +
            `\n\n_Nothing deleted. Re-run with dryRun:false${theme.role === "MAIN" ? " and allowLiveTheme:true" : ""} to apply._`,
          structured: { dryRun: true, theme: { id: gidToId(themeGid), name: theme.name, role: theme.role }, files: args.filenames },
          cost: undefined,
        };
      }

      const res = await c.request<{
        themeFilesDelete: { deletedThemeFiles: Array<{ filename: string }> | null; userErrors: Array<{ filename: string | null; code: string | null; message: string }> };
      }>(THEME_FILES_DELETE, { themeId: themeGid, files: args.filenames });
      const err = themeFileErrors(res.data.themeFilesDelete.userErrors);
      if (err) throw new Error(`themeFilesDelete failed: ${err}`);
      const deleted = res.data.themeFilesDelete.deletedThemeFiles ?? [];
      return {
        markdown: `Deleted ${deleted.length} file(s) from theme **${theme.name}** (${theme.role}${liveTag}): ${deleted.map((f) => f.filename).join(", ")}.`,
        structured: { theme: { id: gidToId(themeGid), name: theme.name, role: theme.role }, deleted: deleted.map((f) => f.filename) },
        cost: undefined,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_publish_theme",
    title: "Publish theme (make live)",
    description:
      "Publish a theme — make it the LIVE storefront theme (role MAIN). The previously-live theme " +
      "becomes unpublished. dryRun defaults to TRUE and shows the current live theme and the target. " +
      "Requires write_themes + a Shopify theme-modification exemption.",
    inputSchema: {
      themeId: z.string().describe("Theme id to publish (numeric or GID)."),
      dryRun: z.boolean().default(true).describe("If true (default), show the change without publishing."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async (args, c) => {
      const themeGid = toGid("OnlineStoreTheme", args.themeId);
      const target = await c.request<{ theme: ThemeRef | null }>(THEME_ROLE, { id: themeGid });
      if (!target.data.theme) throw new Error(`No theme found with id ${gidToId(args.themeId)}.`);
      const live = await c.request<{ themes: { nodes: ThemeRef[] } }>(LIST_THEMES, { first: 1, roles: ["MAIN"] });
      const currentLive = live.data.themes.nodes[0];

      if (args.dryRun) {
        return {
          markdown:
            `**DRY RUN** — would publish **${target.data.theme.name}** (${gidToId(themeGid)}) as the LIVE theme` +
            (currentLive ? `, replacing **${currentLive.name}** (${gidToId(currentLive.id)}), which becomes unpublished` : "") +
            `.\n\n_Nothing changed. Re-run with dryRun:false to publish._`,
          structured: { dryRun: true, target: { id: gidToId(themeGid), name: target.data.theme.name }, currentLive: currentLive ? { id: gidToId(currentLive.id), name: currentLive.name } : null },
          cost: undefined,
        };
      }

      const res = await c.request<{ themePublish: { theme: ThemeRef | null; userErrors: Array<{ field: string[] | null; message: string }> } }>(
        THEME_PUBLISH, { id: themeGid },
      );
      const errs = res.data.themePublish.userErrors;
      if (errs.length) throw new Error(`themePublish failed: ${errs.map((e) => e.message).join("; ")}`);
      const t = res.data.themePublish.theme!;
      return {
        markdown: `Published **${t.name}** — it is now the LIVE theme (${t.role}).`,
        structured: { theme: { id: gidToId(t.id), name: t.name, role: t.role } },
        cost: undefined,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_delete_theme",
    title: "Delete a theme",
    description:
      "Permanently delete a theme. The LIVE (MAIN) theme cannot be deleted — publish a different theme " +
      "first. dryRun defaults to TRUE.",
    inputSchema: {
      themeId: z.string().describe("Theme id to delete (numeric or GID)."),
      dryRun: z.boolean().default(true).describe("If true (default), show what would be deleted without deleting."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async (args, c) => {
      const themeGid = toGid("OnlineStoreTheme", args.themeId);
      const t = await c.request<{ theme: ThemeRef | null }>(THEME_ROLE, { id: themeGid });
      if (!t.data.theme) throw new Error(`No theme found with id ${gidToId(args.themeId)}.`);
      if (t.data.theme.role === "MAIN") {
        throw new Error(`Theme "${t.data.theme.name}" is LIVE (MAIN) and cannot be deleted. Publish another theme first.`);
      }

      if (args.dryRun) {
        return {
          markdown: `**DRY RUN** — would delete theme **${t.data.theme.name}** (${t.data.theme.role}, ${gidToId(themeGid)}).\n\n_Nothing changed. Re-run with dryRun:false to delete._`,
          structured: { dryRun: true, theme: { id: gidToId(themeGid), name: t.data.theme.name, role: t.data.theme.role } },
          cost: undefined,
        };
      }

      const res = await c.request<{ themeDelete: { deletedThemeId: string | null; userErrors: Array<{ field: string[] | null; message: string }> } }>(
        THEME_DELETE, { id: themeGid },
      );
      const errs = res.data.themeDelete.userErrors;
      if (errs.length) throw new Error(`themeDelete failed: ${errs.map((e) => e.message).join("; ")}`);
      return {
        markdown: `Deleted theme **${t.data.theme.name}** (${gidToId(themeGid)}).`,
        structured: { deletedThemeId: res.data.themeDelete.deletedThemeId ? gidToId(res.data.themeDelete.deletedThemeId) : null },
        cost: undefined,
      };
    },
  });
}
