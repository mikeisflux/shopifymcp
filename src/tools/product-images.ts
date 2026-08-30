/**
 * shopify_bulk_sync_variant_images — copy one product's primary image onto many
 * target products' primary slot in a single call.
 *
 * Shopify treats "replace image" as two operations (delete then add), so per
 * target this does productDeleteMedia(current primary) → productCreateMedia(the
 * source image), returning before/after media ids so nothing silently fails.
 * Targets whose primary image already matches the source are reported as
 * "already-in-sync" and skipped rather than pointlessly re-added — which also
 * surfaces the "this looks like the same file as before" case up front.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ShopifyClient, assertNoUserErrors } from "../shopify-client.js";
import { logToolCall } from "../logger.js";
import { textContent, gidToId, toGid } from "../format.js";

const PRODUCT_MEDIA = /* GraphQL */ `
  query ProductMediaForSync($id: ID!) {
    product(id: $id) {
      id title
      featuredImage { url }
      media(first: 50) {
        nodes { id mediaContentType ... on MediaImage { image { url } } }
      }
    }
  }
`;

const CREATE_MEDIA = /* GraphQL */ `
  mutation SyncCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media { alt mediaContentType status ... on MediaImage { id image { url } } }
      mediaUserErrors { field message }
    }
  }
`;

const DELETE_MEDIA = /* GraphQL */ `
  mutation SyncDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
    productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
      deletedMediaIds
      mediaUserErrors { field message }
    }
  }
`;

interface ProductMedia {
  id: string;
  title: string;
  featuredImage: { url: string } | null;
  media: { nodes: Array<{ id: string; mediaContentType: string; image?: { url: string } | null }> };
}

/** Reduce a CDN image URL to a stable identity: last path segment without query. */
function imageIdentity(url: string | null | undefined): string {
  if (!url) return "";
  const noQuery = url.split("?")[0] ?? url;
  const seg = noQuery.split("/").pop() ?? noQuery;
  return seg.toLowerCase();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function readProduct(shopify: ShopifyClient, gid: string): Promise<ProductMedia | null> {
  const res = await shopify.request<{ product: ProductMedia | null }>(PRODUCT_MEDIA, { id: gid });
  return res.data.product;
}

/** First IMAGE media node = the primary image slot. */
function primaryImage(p: ProductMedia): { mediaId: string; url: string | null } | null {
  const node = p.media.nodes.find((m) => m.mediaContentType === "IMAGE");
  if (!node) return null;
  return { mediaId: node.id, url: node.image?.url ?? null };
}

export function registerProductImageTools(server: McpServer, shopify: ShopifyClient): void {
  server.registerTool(
    "shopify_bulk_sync_variant_images",
    {
      title: "Bulk-sync a product image to many products",
      description:
        "Copy one product's primary image onto many target products' primary image slot (delete current primary, then add the source image) in one call. Returns per-target before/after media ids/urls so nothing silently fails. Targets whose primary image already matches the source are reported as 'already-in-sync' and skipped — which also surfaces 'this is the same file as before' up front. dryRun (default) previews old→new per target without writing.",
      inputSchema: {
        sourceProductId: z.string().describe("Product whose current primary image is the one to propagate (numeric or GID)."),
        targetProductIds: z.array(z.string()).min(1).describe("Products to overwrite the primary image on (numeric or GID)."),
        dryRun: z.boolean().default(true).describe("true (default): preview old vs new image per target without writing. false: perform the delete+add."),
        force: z.boolean().default(false).describe("If true, re-add the image even to targets already in sync (default false skips them)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    (async (args: { sourceProductId: string; targetProductIds: string[]; dryRun: boolean; force: boolean }) => {
      const start = Date.now();
      try {
        const sourceGid = toGid("Product", args.sourceProductId);
        const source = await readProduct(shopify, sourceGid);
        if (!source) throw new Error(`Source product ${args.sourceProductId} not found.`);
        const sourceUrl = source.featuredImage?.url ?? primaryImage(source)?.url ?? null;
        if (!sourceUrl) throw new Error(`Source product "${source.title}" has no primary image to copy.`);
        const sourceIdentity = imageIdentity(sourceUrl);

        const results: Array<Record<string, unknown>> = [];
        let synced = 0;
        let skipped = 0;
        let failed = 0;

        for (const rawId of args.targetProductIds) {
          const targetGid = toGid("Product", rawId);
          const target = await readProduct(shopify, targetGid);
          if (!target) { results.push({ productId: gidToId(targetGid), error: "not found" }); failed++; continue; }
          const current = primaryImage(target);
          const inSync = current && imageIdentity(current.url) === sourceIdentity;

          const rowBase = { productId: gidToId(targetGid), productTitle: target.title, beforeMediaId: current ? gidToId(current.mediaId) : null, beforeUrl: current?.url ?? null, sourceUrl };

          if (inSync && !args.force) { results.push({ ...rowBase, action: "already-in-sync" }); skipped++; continue; }
          if (args.dryRun) { results.push({ ...rowBase, action: inSync ? "would-replace (already matches)" : "would-replace" }); continue; }

          try {
            if (current) {
              const del = await shopify.request<{ productDeleteMedia: { deletedMediaIds: string[] | null; mediaUserErrors: Array<{ field: string[] | null; message: string }> } }>(DELETE_MEDIA, { productId: targetGid, mediaIds: [current.mediaId] });
              assertNoUserErrors(del.data.productDeleteMedia.mediaUserErrors);
            }
            const add = await shopify.request<{ productCreateMedia: { media: Array<{ id?: string; image?: { url: string } | null }> | null; mediaUserErrors: Array<{ field: string[] | null; message: string }> } }>(CREATE_MEDIA, {
              productId: targetGid,
              media: [{ originalSource: sourceUrl, mediaContentType: "IMAGE" }],
            });
            assertNoUserErrors(add.data.productCreateMedia.mediaUserErrors);
            const created = add.data.productCreateMedia.media?.[0];
            results.push({ ...rowBase, action: "replaced", afterMediaId: created?.id ? gidToId(created.id) : null, afterUrl: created?.image?.url ?? null, note: "image processes asynchronously; afterUrl may populate shortly" });
            synced++;
            await sleep(150);
          } catch (e) {
            results.push({ ...rowBase, action: "failed", error: e instanceof Error ? e.message : String(e) });
            failed++;
          }
        }

        const allInSync = skipped === args.targetProductIds.length && synced === 0;
        const summary = {
          sourceProductId: gidToId(sourceGid),
          sourceProductTitle: source.title,
          sourceUrl,
          dryRun: args.dryRun,
          targets: args.targetProductIds.length,
          synced,
          skippedInSync: skipped,
          failed,
          warning: allInSync ? "Every target already matches the source image — the source may be an unchanged/stale upload." : undefined,
          results,
        };
        const head = args.dryRun
          ? `**DRY RUN** — would propagate "${source.title}"'s image to ${args.targetProductIds.length} target(s) (${skipped} already in sync). Nothing written.`
          : `Synced image to ${synced} target(s); ${skipped} already in sync, ${failed} failed.`;
        logToolCall({ tool: "shopify_bulk_sync_variant_images", durationMs: Date.now() - start, success: true });
        return { content: [textContent(`${head}${summary.warning ? `\n\n⚠️ ${summary.warning}` : ""}\n\n\`\`\`json\n${JSON.stringify(summary, null, 2).slice(0, 12000)}\n\`\`\``)], structuredContent: summary };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logToolCall({ tool: "shopify_bulk_sync_variant_images", durationMs: Date.now() - start, success: false, error: message });
        return { content: [textContent(`Error: ${message}`)], isError: true };
      }
    }) as never,
  );
}
