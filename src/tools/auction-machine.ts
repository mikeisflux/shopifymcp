/**
 * MCP tools for the automated auction engine — manual controls + visibility over
 * the same engine the scheduler drives. Lets you (or a scheduled Claude session)
 * check status, trigger a cycle on demand, and read/set the adaptive floors.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuctionEngine } from "../auction-engine.js";
import { coverLabel } from "../auction-engine.js";
import { logToolCall } from "../logger.js";
import { textContent } from "../format.js";

const WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;

function wrap(name: string, handler: () => Promise<{ md: string; data: Record<string, unknown> }>) {
  return async () => {
    const start = Date.now();
    try {
      const r = await handler();
      logToolCall({ tool: name, durationMs: Date.now() - start, success: true });
      return { content: [textContent(r.md)], structuredContent: r.data };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      logToolCall({ tool: name, durationMs: Date.now() - start, success: false, error: m });
      return { content: [textContent(`Error: ${m}`)], isError: true };
    }
  };
}

export function registerAuctionMachineTools(server: McpServer, engine: AuctionEngine): void {
  server.registerTool(
    "ebay_auction_status",
    { title: "Auction engine status", description: "Show the automated auction engine's state: active auctions, history, current adaptive floors, per-cover-type performance, last cycle times, and the latest strategy review.", inputSchema: {}, annotations: READ },
    wrap("ebay_auction_status", async () => {
      const r = engine.report();
      return { md: `**Auction engine** (${r.enabled ? "enabled" : "disabled"})\n\n\`\`\`json\n${JSON.stringify(r, null, 2).slice(0, 12000)}\n\`\`\``, data: r as unknown as Record<string, unknown> };
    }) as never,
  );

  server.registerTool(
    "ebay_auction_list_now",
    { title: "Run a listing cycle now", description: "Trigger one auction-listing cycle immediately (outside the schedule): pick top-performing SKUs from the matching 'ebay live' collections that aren't already live, and publish up to `limit` auctions at the current adaptive floors. dryRun previews the selection + start prices without publishing.", inputSchema: { limit: z.number().int().min(1).max(100).optional(), dryRun: z.boolean().default(true) }, annotations: WRITE },
    (async (args: { limit?: number; dryRun: boolean }) => wrap("ebay_auction_list_now", async () => {
      const r = await engine.listBatch(args.limit, args.dryRun);
      const head = args.dryRun ? `**DRY RUN** — would list ${r.listed.length} of ${r.candidates} eligible.` : `Listed ${r.listed.length}; ${r.failed.length} failed (${r.candidates} eligible).`;
      return { md: `${head}\n\n\`\`\`json\n${JSON.stringify(r, null, 2).slice(0, 12000)}\n\`\`\``, data: r as unknown as Record<string, unknown> };
    })())  as never,
  );

  server.registerTool(
    "ebay_auction_ingest_sales",
    { title: "Ingest eBay sales now", description: "Pull recent sold orders from eBay, mark matching auctions sold, and reap closed auctions into history (feeds performance + adaptive floors).", inputSchema: { sinceDays: z.number().int().min(1).max(120).default(30) }, annotations: WRITE },
    (async (args: { sinceDays: number }) => wrap("ebay_auction_ingest_sales", async () => {
      const r = await engine.ingestSales(args.sinceDays);
      return { md: `Matched ${r.soldMatched} sold; closed ${r.closed.length} auctions.`, data: { soldMatched: r.soldMatched, closedCount: r.closed.length, closed: r.closed } };
    })()) as never,
  );

  server.registerTool(
    "ebay_auction_review",
    { title: "Run pricing review now", description: "Recompute per-cover-type performance and adapt the auction floors within their hard bounds (Phase 3), plus an optional LLM strategy narrative (Phase 4). apply=false to preview changes without writing them.", inputSchema: { apply: z.boolean().optional() }, annotations: WRITE },
    (async (args: { apply?: boolean }) => wrap("ebay_auction_review", async () => {
      const r = await engine.reviewAndAdapt(args.apply);
      const lines = r.changes.map((c) => `• ${coverLabel(c.coverType)}: $${c.from.toFixed(2)} → $${c.to.toFixed(2)} (${c.reason})`).join("\n") || "• no floor changes this cycle";
      return { md: `**Floor review**\n${lines}${r.review ? `\n\n**Strategy review:**\n${r.review}` : ""}`, data: r as unknown as Record<string, unknown> };
    })()) as never,
  );

  server.registerTool(
    "ebay_auction_nosku_check",
    { title: "Check for no-SKU sales now", description: "Scan recent eBay orders for line items with no SKU (manual/lot sales that can't auto-sync to Shopify) and record the findings. Runs automatically daily; this triggers it on demand.", inputSchema: { sinceDays: z.number().int().min(1).max(60).default(1) }, annotations: WRITE },
    (async (args: { sinceDays: number }) => wrap("ebay_auction_nosku_check", async () => {
      const r = await engine.checkNoSkuSales(args.sinceDays);
      const head = r.findings.length ? `⚠️ ${r.findings.length} no-SKU line(s) found in the last ${args.sinceDays} day(s).` : `No no-SKU sales in the last ${args.sinceDays} day(s).`;
      return { md: `${head}\n\n\`\`\`json\n${JSON.stringify(r.findings, null, 2).slice(0, 12000)}\n\`\`\``, data: { count: r.findings.length, findings: r.findings } };
    })()) as never,
  );

  server.registerTool(
    "ebay_auction_set_floor",
    { title: "Set an auction floor", description: "Manually set the start-price floor for a cover type (RM, GITD, M, F, REG). Overrides the adaptive value until the engine next adjusts it.", inputSchema: { coverType: z.string().describe("RM | GITD | M | F | REG"), price: z.number().positive() }, annotations: WRITE },
    (async (args: { coverType: string; price: number }) => wrap("ebay_auction_set_floor", async () => {
      const t = args.coverType.toUpperCase();
      engine.store.setFloor(t, args.price);
      return { md: `Floor for ${coverLabel(t)} set to $${args.price.toFixed(2)}.`, data: { coverType: t, price: args.price, floors: engine.store.get().floors } };
    })()) as never,
  );
}
