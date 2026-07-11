/**
 * Shopify Admin GraphQL client.
 *
 * - POSTs to /admin/api/{version}/graphql.json with the access token header.
 * - Retries once on HTTP 429 (respecting Retry-After) and on GraphQL
 *   THROTTLED cost errors, with a short backoff.
 * - Surfaces GraphQL/userErrors and access-scope errors as actionable messages.
 */

import type { Config } from "./config.js";
import { log } from "./logger.js";

export interface GraphQLCost {
  requestedQueryCost?: number;
  actualQueryCost?: number;
  throttleStatus?: {
    maximumAvailable?: number;
    currentlyAvailable?: number;
    restoreRate?: number;
  };
}

export interface GraphQLResponse<T> {
  data: T;
  cost: number | undefined;
}

interface RawGraphQLError {
  message: string;
  extensions?: {
    code?: string;
    documentation?: string;
    requiredAccess?: string;
    [key: string]: unknown;
  };
}

interface RawGraphQLBody<T> {
  data?: T;
  errors?: RawGraphQLError[];
  extensions?: { cost?: GraphQLCost };
}

/** Thrown for any failed Shopify call. `code` mirrors the GraphQL error code when known. */
export class ShopifyError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "ShopifyError";
    this.code = code;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Per-attempt retry bookkeeping so each failure mode retries at most once. */
interface Attempt {
  rateLimitRetried: boolean;
  authRetried: boolean;
}

/** Refresh a client-credentials token this many ms before it actually expires. */
const TOKEN_EXPIRY_SKEW_MS = 5 * 60 * 1000;

export class ShopifyClient {
  private readonly config: Config;
  private readonly endpoint: string;
  private readonly tokenEndpoint: string;

  // Client-credentials token cache.
  private cachedToken: string | undefined;
  private tokenExpiresAtMs = 0;
  private inflightToken: Promise<string> | undefined;

  constructor(config: Config) {
    this.config = config;
    this.endpoint = `https://${config.shopifyStoreDomain}/admin/api/${config.shopifyApiVersion}/graphql.json`;
    this.tokenEndpoint = `https://${config.shopifyStoreDomain}/admin/oauth/access_token`;
  }

  /**
   * Returns a valid Admin API access token. In static mode this is the
   * configured token; in client-credentials mode it fetches and caches a
   * short-lived token, refreshing it before expiry.
   */
  private async getAccessToken(forceRefresh = false): Promise<string> {
    if (this.config.authMode === "static") {
      return this.config.shopifyAccessToken!;
    }

    const now = Date.now();
    if (!forceRefresh && this.cachedToken && now < this.tokenExpiresAtMs - TOKEN_EXPIRY_SKEW_MS) {
      return this.cachedToken;
    }
    // De-duplicate concurrent refreshes.
    if (!this.inflightToken) {
      this.inflightToken = this.fetchClientCredentialsToken().finally(() => {
        this.inflightToken = undefined;
      });
    }
    return this.inflightToken;
  }

  /** Exchanges client id/secret for an access token via the client-credentials grant. */
  private async fetchClientCredentialsToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.config.shopifyClientId!,
      client_secret: this.config.shopifyClientSecret!,
    });

    let response: Response;
    try {
      response = await fetch(this.tokenEndpoint, {
        method: "POST",
        // Shopify requires form-encoding here, NOT application/json.
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: body.toString(),
      });
    } catch (err) {
      throw new ShopifyError(
        `Network error fetching Shopify access token: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (/shop_not_permitted/i.test(text)) {
        throw new ShopifyError(
          "Client credentials rejected (shop_not_permitted): the app and the store must belong to the " +
            "same Shopify organization, and the app must be installed on the store.",
          "UNAUTHENTICATED",
        );
      }
      throw new ShopifyError(
        `Failed to obtain access token (HTTP ${response.status}). Check SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET ` +
          `and that the app is installed on the store. ${text.slice(0, 300)}`.trim(),
        "UNAUTHENTICATED",
      );
    }

    const json = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!json.access_token) {
      throw new ShopifyError("Shopify token endpoint returned no access_token.");
    }

    const expiresInSec = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 3600;
    this.cachedToken = json.access_token;
    this.tokenExpiresAtMs = Date.now() + expiresInSec * 1000;
    log.info("shopify_token_refreshed", { expires_in_s: expiresInSec });
    return json.access_token;
  }

  /**
   * Executes a GraphQL operation and returns the typed data plus query cost.
   * Throws {@link ShopifyError} with an actionable message on failure.
   */
  async request<T>(query: string, variables?: Record<string, unknown>): Promise<GraphQLResponse<T>> {
    return this.execute<T>(query, variables, { rateLimitRetried: false, authRetried: false });
  }

  private async execute<T>(
    query: string,
    variables: Record<string, unknown> | undefined,
    attempt: Attempt,
  ): Promise<GraphQLResponse<T>> {
    const token = await this.getAccessToken();

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
          Accept: "application/json",
        },
        body: JSON.stringify({ query, variables: variables ?? {} }),
      });
    } catch (err) {
      throw new ShopifyError(
        `Network error contacting Shopify: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // HTTP 429: respect Retry-After, retry once.
    if (response.status === 429) {
      if (!attempt.rateLimitRetried) {
        const retryAfter = Number.parseFloat(response.headers.get("Retry-After") ?? "2");
        const waitMs = Number.isFinite(retryAfter) ? Math.max(retryAfter, 1) * 1000 : 2000;
        log.warn("shopify_rate_limited", { retry_after_ms: waitMs });
        await sleep(waitMs);
        return this.execute<T>(query, variables, { ...attempt, rateLimitRetried: true });
      }
      throw new ShopifyError(
        "Shopify rate limit (HTTP 429) persisted after one retry. Try again shortly or reduce page size.",
        "RATE_LIMITED",
      );
    }

    if (response.status === 401 || response.status === 403) {
      // In client-credentials mode a 401 usually means the cached token expired
      // (e.g. rotated early). Force a refresh and retry once.
      if (this.config.authMode === "client_credentials" && !attempt.authRetried) {
        log.warn("shopify_token_expired_refreshing");
        await this.getAccessToken(/* forceRefresh */ true);
        return this.execute<T>(query, variables, { ...attempt, authRetried: true });
      }
      const hint =
        this.config.authMode === "client_credentials"
          ? "Check SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET and that the app is installed on the store."
          : "Check that SHOPIFY_ACCESS_TOKEN is valid and that the app is installed on the store.";
      throw new ShopifyError(
        `Shopify rejected the request (HTTP ${response.status}). ${hint}`,
        "UNAUTHENTICATED",
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ShopifyError(
        `Shopify returned HTTP ${response.status}. ${body.slice(0, 500)}`.trim(),
      );
    }

    let body: RawGraphQLBody<T>;
    try {
      body = (await response.json()) as RawGraphQLBody<T>;
    } catch {
      throw new ShopifyError("Shopify returned a non-JSON response.");
    }

    const cost = body.extensions?.cost?.actualQueryCost;

    if (body.errors && body.errors.length > 0) {
      // THROTTLED cost error: back off and retry once.
      const throttled = body.errors.find((e) => e.extensions?.code === "THROTTLED");
      if (throttled && !attempt.rateLimitRetried) {
        const available = body.extensions?.cost?.throttleStatus?.currentlyAvailable ?? 0;
        const restoreRate = body.extensions?.cost?.throttleStatus?.restoreRate ?? 50;
        const requested = body.extensions?.cost?.requestedQueryCost ?? 0;
        const deficit = Math.max(requested - available, 0);
        const waitMs = Math.min(Math.max((deficit / Math.max(restoreRate, 1)) * 1000, 1000), 10000);
        log.warn("shopify_throttled", { wait_ms: waitMs });
        await sleep(waitMs);
        return this.execute<T>(query, variables, { ...attempt, rateLimitRetried: true });
      }

      throw this.toActionableError(body.errors);
    }

    if (body.data === undefined) {
      throw new ShopifyError("Shopify returned no data and no errors.");
    }

    return { data: body.data, cost };
  }

  private toActionableError(errors: RawGraphQLError[]): ShopifyError {
    const first = errors[0]!;
    const code = first.extensions?.code;

    if (code === "ACCESS_DENIED") {
      const scope = first.extensions?.requiredAccess;
      const scopeHint = scope
        ? ` The app is missing the "${scope}" access scope — add it in the custom app's Admin API scopes and reinstall.`
        : " The app is missing a required access scope — review the app's Admin API scopes and reinstall.";
      return new ShopifyError(`Access denied: ${first.message}.${scopeHint}`, code);
    }

    const combined = errors.map((e) => e.message).join("; ");
    return new ShopifyError(`Shopify GraphQL error: ${combined}`, code);
  }
}

/**
 * Extracts and throws on Shopify `userErrors` returned by mutations.
 * userError messages are surfaced verbatim as required by the spec.
 */
export function assertNoUserErrors(
  userErrors: Array<{ field?: string[] | null; message: string }> | undefined | null,
): void {
  if (userErrors && userErrors.length > 0) {
    const rendered = userErrors
      .map((e) => (e.field && e.field.length ? `${e.field.join(".")}: ${e.message}` : e.message))
      .join("; ");
    throw new ShopifyError(`Shopify rejected the operation: ${rendered}`, "USER_ERROR");
  }
}
