/**
 * shopify_reset_handles — bulk-reset product URL handles to slugify(title).
 *
 * handle = title lowercased, non-alphanumeric runs → hyphens, trimmed. Products
 * already matching are skipped. Handles must be unique across the store, so the
 * tool DETECTS collisions (two products resolving to the same handle, or a
 * target already owned by a different product) and REPORTS them instead of
 * silently appending "-1".
 *
 * NOTE: setting a handle does NOT create a URL redirect from the old handle —
 * old links to a changed product will 404. (Intentional per the caller.)
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ShopifyClient } from "../shopify-client.js";
import { registerTool } from "./shared.js";
import { gidToId, toGid, markdownTable } from "../format.js";

/** title → handle: lowercase, strip accents, non-alphanumeric runs to hyphens, trim. */
function slugify(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const COLLECTION_PRODUCTS = /* GraphQL */ `
  query HandleCollectionProducts($id: ID!, $first: Int!, $after: String) {
    collection(id: $id) {
      products(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id title handle }
      }
    }
  }
`;

const GET_PRODUCT = /* GraphQL */ `
  query HandleProduct($id: ID!) {
    product(id: $id) { id title handle }
  }
`;

const HANDLE_LOOKUP = /* GraphQL */ `
  query HandleLookup($q: String!) {
    products(first: 5, query: $q) { nodes { id title handle } }
  }
`;

const PRODUCT_UPDATE = /* GraphQL */ `
  mutation HandleUpdate($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product { id handle }
      userErrors { field message }
    }
  }
`;

interface Prod { id: string; title: string; handle: string }

export function registerHandleTools(server: McpServer, client: ShopifyClient): void {
  registerTool(server, client, {
    name: "shopify_reset_handles",
    title: "Reset product handles to slugified titles",
    description:
      "Set each product's URL handle to slugify(title) — lowercase, non-alphanumeric runs become " +
      "hyphens. Products already matching are skipped. Collisions (two products resolving to the same " +
      "handle, or a target already owned by another product) are REPORTED, never auto-suffixed, so you " +
      "can resolve genuine duplicate titles yourself. Target a collectionId or an explicit productIds " +
      "list. dryRun defaults to TRUE. NOTE: changing a handle does NOT create a redirect — old URLs to " +
      "a renamed product will 404.",
    inputSchema: {
      collectionId: z.string().optional().describe("Reset handles for every product in this collection."),
      productIds: z.array(z.string()).optional().describe("Reset handles for an explicit list of products."),
      dryRun: z
        .boolean()
        .default(true)
        .describe("If true (default), report the plan and change nothing. Set false to execute."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      if ((!args.collectionId && !args.productIds) || (args.collectionId && args.productIds)) {
        throw new Error("Provide exactly one of collectionId or productIds.");
      }

      // Load the batch products.
      const products: Prod[] = [];
      if (args.collectionId) {
        let after: string | null = null;
        do {
          const r: {
            data: { collection: { products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Prod[] } } | null };
          } = await c.request(COLLECTION_PRODUCTS, { id: toGid("Collection", args.collectionId), first: 100, after });
          if (!r.data.collection) throw new Error(`No collection found with id ${gidToId(args.collectionId)}.`);
          products.push(...r.data.collection.products.nodes);
          after = r.data.collection.products.pageInfo.hasNextPage ? r.data.collection.products.pageInfo.endCursor : null;
        } while (after);
      } else {
        for (const id of args.productIds!) {
          const r = await c.request<{ product: Prod | null }>(GET_PRODUCT, { id: toGid("Product", id) });
          if (r.data.product) products.push(r.data.product);
        }
      }

      const batchIds = new Set(products.map((p) => p.id));
      const changes = products
        .map((p) => ({ p, target: slugify(p.title) }))
        .filter((ch) => ch.target !== ch.p.handle && ch.target.length > 0);
      const unchanged = products.length - changes.length;

      // Intra-batch collisions: multiple products resolving to the same target.
      const byTarget = new Map<string, typeof changes>();
      for (const ch of changes) (byTarget.get(ch.target) ?? byTarget.set(ch.target, []).get(ch.target)!).push(ch);

      // External collisions: is the target already owned by a different product?
      const externalHolder = new Map<string, Prod | null>();
      for (const target of new Set(changes.map((c) => c.target))) {
        const r = await c.request<{ products: { nodes: Prod[] } }>(HANDLE_LOOKUP, { q: `handle:${target}` });
        const holder = r.data.products.nodes.find((n) => n.handle === target && !batchIds.has(n.id));
        externalHolder.set(target, holder ?? null);
      }

      const applied: Array<{ id: string; title: string; from: string; to: string }> = [];
      const collisions: Array<{ id: string; title: string; target: string; reason: string }> = [];
      for (const ch of changes) {
        const dupes = byTarget.get(ch.target)!;
        if (dupes.length > 1) {
          collisions.push({
            id: ch.p.id,
            title: ch.p.title,
            target: ch.target,
            reason: `intra-batch clash: ${dupes.length} products resolve to "${ch.target}" (${dupes.map((d) => gidToId(d.p.id)).join(", ")})`,
          });
          continue;
        }
        const holder = externalHolder.get(ch.target);
        if (holder) {
          collisions.push({
            id: ch.p.id,
            title: ch.p.title,
            target: ch.target,
            reason: `handle "${ch.target}" already owned by ${gidToId(holder.id)} "${holder.title}"`,
          });
          continue;
        }
        applied.push({ id: ch.p.id, title: ch.p.title, from: ch.p.handle, to: ch.target });
      }

      const changeTable = applied.length
        ? markdownTable(["ID", "Title", "From", "To"], applied.map((a) => [gidToId(a.id), a.title, a.from, a.to]))
        : "_(no clean changes)_";
      const collisionBlock = collisions.length
        ? `\n\n**⚠️ ${collisions.length} collision(s) — NOT changed, resolve manually:**\n` +
          collisions.map((x) => `- ${x.title} (${gidToId(x.id)}): ${x.reason}`).join("\n")
        : "";

      if (args.dryRun) {
        return {
          markdown:
            `**DRY RUN** — ${applied.length} handle(s) to change, ${unchanged} already correct, ` +
            `${collisions.length} collision(s).\n\n${changeTable}${collisionBlock}\n\n` +
            `_No redirects are created. Nothing was changed. Re-run with dryRun:false to apply._`,
          structured: { dryRun: true, toChange: applied.length, unchanged, collisions, changes: applied.map((a) => ({ ...a, id: gidToId(a.id) })) },
          cost: undefined,
        };
      }

      // Execute the clean changes only.
      let done = 0;
      const errors: string[] = [];
      for (const a of applied) {
        const r = await c.request<{ productUpdate: { userErrors: Array<{ message: string }> } }>(PRODUCT_UPDATE, {
          product: { id: a.id, handle: a.to },
        });
        const ue = r.data.productUpdate.userErrors;
        if (ue.length) errors.push(`${a.title} (${gidToId(a.id)}): ${ue.map((e) => e.message).join("; ")}`);
        else done++;
      }
      const errBlock = errors.length ? `\n\n**${errors.length} error(s):**\n` + errors.map((e) => `- ${e}`).join("\n") : "";
      return {
        markdown:
          `Reset ${done}/${applied.length} handle(s). ${unchanged} already correct, ` +
          `${collisions.length} collision(s) left unchanged.${collisionBlock}${errBlock}`,
        structured: { dryRun: false, changed: done, unchanged, collisions, errors },
        cost: undefined,
      };
    },
  });
}
