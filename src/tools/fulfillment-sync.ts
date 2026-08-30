/**
 * MCP tool wrapping the Shopify→eBay tracking sync engine. Runs automatically on
 * a schedule (every EBAY_TRACKING_SYNC_INTERVAL_MIN minutes); this triggers it
 * on demand — same pattern as ebay_auction_ingest_sales.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FulfillmentSyncEngine } from "../fulfillment-sync.js";
import { logToolCall } from "../logger.js";
import { textContent } from "../format.js";

export function registerFulfillmentSyncTools(server: McpServer, engine: FulfillmentSyncEngine): void {
  server.registerTool(
    "ebay_sync_fulfillment_tracking",
    {
      title: "Sync Shopify tracking to eBay",
      description:
        "Push tracking numbers from shipped Shopify orders onto the matching eBay order(s), marking them shipped. Matches a Shopify order to eBay by name (the eBay order id verbatim, e.g. 26-15065-57798) or, for merge-draft orders, by every eBay order id in the note (tracking is pushed to each). Skips orders with no tracking, non-eBay orders, and eBay orders already FULFILLED (idempotent). Runs automatically on a schedule; this triggers it on demand. dryRun (default) previews what would be pushed.",
      inputSchema: {
        sinceMinutes: z.number().int().positive().optional().describe("Check orders fulfilled in the last N minutes instead of since the last scheduled run (default 10 when neither this nor orderIds is set)."),
        orderIds: z.array(z.string()).optional().describe("Sync these specific Shopify orders directly (numeric or GID), bypassing the time scan — e.g. to retry one."),
        dryRun: z.boolean().default(true).describe("true (default): preview which orders would get tracking pushed and what would be sent, without calling eBay. false: push."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (async (args: { sinceMinutes?: number; orderIds?: string[]; dryRun: boolean }) => {
      const start = Date.now();
      try {
        // On-demand default: last 10 minutes (unless specific orderIds were given).
        const sinceMinutes = args.orderIds?.length ? undefined : args.sinceMinutes ?? 10;
        const r = await engine.run({ sinceMinutes, orderIds: args.orderIds, dryRun: args.dryRun });
        const head = `${args.dryRun ? "**DRY RUN** — " : ""}synced ${r.synced.length}, already-fulfilled ${r.skippedAlreadyFulfilled.length}, no-tracking ${r.skippedNoTracking.length}, no-eBay-match ${r.skippedNoEbayMatch.length}, failed ${r.failed.length}.`;
        logToolCall({ tool: "ebay_sync_fulfillment_tracking", durationMs: Date.now() - start, success: true });
        return { content: [textContent(`${head}\n\n\`\`\`json\n${JSON.stringify(r, null, 2).slice(0, 13000)}\n\`\`\``)], structuredContent: r as unknown as Record<string, unknown> };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logToolCall({ tool: "ebay_sync_fulfillment_tracking", durationMs: Date.now() - start, success: false, error: message });
        return { content: [textContent(`Error: ${message}`)], isError: true };
      }
    }) as never,
  );
}
