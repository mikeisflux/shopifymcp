/**
 * On-demand trigger for the scheduled eBay→Shopify order-import job. Runs the
 * same import the twice-daily scheduler runs (via the shared merge code path).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OrderSyncEngine } from "../order-sync.js";
import { logToolCall } from "../logger.js";
import { textContent } from "../format.js";

export function registerOrderSyncTools(server: McpServer, engine: OrderSyncEngine): void {
  server.registerTool(
    "ebay_order_sync_now",
    {
      title: "Import eBay orders to Shopify now",
      description:
        "Run the eBay→Shopify order import on demand — the same job the scheduler runs twice daily. Imports a trailing window of eBay sales into Shopify draft orders (one per buyer, minOrdersToMerge:1 so single-order stragglers are caught, folding into a buyer's existing open draft rather than duplicating). Idempotent: orders already in a draft are skipped. dryRun (default) previews what would import.",
      inputSchema: {
        lookbackDays: z.number().int().min(0).max(30).optional().describe("How many days back to cover (default from config, usually 2)."),
        dryRun: z.boolean().default(true).describe("true (default): preview the import without creating drafts. false: import."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (async (args: { lookbackDays?: number; dryRun: boolean }) => {
      const start = Date.now();
      try {
        const summary = await engine.run({ lookbackDays: args.lookbackDays, dryRun: args.dryRun });
        const s = (summary ?? {}) as Record<string, unknown>;
        const head = `${args.dryRun ? "**DRY RUN** — " : ""}range ${s.dateRange ?? "?"}: ${s.mergedCount ?? 0} buyer draft(s), ${s.ordersAlreadySynced ?? 0} order(s) already synced, ${s.skippedCount ?? 0} skipped (${s.ordersScanned ?? 0} scanned).`;
        logToolCall({ tool: "ebay_order_sync_now", durationMs: Date.now() - start, success: true });
        return { content: [textContent(`${head}\n\n\`\`\`json\n${JSON.stringify(summary, null, 2).slice(0, 13000)}\n\`\`\``)], structuredContent: (summary ?? {}) as Record<string, unknown> };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logToolCall({ tool: "ebay_order_sync_now", durationMs: Date.now() - start, success: false, error: message });
        return { content: [textContent(`Error: ${message}`)], isError: true };
      }
    }) as never,
  );
}
