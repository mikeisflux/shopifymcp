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

export class ShopifyClient {
  private readonly endpoint: string;
  private readonly token: string;

  constructor(config: Config) {
    this.endpoint = `https://${config.shopifyStoreDomain}/admin/api/${config.shopifyApiVersion}/graphql.json`;
    this.token = config.shopifyAccessToken;
  }

  /**
   * Executes a GraphQL operation and returns the typed data plus query cost.
   * Throws {@link ShopifyError} with an actionable message on failure.
   */
  async request<T>(query: string, variables?: Record<string, unknown>): Promise<GraphQLResponse<T>> {
    return this.execute<T>(query, variables, /* isRetry */ false);
  }

  private async execute<T>(
    query: string,
    variables: Record<string, unknown> | undefined,
    isRetry: boolean,
  ): Promise<GraphQLResponse<T>> {
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": this.token,
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
      if (!isRetry) {
        const retryAfter = Number.parseFloat(response.headers.get("Retry-After") ?? "2");
        const waitMs = Number.isFinite(retryAfter) ? Math.max(retryAfter, 1) * 1000 : 2000;
        log.warn("shopify_rate_limited", { retry_after_ms: waitMs });
        await sleep(waitMs);
        return this.execute<T>(query, variables, true);
      }
      throw new ShopifyError(
        "Shopify rate limit (HTTP 429) persisted after one retry. Try again shortly or reduce page size.",
        "RATE_LIMITED",
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new ShopifyError(
        `Shopify rejected the request (HTTP ${response.status}). Check that SHOPIFY_ACCESS_TOKEN is valid ` +
          `and that the app is installed on the store.`,
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
      if (throttled && !isRetry) {
        const available = body.extensions?.cost?.throttleStatus?.currentlyAvailable ?? 0;
        const restoreRate = body.extensions?.cost?.throttleStatus?.restoreRate ?? 50;
        const requested = body.extensions?.cost?.requestedQueryCost ?? 0;
        const deficit = Math.max(requested - available, 0);
        const waitMs = Math.min(Math.max((deficit / Math.max(restoreRate, 1)) * 1000, 1000), 10000);
        log.warn("shopify_throttled", { wait_ms: waitMs });
        await sleep(waitMs);
        return this.execute<T>(query, variables, true);
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
