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
  /** True when the eBay tools should be registered (client creds + a usable grant: refresh token or scopes). */
  ebayToolsEnabled: boolean;
  /** eBay OAuth RuName (redirect_uri value) for the built-in refresh-token setup wizard at /ebay/oauth/start. */
  ebayOauthRuName: string | undefined;
  /**
   * eBay Marketplace Account Deletion/Closure: the verification token you enter
   * in eBay's Alerts & Notifications form (32–80 chars, [A-Za-z0-9_-]). Enables
   * the unauthenticated challenge/notification endpoint that eBay requires before
   * a production keyset activates.
   */
  ebayDeletionVerificationToken: string | undefined;
  /** The exact public HTTPS URL registered with eBay for that endpoint; used in the challenge hash and to mount the route. */
  ebayDeletionEndpointUrl: string | undefined;
  /** Baked-in defaults for building eBay listings (ship-from, policies, comic defaults). */
  ebayListing: EbayListingDefaults;
  /** Automated auction engine (scheduler + adaptive pricing). */
  auction: AuctionAutomationConfig;
}

/**
 * Baked-in defaults for building eBay listings, so the seller's ship-from
 * address, business policies, and preferred listing settings are applied
 * consistently without re-entering them each time. Every field is env-overridable.
 */
export interface EbayListingDefaults {
  /** merchantLocationKey used for offers + create-location. */
  locationKey: string;
  /** Ship-from address (required by eBay inventory locations + calculated shipping). */
  shipFrom: { addressLine1?: string; city: string; stateOrProvince: string; postalCode: string; country: string };
  fulfillmentPolicyId?: string;
  paymentPolicyId?: string;
  returnPolicyId?: string;
  /** Default leaf category (259104 = Comics & Graphic Novels). */
  categoryId?: string;
  /** Condition enum for inventory items (NEW = Brand New). */
  condition: string;
  /** Offer format (AUCTION | FIXED_PRICE). */
  format: string;
  /** Auction/fixed listing duration (e.g. DAYS_7, GTC). */
  listingDuration: string;
  /** How the agent should build listing titles ("reader" = buyer-friendly from code+series+variant). */
  titleStyle: string;
}

/**
 * Automated auction engine: a self-hosted scheduler that periodically lists
 * batches of eBay-Live books, ingests sold data, and adapts per-cover-type
 * auction floors. Runs on the server itself (no Claude chat required).
 */
export interface AuctionAutomationConfig {
  /** Master switch — the scheduler only runs when true. */
  enabled: boolean;
  /** Directory for the persistent state file (mount a docker volume here). */
  stateDir: string;
  /** Case-insensitive substring a collection title must contain to be auto-listed. */
  collectionMatch: string;
  /** Max new auctions to publish per listing cycle. */
  batchSize: number;
  /** Minutes between listing cycles / sales-ingest cycles / floor-update (review) cycles. */
  listIntervalMin: number;
  ingestIntervalMin: number;
  reviewIntervalMin: number;
  /** Auction duration in days. */
  durationDays: number;
  /** Initial start-price floor per cover type (seeds the persisted, adapting floors). */
  initialFloors: Record<string, number>;
  /** Absolute minimum floor per cover type (fee/cost-aware; adaptation never goes below). */
  hardMinFloors: Record<string, number>;
  /** Absolute maximum any floor may adapt to. */
  hardMaxFloor: number;
  /** Optional Anthropic API key enabling the Phase-4 nightly LLM strategy review. */
  anthropicApiKey: string | undefined;
  /** When true, the engine applies its own adaptive floor changes; when false it only recommends. */
  autoApplyFloors: boolean;
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
  const ebayOauthRuName = optional("EBAY_OAUTH_RUNAME");
  const ebayEnabled = Boolean(ebayClientId && ebayClientSecret);
  if ((ebayClientId || ebayClientSecret) && !ebayEnabled) {
    errors.push("  - eBay needs BOTH EBAY_CLIENT_ID and EBAY_CLIENT_SECRET (or neither).");
  }
  // The tools need a usable grant (a user refresh token, or scopes for an app
  // token). Lacking one is NOT fatal: the server still boots (so the Shopify
  // tools and the OAuth setup wizard keep working) — the eBay tools just stay
  // unregistered until a refresh token is supplied.
  const ebayToolsEnabled = ebayEnabled && Boolean(ebayRefreshToken || ebayScopes);

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

  // eBay listing defaults. Baked in for Divinity Comics so listings are built
  // consistently without re-entering ship-from/policies each time; all env-overridable.
  const ebayListing: EbayListingDefaults = {
    locationKey: optional("EBAY_LOCATION_KEY") ?? "DIVINITY_MAIN",
    shipFrom: {
      addressLine1: optional("EBAY_SHIP_FROM_ADDRESS1"),
      city: optional("EBAY_SHIP_FROM_CITY") ?? "Portage",
      stateOrProvince: optional("EBAY_SHIP_FROM_STATE") ?? "IN",
      postalCode: optional("EBAY_SHIP_FROM_POSTAL_CODE") ?? "46368",
      country: optional("EBAY_SHIP_FROM_COUNTRY") ?? "US",
    },
    fulfillmentPolicyId: optional("EBAY_FULFILLMENT_POLICY_ID") ?? "112672138015",
    paymentPolicyId: optional("EBAY_PAYMENT_POLICY_ID") ?? "294948746015",
    returnPolicyId: optional("EBAY_RETURN_POLICY_ID") ?? "98247945015",
    categoryId: optional("EBAY_DEFAULT_CATEGORY_ID") ?? "259104",
    condition: optional("EBAY_DEFAULT_CONDITION") ?? "NEW",
    format: optional("EBAY_DEFAULT_LISTING_FORMAT") ?? "AUCTION",
    listingDuration: optional("EBAY_DEFAULT_LISTING_DURATION") ?? "DAYS_7",
    titleStyle: optional("EBAY_TITLE_STYLE") ?? "reader",
  };

  // ─── Automated auction engine ──────────────────────────────────────────────
  const parseFloors = (name: string, fallback: Record<string, number>): Record<string, number> => {
    const raw = optional(name);
    if (!raw) return fallback;
    try {
      const parsed = JSON.parse(raw) as Record<string, number>;
      return { ...fallback, ...parsed };
    } catch {
      errors.push(`  - ${name} must be JSON like {"RM":20,"GITD":30,"M":20,"F":15,"REG":5}`);
      return fallback;
    }
  };
  const auction: AuctionAutomationConfig = {
    enabled: (optional("AUTO_AUCTION_ENABLED") ?? "false").toLowerCase() === "true",
    stateDir: optional("AUTO_AUCTION_STATE_DIR") ?? "/data",
    collectionMatch: (optional("AUTO_AUCTION_COLLECTION_MATCH") ?? "ebaylive").toLowerCase(),
    batchSize: Number.parseInt(optional("AUTO_AUCTION_BATCH_SIZE") ?? "20", 10) || 20,
    listIntervalMin: Number.parseInt(optional("AUTO_AUCTION_LIST_INTERVAL_MIN") ?? "360", 10) || 360,
    ingestIntervalMin: Number.parseInt(optional("AUTO_AUCTION_INGEST_INTERVAL_MIN") ?? "120", 10) || 120,
    reviewIntervalMin: Number.parseInt(optional("AUTO_AUCTION_REVIEW_INTERVAL_MIN") ?? "1440", 10) || 1440,
    durationDays: Number.parseInt(optional("AUTO_AUCTION_DURATION_DAYS") ?? "7", 10) || 7,
    initialFloors: parseFloors("AUTO_AUCTION_FLOORS", { RM: 20, GITD: 30, M: 20, F: 15, REG: 5 }),
    hardMinFloors: parseFloors("AUTO_AUCTION_HARD_MIN_FLOORS", { RM: 10, GITD: 15, M: 10, F: 7, REG: 3 }),
    hardMaxFloor: Number.parseInt(optional("AUTO_AUCTION_HARD_MAX_FLOOR") ?? "250", 10) || 250,
    anthropicApiKey: optional("AUTO_AUCTION_ANTHROPIC_API_KEY") ?? optional("ANTHROPIC_API_KEY"),
    autoApplyFloors: (optional("AUTO_AUCTION_AUTO_APPLY_FLOORS") ?? "true").toLowerCase() === "true",
  };

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
    ebayToolsEnabled,
    ebayOauthRuName,
    ebayDeletionVerificationToken,
    ebayDeletionEndpointUrl,
    ebayListing,
    auction,
  };
}
