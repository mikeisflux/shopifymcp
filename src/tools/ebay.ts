/**
 * eBay tools. `ebay_request` is the universal REST escape hatch — it can call
 * ANY eBay API method (Sell / Buy / Commerce / Developer / Feed / Trading via
 * the appropriate path), so every management task the API allows is reachable.
 * The typed tools cover the full Sell Inventory API listing lifecycle
 * (create → revise → retrieve → publish → end) for convenience.
 *
 * Write tools default dryRun:true (echo the planned call without executing);
 * reads execute immediately.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { EbayClient, EbayError } from "../ebay-client.js";
import type { Config, EbayListingDefaults } from "../config.js";
import { logToolCall } from "../logger.js";
import { textContent } from "../format.js";
import { DAY_MS, zonedDayStartToUtc, toZonedIso } from "../tz.js";

type Method = "GET" | "POST" | "PUT" | "DELETE";

interface EbayToolDef<Shape extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  annotations: ToolAnnotations;
  handler: (args: z.objectOutputType<Shape, z.ZodTypeAny>, ebay: EbayClient) => Promise<{ markdown: string; structured: Record<string, unknown> }>;
}

function registerEbayTool<Shape extends z.ZodRawShape>(server: McpServer, ebay: EbayClient, def: EbayToolDef<Shape>): void {
  const callback = async (args: z.objectOutputType<Shape, z.ZodTypeAny>) => {
    const start = Date.now();
    try {
      const result = await def.handler(args, ebay);
      logToolCall({ tool: def.name, durationMs: Date.now() - start, success: true });
      return { content: [textContent(result.markdown)], structuredContent: result.structured };
    } catch (err) {
      const message = err instanceof EbayError || err instanceof Error ? err.message : String(err);
      logToolCall({ tool: def.name, durationMs: Date.now() - start, success: false, error: message });
      return { content: [textContent(`Error: ${message}`)], isError: true };
    }
  };
  server.registerTool(
    def.name,
    { title: def.title, description: def.description, inputSchema: def.inputSchema, annotations: def.annotations },
    callback as never,
  );
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false } as const;

function ok(status: number, data: unknown, extra: Record<string, unknown> = {}): { markdown: string; structured: Record<string, unknown> } {
  return {
    markdown: `HTTP ${status}\n\n\`\`\`json\n${JSON.stringify(data ?? {}, null, 2).slice(0, 12000)}\n\`\`\``,
    structured: { status, data, ...extra },
  };
}

const bodySchema = z.record(z.unknown());

/** Fills an offer payload with the seller's baked-in defaults where fields are absent (caller-provided values always win). */
function withOfferDefaults(body: Record<string, unknown>, d: EbayListingDefaults, marketplaceId: string): Record<string, unknown> {
  const out = { ...body };
  if (out.marketplaceId === undefined) out.marketplaceId = marketplaceId;
  if (out.format === undefined) out.format = d.format;
  if (out.categoryId === undefined && d.categoryId) out.categoryId = d.categoryId;
  if (out.merchantLocationKey === undefined) out.merchantLocationKey = d.locationKey;
  if (out.listingDuration === undefined) out.listingDuration = d.listingDuration;
  const lp: Record<string, unknown> = { ...((out.listingPolicies as Record<string, unknown> | undefined) ?? {}) };
  if (lp.fulfillmentPolicyId === undefined && d.fulfillmentPolicyId) lp.fulfillmentPolicyId = d.fulfillmentPolicyId;
  if (lp.paymentPolicyId === undefined && d.paymentPolicyId) lp.paymentPolicyId = d.paymentPolicyId;
  if (lp.returnPolicyId === undefined && d.returnPolicyId) lp.returnPolicyId = d.returnPolicyId;
  out.listingPolicies = lp;
  return out;
}

/** Builds a default inventory-location payload from the seller's ship-from address. */
function defaultLocationBody(d: EbayListingDefaults): Record<string, unknown> {
  return {
    name: "Divinity Comics",
    merchantLocationStatus: "ENABLED",
    locationTypes: ["WAREHOUSE"],
    location: { address: { addressLine1: d.shipFrom.addressLine1, city: d.shipFrom.city, stateOrProvince: d.shipFrom.stateOrProvince, postalCode: d.shipFrom.postalCode, country: d.shipFrom.country } },
  };
}

export function registerEbayTools(server: McpServer, ebay: EbayClient, config: Config): void {
  const defaults = config.ebayListing;
  // ─── Connectivity ──────────────────────────────────────────────────────────
  registerEbayTool(server, ebay, {
    name: "ebay_test_connection",
    title: "Test eBay connection",
    description: "Mint an eBay OAuth token and make a lightweight Sell Inventory call to confirm auth + connectivity work. Reports the grant type and environment.",
    inputSchema: {},
    annotations: READ,
    handler: async (_args, e) => {
      const res = await e.request("GET", "/sell/inventory/v1/inventory_item", { query: { limit: 1 } });
      const total = (res.data as { total?: number } | undefined)?.total;
      return { markdown: `✅ eBay connection OK (${e.grantType} grant, ${e.apiBase}). Sell Inventory reachable${total !== undefined ? ` — ${total} inventory item(s).` : "."}`, structured: { ok: true, grant: e.grantType, apiBase: e.apiBase, total } };
    },
  });

  // ─── Universal escape hatch ─────────────────────────────────────────────────
  registerEbayTool(server, ebay, {
    name: "ebay_request",
    title: "Call any eBay API (REST)",
    description:
      "Universal eBay REST call — reaches ANY eBay API endpoint (Sell, Buy, Commerce, Developer, Feed, Account, etc.), so every management task the API allows is possible. Provide the HTTP method and path (e.g. \"/sell/inventory/v1/offer/{offerId}/publish\"), optional query params, and an optional JSON body. GET executes immediately; POST/PUT/DELETE respect dryRun (default true — echoes the planned call without sending).",
    inputSchema: {
      method: z.enum(["GET", "POST", "PUT", "DELETE"]).describe("HTTP method."),
      path: z.string().describe('Path after the host, e.g. "/sell/inventory/v1/inventory_item/ABC".'),
      query: z.record(z.union([z.string(), z.number()])).optional().describe("Query parameters."),
      body: bodySchema.optional().describe("JSON request body (for POST/PUT)."),
      marketplaceId: z.string().optional().describe("Override X-EBAY-C-MARKETPLACE-ID (default from config, e.g. EBAY_US)."),
      dryRun: z.boolean().default(true).describe("For non-GET methods: if true (default), echo the planned call without executing. Ignored for GET."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    handler: async (args, e) => {
      const method = args.method as Method;
      if (method !== "GET" && args.dryRun) {
        return { markdown: `**DRY RUN** — would ${method} ${args.path}. Not sent.\n\n\`\`\`json\n${JSON.stringify({ query: args.query ?? {}, body: args.body ?? null }, null, 2)}\n\`\`\`\n\n_Re-run with dryRun:false to execute._`, structured: { dryRun: true, method, path: args.path, query: args.query ?? {}, body: args.body ?? null } };
      }
      const res = await e.request(method, args.path, { query: args.query, body: args.body, marketplaceId: args.marketplaceId });
      return ok(res.status, res.data, res.location ? { location: res.location } : {});
    },
  });

  // ─── Inventory items (read) ─────────────────────────────────────────────────
  registerEbayTool(server, ebay, {
    name: "ebay_get_inventory_item",
    title: "Get inventory item (by SKU)",
    description: "Retrieve one inventory item record by SKU (product details, condition, availability).",
    inputSchema: { sku: z.string().describe("The seller SKU.") },
    annotations: READ,
    handler: async (args, e) => ok(...toPair(await e.request("GET", `/sell/inventory/v1/inventory_item/${encodeURIComponent(args.sku)}`))),
  });
  registerEbayTool(server, ebay, {
    name: "ebay_get_inventory_items",
    title: "List inventory items",
    description: "Retrieve the seller's inventory item records (paginated).",
    inputSchema: { limit: z.number().int().min(1).max(200).default(25).describe("Page size."), offset: z.number().int().min(0).default(0).describe("Offset.") },
    annotations: READ,
    handler: async (args, e) => ok(...toPair(await e.request("GET", "/sell/inventory/v1/inventory_item", { query: { limit: args.limit, offset: args.offset } }))),
  });

  // ─── Inventory items (write) ────────────────────────────────────────────────
  registerEbayTool(server, ebay, {
    name: "ebay_create_or_replace_inventory_item",
    title: "Create/replace inventory item",
    description: "Create or fully replace an inventory item by SKU (PUT). NOTE: this is a full replace — include every field, even unchanged ones. `body` is the inventory item payload (product, condition, availability, …).",
    inputSchema: { sku: z.string().describe("The seller SKU (path)."), body: bodySchema.describe("Full inventory item payload."), dryRun: z.boolean().default(true) },
    annotations: WRITE,
    handler: writeHandler("PUT", (a) => `/sell/inventory/v1/inventory_item/${encodeURIComponent(a.sku as string)}`, (a) => a.body),
  });
  registerEbayTool(server, ebay, {
    name: "ebay_delete_inventory_item",
    title: "Delete inventory item",
    description: "Delete an inventory item by SKU — also ends the listing and deletes its offer.",
    inputSchema: { sku: z.string(), dryRun: z.boolean().default(true) },
    annotations: WRITE,
    handler: writeHandler("DELETE", (a) => `/sell/inventory/v1/inventory_item/${encodeURIComponent(a.sku as string)}`),
  });

  // ─── Offers (read) ──────────────────────────────────────────────────────────
  registerEbayTool(server, ebay, {
    name: "ebay_get_offer",
    title: "Get offer (by offerId)",
    description: "Retrieve one offer by its offerId.",
    inputSchema: { offerId: z.string() },
    annotations: READ,
    handler: async (args, e) => ok(...toPair(await e.request("GET", `/sell/inventory/v1/offer/${encodeURIComponent(args.offerId)}`))),
  });
  registerEbayTool(server, ebay, {
    name: "ebay_get_offers",
    title: "Get offers (by SKU)",
    description: "Retrieve the offers for a SKU (includes offerId, status, and listingId if published).",
    inputSchema: { sku: z.string(), marketplaceId: z.string().optional(), limit: z.number().int().min(1).max(100).default(25), offset: z.number().int().min(0).default(0) },
    annotations: READ,
    handler: async (args, e) => ok(...toPair(await e.request("GET", "/sell/inventory/v1/offer", { query: { sku: args.sku, marketplace_id: args.marketplaceId, limit: args.limit, offset: args.offset } }))),
  });

  // ─── Offers (write / lifecycle) ─────────────────────────────────────────────
  registerEbayTool(server, ebay, {
    name: "ebay_create_offer",
    title: "Create offer",
    description: "Create an offer for a SKU (POST). `body` is the offer payload (sku, pricingSummary, …). Any of marketplaceId, format, categoryId, merchantLocationKey, listingDuration, and listingPolicies (fulfillment/payment/return) you omit are auto-filled from the server's baked-in eBay listing defaults (see ebay_listing_defaults). Returns an offerId.",
    inputSchema: { body: bodySchema.describe("Offer payload (defaults auto-filled)."), dryRun: z.boolean().default(true) },
    annotations: WRITE,
    handler: writeHandler("POST", () => "/sell/inventory/v1/offer", (a) => withOfferDefaults((a.body as Record<string, unknown>) ?? {}, defaults, config.ebayMarketplaceId)),
  });
  registerEbayTool(server, ebay, {
    name: "ebay_update_offer",
    title: "Update offer",
    description: "Update an offer by offerId (PUT — full replace; include all fields). `body` is the full offer payload.",
    inputSchema: { offerId: z.string(), body: bodySchema, dryRun: z.boolean().default(true) },
    annotations: WRITE,
    handler: writeHandler("PUT", (a) => `/sell/inventory/v1/offer/${encodeURIComponent(a.offerId as string)}`, (a) => a.body),
  });
  registerEbayTool(server, ebay, {
    name: "ebay_publish_offer",
    title: "Publish offer (go live)",
    description: "Publish an offer by offerId — creates the live eBay listing. Returns the listingId.",
    inputSchema: { offerId: z.string(), dryRun: z.boolean().default(true) },
    annotations: WRITE,
    handler: writeHandler("POST", (a) => `/sell/inventory/v1/offer/${encodeURIComponent(a.offerId as string)}/publish`),
  });
  registerEbayTool(server, ebay, {
    name: "ebay_withdraw_offer",
    title: "Withdraw offer (end listing, keep offer)",
    description: "End the listing for an offer (offer goes PUBLISHED → UNPUBLISHED but is retained, so it can be republished later).",
    inputSchema: { offerId: z.string(), dryRun: z.boolean().default(true) },
    annotations: WRITE,
    handler: writeHandler("POST", (a) => `/sell/inventory/v1/offer/${encodeURIComponent(a.offerId as string)}/withdraw`),
  });
  registerEbayTool(server, ebay, {
    name: "ebay_delete_offer",
    title: "Delete offer",
    description: "Delete an offer by offerId (ends the listing and removes the offer; the inventory item remains).",
    inputSchema: { offerId: z.string(), dryRun: z.boolean().default(true) },
    annotations: WRITE,
    handler: writeHandler("DELETE", (a) => `/sell/inventory/v1/offer/${encodeURIComponent(a.offerId as string)}`),
  });

  // ─── Bulk price/quantity ────────────────────────────────────────────────────
  registerEbayTool(server, ebay, {
    name: "ebay_bulk_update_price_quantity",
    title: "Bulk update price/quantity (up to 25)",
    description: "Update the price and/or quantity of up to 25 SKUs' active listings in one call. `body` is { requests: [{ sku, shipToLocationAvailability?, offers?: [{ offerId, availableQuantity?, price? }] }, … ] }.",
    inputSchema: { body: bodySchema.describe("bulkUpdatePriceQuantity payload."), dryRun: z.boolean().default(true) },
    annotations: WRITE,
    handler: writeHandler("POST", () => "/sell/inventory/v1/bulk_update_price_quantity", (a) => a.body),
  });

  // ─── Inventory locations ────────────────────────────────────────────────────
  registerEbayTool(server, ebay, {
    name: "ebay_get_inventory_locations",
    title: "List inventory locations",
    description: "Retrieve the seller's inventory locations (merchant location keys).",
    inputSchema: { limit: z.number().int().min(1).max(100).default(25), offset: z.number().int().min(0).default(0) },
    annotations: READ,
    handler: async (args, e) => ok(...toPair(await e.request("GET", "/sell/inventory/v1/location", { query: { limit: args.limit, offset: args.offset } }))),
  });
  registerEbayTool(server, ebay, {
    name: "ebay_create_inventory_location",
    title: "Create inventory location",
    description: "Create an inventory location (POST). Both merchantLocationKey and body default to the server's baked-in ship-from address (see ebay_listing_defaults) when omitted, so a call with no args provisions the seller's default location.",
    inputSchema: { merchantLocationKey: z.string().optional().describe("Seller-defined key (path); defaults to the configured location key."), body: bodySchema.optional().describe("Location payload; defaults to the configured ship-from address."), dryRun: z.boolean().default(true) },
    annotations: WRITE,
    handler: writeHandler(
      "POST",
      (a) => `/sell/inventory/v1/location/${encodeURIComponent((a.merchantLocationKey as string) ?? defaults.locationKey)}`,
      (a) => (a.body as Record<string, unknown>) ?? defaultLocationBody(defaults),
    ),
  });

  // ─── Listing defaults (read) ────────────────────────────────────────────────
  registerEbayTool(server, ebay, {
    name: "ebay_listing_defaults",
    title: "Show eBay listing defaults",
    description: "Return the server's baked-in eBay listing defaults — ship-from location, business policy IDs, and default category/condition/format/duration/title style — that auto-fill create-offer and create-location payloads.",
    inputSchema: {},
    annotations: READ,
    handler: async () => ({
      markdown: "**Baked-in eBay listing defaults** (env-overridable):\n\n```json\n" + JSON.stringify({ marketplaceId: config.ebayMarketplaceId, ...defaults }, null, 2) + "\n```",
      structured: { marketplaceId: config.ebayMarketplaceId, defaults },
    }),
  });

  // ─── Order search (compact, timezone-aware) ─────────────────────────────────
  registerEbayTool(server, ebay, {
    name: "ebay_search_orders",
    title: "Search eBay orders (compact)",
    description:
      "Search recent eBay orders by keyword (matched against line item titles), buyer name, and/or SKU-presence, within a date range expressed in the SELLER'S LOCAL TIMEZONE (default America/Los_Angeles, override EBAY_SELLER_TIMEZONE). Internally paginates the Fulfillment API and filters client-side, returning COMPACT per-order summaries instead of full order payloads. Solves the 'find that lot sale from yesterday' / 'did anything sell this week that has no SKU' problems without paging raw order JSON by hand.",
    inputSchema: {
      query: z.string().optional().describe('Keyword(s) matched case-insensitively against line item titles. Matches an order if ANY whitespace-separated word appears (e.g. "blank glow").'),
      buyerName: z.string().optional().describe("Substring matched case-insensitively against the buyer's full name or eBay username."),
      sinceDays: z.number().int().positive().optional().describe("How many days back to search, evaluated in the seller's local timezone. Default 7. Ignored when dateFrom/dateTo are given."),
      dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Explicit local start date YYYY-MM-DD (inclusive), interpreted in the seller's timezone. Requires dateTo."),
      dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Explicit local end date YYYY-MM-DD (inclusive), interpreted in the seller's timezone. Requires dateFrom."),
      noSkuOnly: z.boolean().optional().describe("If true, only return orders with at least one line item lacking a SKU (manually-listed/custom sales that can't auto-sync to Shopify)."),
      minTotal: z.number().optional().describe("Only orders whose total is >= this amount."),
      maxTotal: z.number().optional().describe("Only orders whose total is <= this amount."),
      limit: z.number().int().positive().optional().describe("Max orders to return. Default 25, max 100."),
    },
    annotations: READ,
    handler: async (args, e) => {
      const tz = config.ebaySellerTimezone;
      const now = new Date();

      // Resolve the local-date window, then convert to a UTC creationdate range.
      let fromUtc: Date;
      let toUtc: Date;
      if (args.dateFrom && args.dateTo) {
        fromUtc = zonedDayStartToUtc(args.dateFrom, tz);
        // inclusive end: start of dateTo + 1 day
        toUtc = new Date(zonedDayStartToUtc(args.dateTo, tz).getTime() + DAY_MS);
      } else if (args.dateFrom || args.dateTo) {
        throw new Error("dateFrom and dateTo must be provided together.");
      } else {
        const sinceDays = args.sinceDays ?? 7;
        const todayLocal = toZonedIso(now, tz).slice(0, 10);
        const todayStartUtc = zonedDayStartToUtc(todayLocal, tz);
        fromUtc = new Date(todayStartUtc.getTime() - sinceDays * DAY_MS);
        toUtc = now;
      }

      const filter = `creationdate:[${fromUtc.toISOString()}..${toUtc.toISOString()}]`;
      const limit = Math.min(Math.max(args.limit ?? 25, 1), 100);

      // Pre-compute filter predicates.
      const words = (args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const buyerNeedle = args.buyerName?.toLowerCase().trim();

      type Li = { title?: string; sku?: string; quantity?: number; lineItemCost?: { value?: string } };
      type Order = {
        orderId?: string;
        creationDate?: string;
        buyer?: { username?: string; buyerRegistrationAddress?: { fullName?: string } };
        pricingSummary?: { total?: { value?: string; currency?: string } };
        lineItems?: Li[];
      };

      const matches: Array<Record<string, unknown>> = [];
      let scanned = 0;
      let offset = 0;
      // Fulfillment API caps limit at 200/page; loop until the window is exhausted.
      for (let page = 0; page < 25; page++) {
        const res = await e.request("GET", "/sell/fulfillment/v1/order", { query: { filter, limit: 200, offset } });
        const data = res.data as { orders?: Order[]; total?: number } | undefined;
        const orders = data?.orders ?? [];
        for (const o of orders) {
          scanned++;
          const lineItems = o.lineItems ?? [];
          const totalStr = o.pricingSummary?.total?.value;
          const totalNum = totalStr !== undefined ? Number(totalStr) : NaN;

          if (args.noSkuOnly && !lineItems.some((li) => !li.sku)) continue;
          if (words.length && !lineItems.some((li) => { const t = (li.title ?? "").toLowerCase(); return words.some((w) => t.includes(w)); })) continue;
          if (buyerNeedle) {
            const full = (o.buyer?.buyerRegistrationAddress?.fullName ?? "").toLowerCase();
            const user = (o.buyer?.username ?? "").toLowerCase();
            if (!full.includes(buyerNeedle) && !user.includes(buyerNeedle)) continue;
          }
          if (args.minTotal !== undefined && (Number.isNaN(totalNum) || totalNum < args.minTotal)) continue;
          if (args.maxTotal !== undefined && (Number.isNaN(totalNum) || totalNum > args.maxTotal)) continue;

          matches.push({
            orderId: o.orderId ?? null,
            buyerName: o.buyer?.buyerRegistrationAddress?.fullName ?? null,
            buyerUsername: o.buyer?.username ?? null,
            dateSoldLocal: o.creationDate ? toZonedIso(new Date(o.creationDate), tz) : null,
            total: totalStr ?? null,
            currency: o.pricingSummary?.total?.currency ?? null,
            hasUnmatchedSku: lineItems.some((li) => !li.sku),
            lineItems: lineItems.map((li) => ({
              title: li.title ?? null,
              sku: li.sku ?? null,
              qty: li.quantity ?? null,
              price: li.lineItemCost?.value ?? null,
            })),
          });
          if (matches.length >= limit) break;
        }
        if (matches.length >= limit || orders.length < 200) break;
        offset += 200;
      }

      const window = { timeZone: tz, fromUtc: fromUtc.toISOString(), toUtc: toUtc.toISOString(), fromLocal: toZonedIso(fromUtc, tz), toLocal: toZonedIso(toUtc, tz) };
      const header = `Found **${matches.length}** order(s) (scanned ${scanned}) in ${tz} window ${window.fromLocal} → ${window.toLocal}.`;
      return {
        markdown: `${header}\n\n\`\`\`json\n${JSON.stringify(matches, null, 2).slice(0, 12000)}\n\`\`\``,
        structured: { count: matches.length, scanned, window, orders: matches },
      };
    },
  });

  // ─── Picture hosting (Trading API) ──────────────────────────────────────────
  registerEbayTool(server, ebay, {
    name: "ebay_upload_hosted_image",
    title: "Upload image to eBay-hosted storage",
    description: "Copy an externally-hosted image (e.g. a Shopify CDN URL) to eBay Picture Services via UploadSiteHostedPictures, returning the eBay-hosted (i.ebayimg.com) URL. Use that URL in listing imageUrls so images display on eBay Live (not just the standard listing) without a manual crop.",
    inputSchema: { imageUrl: z.string().url().describe("Public https image URL to copy to eBay (strip any CDN query string first)."), name: z.string().optional().describe("Optional picture name.") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler: async (args, e) => {
      const hosted = await e.uploadHostedPicture(args.imageUrl, args.name ?? "image");
      return { markdown: `eBay-hosted URL:\n\n${hosted}`, structured: { hostedUrl: hosted, source: args.imageUrl } };
    },
  });

  /** Builds a write-tool handler: dryRun echoes the planned call; else executes. */
  function writeHandler(
    method: Method,
    pathFn: (a: Record<string, unknown>) => string,
    bodyFn?: (a: Record<string, unknown>) => unknown,
  ) {
    return async (args: Record<string, unknown>, e: EbayClient) => {
      const path = pathFn(args);
      const body = bodyFn ? bodyFn(args) : undefined;
      if (args.dryRun !== false) {
        return { markdown: `**DRY RUN** — would ${method} ${path}. Not sent.${body ? `\n\n\`\`\`json\n${JSON.stringify(body, null, 2).slice(0, 8000)}\n\`\`\`` : ""}\n\n_Re-run with dryRun:false to execute._`, structured: { dryRun: true, method, path, body: body ?? null } };
      }
      const res = await e.request(method, path, { body });
      return ok(res.status, res.data, res.location ? { location: res.location } : {});
    };
  }
}

/** Adapts an EbayResponse into ok()'s (status, data) argument pair. */
function toPair(res: { status: number; data: unknown }): [number, unknown] {
  return [res.status, res.data];
}
