/**
 * Environment configuration + startup validation.
 * Exits the process with a clear message if a required var is missing.
 */

/**
 * How the server authenticates to the Shopify Admin API.
 * - "client_credentials": Dev Dashboard app — exchange client id/secret for a
 *   short-lived (~24h) access token that the client fetches and auto-refreshes.
 *   This is the supported path since legacy custom apps were discontinued
 *   (Jan 1 2026).
 * - "static": a pre-2026 legacy custom app token (shpat_...), used as-is.
 */
export type ShopifyAuthMode = "client_credentials" | "static";

export interface Config {
  shopifyStoreDomain: string;
  shopifyApiVersion: string;
  authMode: ShopifyAuthMode;
  /** Set when authMode === "static". */
  shopifyAccessToken: string | undefined;
  /** Set when authMode === "client_credentials". */
  shopifyClientId: string | undefined;
  shopifyClientSecret: string | undefined;
  mcpPathSecret: string;
  mcpAuthToken: string | undefined;
  enableWrites: boolean;
  port: number;
  logLevel: LogLevel;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

function required(name: string, errors: string[]): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    errors.push(`  - ${name} is required but not set`);
    return "";
  }
  return value.trim();
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Reads and validates configuration from process.env.
 * Throws with an aggregated message listing every problem found.
 */
export function loadConfig(): Config {
  const errors: string[] = [];

  const shopifyStoreDomain = required("SHOPIFY_STORE_DOMAIN", errors);
  const shopifyApiVersion = required("SHOPIFY_API_VERSION", errors);
  const mcpPathSecret = required("MCP_PATH_SECRET", errors);

  // Auth: prefer client-credentials (Dev Dashboard app), fall back to a static
  // legacy token. Exactly one mode must be fully configured.
  const shopifyClientId = optional("SHOPIFY_CLIENT_ID");
  const shopifyClientSecret = optional("SHOPIFY_CLIENT_SECRET");
  const shopifyAccessToken = optional("SHOPIFY_ACCESS_TOKEN");

  let authMode: ShopifyAuthMode = "client_credentials";
  if (shopifyClientId || shopifyClientSecret) {
    authMode = "client_credentials";
    if (!shopifyClientId) errors.push("  - SHOPIFY_CLIENT_ID is required when using client credentials");
    if (!shopifyClientSecret) errors.push("  - SHOPIFY_CLIENT_SECRET is required when using client credentials");
  } else if (shopifyAccessToken) {
    authMode = "static";
  } else {
    errors.push(
      "  - No Shopify credentials set. Provide SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET " +
        "(Dev Dashboard app, recommended) or a SHOPIFY_ACCESS_TOKEN (pre-2026 legacy custom app).",
    );
  }

  if (shopifyStoreDomain && !/^[a-z0-9-]+\.myshopify\.com$/i.test(shopifyStoreDomain)) {
    errors.push(
      `  - SHOPIFY_STORE_DOMAIN "${shopifyStoreDomain}" does not look like a *.myshopify.com domain ` +
        `(no protocol, no path, e.g. "yourstore.myshopify.com")`,
    );
  }

  if (mcpPathSecret && mcpPathSecret.length < 32) {
    errors.push(
      `  - MCP_PATH_SECRET must be at least 32 characters (got ${mcpPathSecret.length})`,
    );
  }

  if (shopifyApiVersion && !/^\d{4}-\d{2}$/.test(shopifyApiVersion)) {
    errors.push(
      `  - SHOPIFY_API_VERSION "${shopifyApiVersion}" should look like "2026-04"`,
    );
  }

  const rawLogLevel = (process.env.LOG_LEVEL ?? "info").trim().toLowerCase();
  const logLevel = (LOG_LEVELS as string[]).includes(rawLogLevel)
    ? (rawLogLevel as LogLevel)
    : "info";

  const rawPort = (process.env.PORT ?? "3000").trim();
  const port = Number.parseInt(rawPort, 10);
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    errors.push(`  - PORT "${rawPort}" is not a valid port number`);
  }

  const mcpAuthTokenRaw = (process.env.MCP_AUTH_TOKEN ?? "").trim();
  const mcpAuthToken = mcpAuthTokenRaw === "" ? undefined : mcpAuthTokenRaw;

  const enableWrites = (process.env.ENABLE_WRITES ?? "false").trim().toLowerCase() === "true";

  if (errors.length > 0) {
    throw new Error(
      `Invalid configuration. Fix the following environment variables:\n${errors.join("\n")}`,
    );
  }

  return {
    shopifyStoreDomain,
    shopifyApiVersion,
    authMode,
    shopifyAccessToken,
    shopifyClientId,
    shopifyClientSecret,
    mcpPathSecret,
    mcpAuthToken,
    enableWrites,
    port,
    logLevel,
  };
}
