/**
 * Shopify Admin MCP server.
 *
 * Express + Streamable HTTP transport in stateless JSON mode (no SSE sessions).
 * Two auth layers protect the MCP endpoint: a secret path segment and an
 * optional bearer token. An unauthenticated /healthz endpoint is exposed for
 * container health checks.
 */

import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
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

const SERVER_NAME = "shopify-admin-mcp";
const SERVER_VERSION = "1.0.0";

/**
 * Builds a fresh MCP server with all applicable tools registered. In stateless
 * mode a new server + transport is created per request to avoid request-id
 * collisions across concurrent clients.
 */
function buildServer(config: Config, client: ShopifyClient, ebayClient: EbayClient | undefined): McpServer {
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

  // eBay tools — registered when eBay credentials are configured (independent of
  // the Shopify write gate; eBay write tools default to dryRun).
  if (ebayClient) {
    registerEbayTools(server, ebayClient);
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
  const app = express();
  app.use(express.json({ limit: "4mb" }));

  // Health check — unauthenticated, no store info leaked.
  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION });
  });

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
    const server = buildServer(config, client, ebayClient);
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
