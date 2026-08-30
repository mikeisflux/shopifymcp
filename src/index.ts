/**
 * Shopify Admin MCP server.
 *
 * Express + Streamable HTTP transport in stateless JSON mode (no SSE sessions).
 * Two auth layers protect the MCP endpoint: a secret path segment and an
 * optional bearer token. An unauthenticated /healthz endpoint is exposed for
 * container health checks.
 */

import { createServer } from "node:http";
import { timingSafeEqual, createHash } from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { loadConfig, type Config } from "./config.js";
import { configureLogger, log } from "./logger.js";
import { ShopifyClient } from "./shopify-client.js";
import { registerProductTools, registerProductWriteTools } from "./tools/products.js";
import { registerOrderTools } from "./tools/orders.js";
import { registerOrderWriteTools } from "./tools/orders-write.js";
import { registerCustomerTools } from "./tools/customers.js";
import { registerCustomerWriteTools } from "./tools/customers-write.js";
import { registerInventoryTools, registerInventoryWriteTools } from "./tools/inventory.js";
import { registerDraftOrderTools, registerDraftOrderWriteTools } from "./tools/draft-orders.js";
import { registerReadMiscTools, registerWriteMiscTools } from "./tools/misc.js";
import { registerStoreOpsReadTools, registerStoreOpsWriteTools } from "./tools/store-ops.js";
import { registerCommerceExtraReadTools, registerCommerceExtraWriteTools } from "./tools/commerce-extra.js";
import { registerContentReadTools, registerContentWriteTools } from "./tools/content.js";
import { registerDeleteTools } from "./tools/deletes.js";
import { registerAdminExtraWriteTools } from "./tools/admin-extra.js";
import { registerNormalizeTools } from "./tools/normalize.js";
import { registerNormalizeBookTools } from "./tools/normalize-books.js";
import { registerHandleTools } from "./tools/handles.js";
import { registerPricingTools } from "./tools/pricing.js";
import { registerManagementReadTools, registerManagementWriteTools } from "./tools/management.js";
import { registerAdvancedOrderTools } from "./tools/orders-advanced.js";
import { registerThemeReadTools, registerThemeWriteTools } from "./tools/themes.js";
import { registerBulkTools } from "./tools/bulk.js";
import { registerSplitTools } from "./tools/split.js";
import { EbayClient } from "./ebay-client.js";
import { registerEbayTools } from "./tools/ebay.js";
import { registerEbayBulkTools } from "./tools/ebay-bulk.js";
import { registerEbayMergeTools } from "./tools/ebay-merge.js";
import { registerOrderRepriceTools } from "./tools/order-reprice.js";
import { registerBatchLookupTools } from "./tools/batch-lookups.js";
import { registerProductImageTools } from "./tools/product-images.js";
import { registerEbayListingWorkflowTools } from "./tools/ebay-relist.js";
import { AuctionStore } from "./auction-store.js";
import { AuctionEngine, coverLabel } from "./auction-engine.js";
import { AuctionScheduler } from "./auction-scheduler.js";
import { FulfillmentSyncEngine, startTrackingSyncScheduler } from "./fulfillment-sync.js";
import { registerFulfillmentSyncTools } from "./tools/fulfillment-sync.js";
import { registerAuctionMachineTools } from "./tools/auction-machine.js";

const SERVER_NAME = "shopify-admin-mcp";
const SERVER_VERSION = "1.0.0";

/**
 * Minimal privacy policy served at /privacy. Required as a public https URL by
 * some OAuth app registrations (e.g. eBay's Redirect URL / RuName setup).
 * Edit the contact email below to your preferred address.
 */
const PRIVACY_CONTACT_EMAIL = "divinitycomicsinc@gmail.com";
const PRIVACY_POLICY_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Privacy Policy — Divinity Comics Integration</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; line-height: 1.6; max-width: 720px; margin: 2.5rem auto; padding: 0 1.25rem; color: #1a1a1a; }
  h1 { font-size: 1.6rem; } h2 { font-size: 1.15rem; margin-top: 1.75rem; }
  code { background: #f2f2f2; padding: 0.1em 0.35em; border-radius: 4px; }
  footer { margin-top: 2.5rem; font-size: 0.85rem; color: #666; }
</style>
</head>
<body>
<h1>Privacy Policy</h1>
<p>This application is a private, single-operator integration used by Divinity Comics to
manage its own e-commerce accounts (Shopify and eBay). It is not offered to third parties
and does not create accounts for, or collect data from, the general public.</p>

<h2>What data is accessed</h2>
<p>The application accesses data belonging to the operator's own connected merchant
accounts through official APIs — for example product, inventory, listing, order, and
account-settings data. Access is authorized by the account owner via API credentials and
OAuth tokens that the owner supplies.</p>

<h2>How data is used</h2>
<p>Data is used solely to perform store-management operations the operator initiates
(reading and updating catalog, inventory, pricing, listings, and orders). It is not sold,
rented, or shared with any third party, and it is not used for advertising or profiling.</p>

<h2>Data storage and retention</h2>
<p>The application is stateless: it reads and writes data on demand through the platform
APIs and does not maintain its own database of marketplace-user personal information.
Credentials are held only as server configuration on infrastructure the operator controls.</p>

<h2>Account deletion / closure</h2>
<p>Because the application stores no marketplace-user personal data, there is no retained
personal data to delete when an account-closure notification is received; such
notifications are acknowledged and logged only.</p>

<h2>Contact</h2>
<p>Questions about this policy can be directed to
<a href="mailto:${PRIVACY_CONTACT_EMAIL}">${PRIVACY_CONTACT_EMAIL}</a>.</p>

<footer>Divinity Comics — private store-management integration.</footer>
</body>
</html>`;

/**
 * Conservative default OAuth scope set for the setup wizard when EBAY_SCOPES is
 * unset. Deliberately excludes scopes that require extra entitlements and can
 * make eBay reject the whole authorize request with invalid_request — e.g.
 * sell.stores (needs an eBay Store subscription) and commerce.identity.readonly.
 * Add more via EBAY_SCOPES once the core flow works.
 */
const EBAY_DEFAULT_OAUTH_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  "https://api.ebay.com/oauth/api_scope/sell.marketing",
].join(" ");

/** Renders the automated-auction status dashboard (served at /auction/:secret). */
function renderAuctionDashboard(r: ReturnType<AuctionEngine["report"]>): string {
  const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
  const ago = (iso: string | null): string => {
    if (!iso) return "never";
    const ms = Date.now() - new Date(iso).getTime();
    const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000);
    return h > 0 ? `${h}h ${m}m ago` : `${m}m ago`;
  };
  const floorRows = Object.entries(r.floors).map(([t, v]) => `<tr><td>${esc(coverLabel(t))}</td><td class="num">$${Number(v).toFixed(2)}</td></tr>`).join("") || `<tr><td colspan="2" class="muted">no floors yet</td></tr>`;
  const perfRows = Object.entries(r.performance).map(([t, p]) =>
    `<tr><td>${esc(coverLabel(t))}</td><td class="num">${p.listed}</td><td class="num">${p.sold}</td><td class="num">${(p.sellThrough * 100).toFixed(0)}%</td><td class="num">$${p.avgSold.toFixed(2)}</td></tr>`,
  ).join("") || `<tr><td colspan="5" class="muted">no closed auctions yet — data appears as auctions end</td></tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/><meta http-equiv="refresh" content="60"/>
<title>Auction Engine</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 1.5rem auto; max-width: 780px; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; margin-bottom: .25rem; } .pill { font-size: .8rem; padding: .1em .6em; border-radius: 999px; color: #fff; }
  .on { background: #158a3a; } .off { background: #999; }
  .cards { display: flex; gap: .75rem; flex-wrap: wrap; margin: 1rem 0; }
  .card { flex: 1 1 120px; border: 1px solid #8883; border-radius: 10px; padding: .75rem 1rem; }
  .card .n { font-size: 1.6rem; font-weight: 700; } .card .l { font-size: .8rem; opacity: .7; }
  table { width: 100%; border-collapse: collapse; margin: .5rem 0 1.25rem; } th, td { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid #8882; }
  td.num, th.num { text-align: right; } .muted { opacity: .6; } h2 { font-size: 1rem; margin-top: 1.25rem; }
  pre { background: #8881; padding: 1rem; border-radius: 8px; white-space: pre-wrap; font-size: .9rem; }
  footer { opacity: .6; font-size: .8rem; margin-top: 1.5rem; }
</style></head><body>
<h1>Auction Engine <span class="pill ${r.enabled ? "on" : "off"}">${r.enabled ? "enabled" : "disabled"}</span></h1>
<div class="cards">
  <div class="card"><div class="n">${r.activeCount}</div><div class="l">live auctions</div></div>
  <div class="card"><div class="n">${r.historyCount}</div><div class="l">closed to date</div></div>
  <div class="card"><div class="n">${ago(r.lastListAt)}</div><div class="l">last listed</div></div>
  <div class="card"><div class="n">${ago(r.lastReviewAt)}</div><div class="l">last review</div></div>
</div>
<h2>Current floors (auction start price)</h2>
<table><thead><tr><th>Cover type</th><th class="num">Floor</th></tr></thead><tbody>${floorRows}</tbody></table>
<h2>Performance by cover type</h2>
<table><thead><tr><th>Cover type</th><th class="num">Listed</th><th class="num">Sold</th><th class="num">Sell-through</th><th class="num">Avg sale</th></tr></thead><tbody>${perfRows}</tbody></table>
<h2>Latest strategy review</h2>
<pre>${r.lastReview ? esc(r.lastReview) : "No review yet — runs on the review cycle once there's sales data."}</pre>
<footer>Auto-refreshes every 60s · last sales ingest ${ago(r.lastIngestAt)}</footer>
</body></html>`;
}

/** Renders the eBay OAuth wizard result page (success shows the refresh token). */
function oauthResultPage(heading: string, detail: string | null, refreshToken: string | null, expiresInSec?: number): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
  const expiryNote = expiresInSec ? `<p class="muted">Valid for about ${Math.round(expiresInSec / 86400)} days. When it expires, revisit <code>/ebay/oauth/start</code> to mint a new one.</p>` : "";
  const body = refreshToken
    ? `<p>Copy this into <code>.env</code> as <code>EBAY_REFRESH_TOKEN</code>, then <code>docker compose up -d</code>:</p>
       <pre class="token">EBAY_REFRESH_TOKEN=${esc(refreshToken)}</pre>
       ${expiryNote}
       <p class="warn">Treat this like a password — it grants access to your eBay account. Don't share it. You can revoke it anytime from eBay's User Tokens page.</p>`
    : `<p>${esc(detail ?? "")}</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>eBay OAuth Setup</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; line-height: 1.6; max-width: 760px; margin: 2.5rem auto; padding: 0 1.25rem; color: #1a1a1a; }
  h1 { font-size: 1.5rem; } code { background: #f2f2f2; padding: 0.1em 0.35em; border-radius: 4px; }
  pre.token { background: #0f172a; color: #e2e8f0; padding: 1rem; border-radius: 8px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; font-size: 0.85rem; }
  .muted { color: #666; font-size: 0.9rem; } .warn { color: #a15c00; font-size: 0.9rem; }
</style></head><body>
<h1>${esc(heading)}</h1>
${body}
</body></html>`;
}

/**
 * Builds a fresh MCP server with all applicable tools registered. In stateless
 * mode a new server + transport is created per request to avoid request-id
 * collisions across concurrent clients.
 */
function buildServer(config: Config, client: ShopifyClient, ebayClient: EbayClient | undefined, auctionEngine: AuctionEngine | undefined, trackingEngine: FulfillmentSyncEngine | undefined): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  // Read tools — always registered.
  registerProductTools(server, client);
  registerOrderTools(server, client);
  registerCustomerTools(server, client);
  registerInventoryTools(server, client);
  registerDraftOrderTools(server, client);
  registerReadMiscTools(server, client);
  registerStoreOpsReadTools(server, client);
  registerCommerceExtraReadTools(server, client);
  registerContentReadTools(server, client);
  registerManagementReadTools(server, client);
  registerThemeReadTools(server, client);

  // Write tools — only when ENABLE_WRITES=true.
  if (config.enableWrites) {
    registerProductWriteTools(server, client);
    registerOrderWriteTools(server, client);
    registerCustomerWriteTools(server, client);
    registerInventoryWriteTools(server, client);
    registerDraftOrderWriteTools(server, client);
    registerWriteMiscTools(server, client);
    registerStoreOpsWriteTools(server, client);
    registerCommerceExtraWriteTools(server, client);
    registerContentWriteTools(server, client);
    registerDeleteTools(server, client);
    registerAdminExtraWriteTools(server, client);
    registerNormalizeTools(server, client);
    registerNormalizeBookTools(server, client);
    registerHandleTools(server, client);
    registerPricingTools(server, client);
    registerManagementWriteTools(server, client);
    registerAdvancedOrderTools(server, client);
    registerThemeWriteTools(server, client);
    registerBulkTools(server, client);
    registerSplitTools(server, client);
  }

  // eBay tools — registered when eBay creds AND a usable grant (refresh token or
  // scopes) are configured (independent of the Shopify write gate; eBay write
  // tools default to dryRun). Without a grant the server still runs; the OAuth
  // setup wizard (below) is how you obtain the refresh token.
  if (ebayClient && config.ebayToolsEnabled) {
    registerEbayTools(server, ebayClient, config);
    // Cross-service bulk lister (Shopify collection → eBay auctions). Gated behind
    // the Shopify write flag since it publishes live listings.
    if (config.enableWrites) registerEbayBulkTools(server, client, ebayClient, config);
    // Cross-service: merge a day's eBay sales into Shopify draft orders per buyer.
    if (config.enableWrites) registerEbayMergeTools(server, client, ebayClient, config);
    // Cross-service: reprice completed Shopify orders to the real eBay sale price.
    if (config.enableWrites) registerOrderRepriceTools(server, client, ebayClient, config);
    // Batch lookup primitives (SKU→variant, eBay listing status).
    registerBatchLookupTools(server, client, ebayClient);
    // Higher-level listing workflows (relist sold covers, duplicate for copies).
    if (config.enableWrites) registerEbayListingWorkflowTools(server, client, ebayClient, config);
  }

  // Bulk product-image sync (Shopify-only; needs write access).
  if (config.enableWrites) registerProductImageTools(server, client);

  // Automated auction engine controls (status + manual cycle triggers).
  if (auctionEngine && config.enableWrites) {
    registerAuctionMachineTools(server, auctionEngine);
  }

  // Shopify→eBay tracking sync (on-demand trigger for the scheduled job).
  if (trackingEngine && config.enableWrites) {
    registerFulfillmentSyncTools(server, trackingEngine);
  }

  return server;
}

/** Constant-time string comparison that never throws on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function main(): void {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
    process.exit(1);
    return;
  }

  configureLogger(config.logLevel);
  const client = new ShopifyClient(config);
  const ebayClient = config.ebayEnabled ? new EbayClient(config) : undefined;

  // Automated auction engine: persistent store + scheduler, running on the server
  // itself (no Claude chat required). Only active when eBay is configured.
  let auctionEngine: AuctionEngine | undefined;
  let trackingEngine: FulfillmentSyncEngine | undefined;
  if (ebayClient) {
    const store = new AuctionStore(config.auction.stateDir);
    auctionEngine = new AuctionEngine(config, client, ebayClient, store);
    new AuctionScheduler(auctionEngine, config.auction).start();
    // Shopify→eBay tracking sync engine + its own scheduler.
    trackingEngine = new FulfillmentSyncEngine(client, ebayClient, config);
    startTrackingSyncScheduler(trackingEngine, config);
  }
  const app = express();
  app.use(express.json({ limit: "4mb" }));

  // Health check — unauthenticated, no store info leaked.
  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION });
  });

  // Privacy policy — unauthenticated static page. Some integrations (e.g. eBay's
  // OAuth Redirect URL / RuName setup) require a public https privacy-policy URL.
  app.get("/privacy", (_req: Request, res: Response) => {
    res.status(200).type("html").send(PRIVACY_POLICY_HTML);
  });

  // Auction-engine status dashboard — behind the MCP secret path (business data).
  if (auctionEngine) {
    app.get("/auction/:secret", (req: Request, res: Response) => {
      if (!safeEqual(req.params.secret ?? "", config.mcpPathSecret)) { res.status(404).end(); return; }
      res.status(200).type("html").send(renderAuctionDashboard(auctionEngine!.report()));
    });
  }

  // eBay OAuth setup wizard — obtains a long-lived refresh token via the
  // authorization-code flow, which eBay's portal "test token" tool does not hand
  // out. Enabled when eBay client creds + a RuName are configured. Unauthenticated
  // (the flow's security is the eBay login + the single-use, short-lived code).
  //   /ebay/oauth/start  -> 302 to eBay consent
  //   /ebay/oauth/return -> eBay redirects here with ?code=…; we exchange + show
  //                         the refresh token. (Set the RuName's accepted URL to this.)
  if (ebayClient && config.ebayOauthRuName) {
    const runame = config.ebayOauthRuName;
    const scopes = config.ebayScopes ?? EBAY_DEFAULT_OAUTH_SCOPES;

    app.get("/ebay/oauth/start", (_req: Request, res: Response) => {
      res.redirect(ebayClient.buildAuthorizeUrl(runame, scopes));
    });

    app.get("/ebay/oauth/return", async (req: Request, res: Response) => {
      // Read code/error from the RAW query string, not req.query: eBay auth codes
      // contain base64 chars (+, /, =) and '#'. Express's parser turns '+' into a
      // space, corrupting the code. decodeURIComponent preserves '+' correctly.
      const rawUrl = req.originalUrl || req.url || "";
      const grab = (name: string): string => {
        const m = new RegExp(`[?&]${name}=([^&]*)`).exec(rawUrl);
        return m ? decodeURIComponent(m[1]!) : "";
      };
      const code = grab("code");
      const err = grab("error");
      if (err) {
        const desc = typeof req.query.error_description === "string" ? req.query.error_description : "";
        res.status(400).type("html").send(oauthResultPage("eBay authorization was declined or failed", `${err}${desc ? `: ${desc}` : ""}`, null));
        return;
      }
      if (!code) {
        res.status(400).type("html").send(oauthResultPage("Missing authorization code", "This page is the eBay OAuth redirect target. Start the flow at /ebay/oauth/start.", null));
        return;
      }
      try {
        const tok = await ebayClient.exchangeAuthCode(code, runame);
        if (!tok.refresh_token) {
          res.status(502).type("html").send(oauthResultPage("No refresh token returned", "eBay accepted the code but did not return a refresh_token. Ensure the RuName is OAuth-enabled and try again.", null));
          return;
        }
        log.info("ebay_oauth_refresh_token_minted", { refresh_token_expires_in: tok.refresh_token_expires_in });
        res.status(200).type("html").send(oauthResultPage("Refresh token obtained ✓", null, tok.refresh_token, tok.refresh_token_expires_in));
      } catch (e) {
        log.error("ebay_oauth_exchange_failed", { error: e instanceof Error ? e.message : String(e) });
        res.status(500).type("html").send(oauthResultPage("Token exchange failed", e instanceof Error ? e.message : String(e), null));
      }
    });

    log.info("ebay_oauth_wizard_registered", { start: "/ebay/oauth/start" });
  }

  // eBay Marketplace Account Deletion/Closure notification endpoint — unauthenticated
  // (eBay calls it directly). Required before a production keyset activates.
  //   • Validation: eBay sends GET ?challenge_code=… → we return 200 with
  //     {"challengeResponse": SHA256(challengeCode + verificationToken + endpointUrl)}.
  //   • Notifications: eBay POSTs account-deletion events → we log and return 200.
  // The route is mounted at the pathname of the registered endpoint URL so the URL
  // eBay hashes against always matches the URL it hits.
  if (config.ebayDeletionVerificationToken && config.ebayDeletionEndpointUrl) {
    const token = config.ebayDeletionVerificationToken;
    const endpointUrl = config.ebayDeletionEndpointUrl;
    let deletionPath = "/ebay/deletion";
    try {
      deletionPath = new URL(endpointUrl).pathname || "/ebay/deletion";
    } catch {
      log.warn("ebay_deletion_endpoint_url_unparsable", { endpointUrl });
    }

    app.get(deletionPath, (req: Request, res: Response) => {
      const challengeCode = typeof req.query.challenge_code === "string" ? req.query.challenge_code : "";
      if (!challengeCode) {
        res.status(400).json({ error: "missing challenge_code" });
        return;
      }
      const challengeResponse = createHash("sha256")
        .update(challengeCode)
        .update(token)
        .update(endpointUrl)
        .digest("hex");
      res.status(200).json({ challengeResponse });
    });

    app.post(deletionPath, (req: Request, res: Response) => {
      const notification = (req.body ?? {}) as { metadata?: { topic?: string }; notification?: { data?: { username?: string } } };
      log.info("ebay_account_deletion_notification", {
        topic: notification.metadata?.topic,
        username: notification.notification?.data?.username,
      });
      // We store no eBay marketplace-user PII (single-seller tool using owner creds),
      // so there is nothing to purge. Acknowledge so eBay stops retrying.
      res.status(200).end();
    });

    log.info("ebay_deletion_endpoint_registered", { path: deletionPath });
  }

  const mcpPath = `/mcp/:secret`;

  // Auth middleware for the MCP route: secret path segment, then bearer token.
  const authenticate = (req: Request, res: Response, next: NextFunction): void => {
    // Layer 1: secret path segment. Anything else is a 404 (don't reveal the route).
    if (!safeEqual(req.params.secret ?? "", config.mcpPathSecret)) {
      res.status(404).end();
      return;
    }
    // Layer 2 (optional): bearer token.
    if (config.mcpAuthToken) {
      const header = req.header("authorization") ?? "";
      const match = /^Bearer\s+(.+)$/i.exec(header);
      if (!match || !safeEqual(match[1]!, config.mcpAuthToken)) {
        res.status(401).json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unauthorized" },
          id: null,
        });
        return;
      }
    }
    next();
  };

  // Stateless JSON: POST carries the JSON-RPC request; a fresh server +
  // transport handle it and are torn down when the response closes.
  app.post(mcpPath, authenticate, async (req: Request, res: Response) => {
    const server = buildServer(config, client, ebayClient, auctionEngine, trackingEngine);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error("mcp_request_failed", { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // Stateless mode has no server-initiated stream or session to delete.
  const methodNotAllowed = (_req: Request, res: Response): void => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. This server is stateless JSON; use POST." },
      id: null,
    });
  };
  app.get(mcpPath, authenticate, methodNotAllowed);
  app.delete(mcpPath, authenticate, methodNotAllowed);

  const httpServer = createServer(app);
  httpServer.listen(config.port, () => {
    log.info("server_started", {
      port: config.port,
      writes_enabled: config.enableWrites,
      auth_token_required: Boolean(config.mcpAuthToken),
      shopify_auth_mode: config.authMode,
      api_version: config.shopifyApiVersion,
    });

    // Best-effort: log which access scopes the token actually holds, so a mutation
    // failing on a missing scope is diagnosable from the startup logs. Never fatal.
    void (async () => {
      try {
        const res = await client.request<{ currentAppInstallation: { accessScopes: Array<{ handle: string }> } }>(
          "query AccessScopes { currentAppInstallation { accessScopes { handle } } }",
        );
        const scopes = res.data.currentAppInstallation.accessScopes.map((s) => s.handle).sort();
        const writeScopes = scopes.filter((s) => s.startsWith("write_"));
        log.info("access_scopes", { total: scopes.length, write_scopes: writeScopes });
      } catch (err) {
        log.warn("access_scopes_check_failed", { error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });

  const shutdown = (signal: string) => {
    log.info("shutting_down", { signal });
    httpServer.close(() => process.exit(0));
    // Force exit if connections linger.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
