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

  // ─── eBay (optional second backend) ──────────────────────────────────────
  /** True when eBay client id + secret are configured; gates the eBay tools. */
  ebayEnabled: boolean;
  ebayEnv: "production" | "sandbox";
  ebayClientId: string | undefined;
  ebayClientSecret: string | undefined;
  /** Refresh token → user access token (required for Sell APIs). If absent, the client falls back to a client-credentials app token. */
  ebayRefreshToken: string | undefined;
  /** Space-separated OAuth scopes used when minting/refreshing the token. */
  ebayScopes: string | undefined;
  /** Default marketplace, e.g. EBAY_US, sent as X-EBAY-C-MARKETPLACE-ID. */
  ebayMarketplaceId: string;
  /**
   * eBay Marketplace Account Deletion/Closure: the verification token you enter
   * in eBay's Alerts & Notifications form (32–80 chars, [A-Za-z0-9_-]). Enables
   * the unauthenticated challenge/notification endpoint that eBay requires before
   * a production keyset activates.
   */
  ebayDeletionVerificationToken: string | undefined;
  /** The exact public HTTPS URL registered with eBay for that endpoint; used in the challenge hash and to mount the route. */
  ebayDeletionEndpointUrl: string | undefined;
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

  // ─── eBay ────────────────────────────────────────────────────────────────
  const ebayClientId = optional("EBAY_CLIENT_ID");
  const ebayClientSecret = optional("EBAY_CLIENT_SECRET");
  const ebayRefreshToken = optional("EBAY_REFRESH_TOKEN");
  const ebayScopes = optional("EBAY_SCOPES");
  const ebayMarketplaceId = optional("EBAY_MARKETPLACE_ID") ?? "EBAY_US";
  const ebayEnvRaw = (optional("EBAY_ENV") ?? "production").toLowerCase();
  const ebayEnv: "production" | "sandbox" = ebayEnvRaw === "sandbox" ? "sandbox" : "production";
  const ebayEnabled = Boolean(ebayClientId && ebayClientSecret);
  if ((ebayClientId || ebayClientSecret) && !ebayEnabled) {
    errors.push("  - eBay needs BOTH EBAY_CLIENT_ID and EBAY_CLIENT_SECRET (or neither).");
  }
  if (ebayEnabled && !ebayRefreshToken && !ebayScopes) {
    errors.push(
      "  - eBay Sell APIs need a user token: set EBAY_REFRESH_TOKEN (recommended). Without it, only " +
        "client-credentials app-token endpoints work, and EBAY_SCOPES is then required.",
    );
  }

  // eBay Marketplace Account Deletion/Closure notification endpoint. Independent
  // of the tools — eBay requires it (or an exemption) to activate a production keyset.
  const ebayDeletionVerificationToken = optional("EBAY_DELETION_VERIFICATION_TOKEN");
  const ebayDeletionEndpointUrl = optional("EBAY_DELETION_ENDPOINT_URL");
  if (ebayDeletionVerificationToken && !/^[A-Za-z0-9_-]{32,80}$/.test(ebayDeletionVerificationToken)) {
    errors.push("  - EBAY_DELETION_VERIFICATION_TOKEN must be 32–80 chars of letters, digits, _ or - (eBay's rule).");
  }
  if (ebayDeletionEndpointUrl && !/^https:\/\/.+/i.test(ebayDeletionEndpointUrl)) {
    errors.push("  - EBAY_DELETION_ENDPOINT_URL must be a full https:// URL (the exact one you register with eBay).");
  }
  if (Boolean(ebayDeletionVerificationToken) !== Boolean(ebayDeletionEndpointUrl)) {
    errors.push("  - The eBay account-deletion endpoint needs BOTH EBAY_DELETION_VERIFICATION_TOKEN and EBAY_DELETION_ENDPOINT_URL (or neither).");
  }

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
    ebayEnabled,
    ebayEnv,
    ebayClientId,
    ebayClientSecret,
    ebayRefreshToken,
    ebayScopes,
    ebayMarketplaceId,
    ebayDeletionVerificationToken,
    ebayDeletionEndpointUrl,
  };
}
