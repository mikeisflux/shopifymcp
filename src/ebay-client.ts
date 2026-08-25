/**
 * eBay REST client (Sell/Buy/Commerce APIs).
 *
 * - Mints an OAuth token via the refresh-token grant (User token, for Sell APIs)
 *   when EBAY_REFRESH_TOKEN is set, otherwise the client-credentials grant
 *   (Application token). Token is cached and refreshed before expiry.
 * - Makes REST calls to https://api.ebay.com (or sandbox) with a Bearer token.
 * - Retries once on 401 (force token refresh) and 429 (rate limit), and surfaces
 *   eBay's JSON error array as an actionable message.
 *
 * Token endpoint + flows per eBay's OAuth docs:
 *   POST {base}/identity/v1/oauth2/token
 *   Authorization: Basic base64(clientId:clientSecret)
 *   grant_type=refresh_token&refresh_token=…&scope=…   (user token)
 *   grant_type=client_credentials&scope=…              (app token)
 */

import type { Config } from "./config.js";
import { log } from "./logger.js";

export class EbayError extends Error {
  readonly status: number | undefined;
  readonly errorId: number | undefined;
  constructor(message: string, status?: number, errorId?: number) {
    super(message);
    this.name = "EbayError";
    this.status = status;
    this.errorId = errorId;
  }
}

export interface EbayResponse {
  status: number;
  data: unknown;
  /** Location header (set by POST creates like createTask). */
  location: string | null;
}

interface EbayApiError {
  errorId?: number;
  domain?: string;
  category?: string;
  message?: string;
  longMessage?: string;
  parameters?: Array<{ name?: string; value?: string }>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const TOKEN_SKEW_MS = 5 * 60 * 1000;

export class EbayClient {
  private readonly config: Config;
  readonly apiBase: string;
  private readonly tokenEndpoint: string;
  /** OAuth sign-in host (auth.ebay.com / auth.sandbox.ebay.com) for the authorize URL. */
  private readonly signinBase: string;

  private cachedToken: string | undefined;
  private tokenExpiresAtMs = 0;
  private inflight: Promise<string> | undefined;

  constructor(config: Config) {
    this.config = config;
    const host = config.ebayEnv === "sandbox" ? "api.sandbox.ebay.com" : "api.ebay.com";
    this.apiBase = `https://${host}`;
    this.tokenEndpoint = `https://${host}/identity/v1/oauth2/token`;
    this.signinBase = config.ebayEnv === "sandbox" ? "https://auth.sandbox.ebay.com" : "https://auth.ebay.com";
  }

  /**
   * Builds the OAuth authorization-code URL a user visits to grant consent.
   * `redirectUri` is the RuName; after consent eBay redirects to the RuName's
   * configured accepted URL with `?code=…`.
   */
  buildAuthorizeUrl(redirectUri: string, scopes: string): string {
    // Build the query manually so spaces in `scope` are %20-encoded (eBay's
    // authorize endpoint rejects the `+` that URLSearchParams would emit) and no
    // unsupported params (e.g. prompt) are added.
    const params = [
      `client_id=${encodeURIComponent(this.config.ebayClientId ?? "")}`,
      `response_type=code`,
      `redirect_uri=${encodeURIComponent(redirectUri)}`,
      `scope=${encodeURIComponent(scopes)}`,
    ];
    return `${this.signinBase}/oauth2/authorize?${params.join("&")}`;
  }

  /**
   * Exchanges an authorization code (from the consent redirect) for tokens.
   * The response includes the long-lived `refresh_token` we actually want.
   * `redirectUri` must be the same RuName used in the authorize URL.
   */
  async exchangeAuthCode(
    code: string,
    redirectUri: string,
  ): Promise<{ access_token: string; refresh_token?: string; refresh_token_expires_in?: number; expires_in?: number; token_type?: string }> {
    const basic = Buffer.from(`${this.config.ebayClientId}:${this.config.ebayClientSecret}`).toString("base64");
    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("code", code);
    body.set("redirect_uri", redirectUri);

    let res: Response;
    try {
      res = await fetch(this.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}`, Accept: "application/json" },
        body: body.toString(),
      });
    } catch (err) {
      throw new EbayError(`Network error exchanging eBay auth code: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      let hint = "";
      if (/invalid_grant/i.test(text)) hint = " The authorization code is invalid, already used, or expired (codes last ~5 min) — start the flow again at /ebay/oauth/start.";
      else if (/invalid_client/i.test(text)) hint = " Check EBAY_CLIENT_ID / EBAY_CLIENT_SECRET.";
      else if (/redirect_uri/i.test(text)) hint = " The redirect_uri must equal the RuName (EBAY_OAUTH_RUNAME) used to start the flow.";
      throw new EbayError(`eBay auth-code exchange failed (HTTP ${res.status}).${hint} ${text.slice(0, 300)}`.trim(), res.status);
    }
    return (text ? JSON.parse(text) : {}) as { access_token: string; refresh_token?: string; refresh_token_expires_in?: number; expires_in?: number; token_type?: string };
  }

  /** The grant flow in use, for diagnostics. */
  get grantType(): "refresh_token" | "client_credentials" {
    return this.config.ebayRefreshToken ? "refresh_token" : "client_credentials";
  }

  private async getToken(forceRefresh = false): Promise<string> {
    const now = Date.now();
    if (!forceRefresh && this.cachedToken && now < this.tokenExpiresAtMs - TOKEN_SKEW_MS) {
      return this.cachedToken;
    }
    if (!this.inflight) {
      this.inflight = this.mintToken().finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  private async mintToken(): Promise<string> {
    const basic = Buffer.from(`${this.config.ebayClientId}:${this.config.ebayClientSecret}`).toString("base64");
    const body = new URLSearchParams();
    if (this.config.ebayRefreshToken) {
      body.set("grant_type", "refresh_token");
      body.set("refresh_token", this.config.ebayRefreshToken);
      if (this.config.ebayScopes) body.set("scope", this.config.ebayScopes);
    } else {
      body.set("grant_type", "client_credentials");
      if (this.config.ebayScopes) body.set("scope", this.config.ebayScopes);
    }

    let res: Response;
    try {
      res = await fetch(this.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}`, Accept: "application/json" },
        body: body.toString(),
      });
    } catch (err) {
      throw new EbayError(`Network error fetching eBay token: ${err instanceof Error ? err.message : String(err)}`);
    }

    const text = await res.text().catch(() => "");
    if (!res.ok) {
      let hint = "";
      if (/invalid_grant/i.test(text)) hint = " The refresh token is invalid/expired/revoked — re-run eBay consent to get a new one.";
      else if (/invalid_client/i.test(text)) hint = " Check EBAY_CLIENT_ID / EBAY_CLIENT_SECRET.";
      else if (/invalid_scope/i.test(text)) hint = " A requested scope isn't granted to the app or the refresh token.";
      throw new EbayError(`eBay token request failed (HTTP ${res.status}).${hint} ${text.slice(0, 300)}`.trim(), res.status);
    }
    const json = (text ? JSON.parse(text) : {}) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new EbayError("eBay token endpoint returned no access_token.");
    const expiresInSec = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 7200;
    this.cachedToken = json.access_token;
    this.tokenExpiresAtMs = Date.now() + expiresInSec * 1000;
    log.info("ebay_token_minted", { grant: this.grantType, expires_in_s: expiresInSec });
    return json.access_token;
  }

  /**
   * Makes a REST call. `path` is the part after the host, e.g.
   * "/sell/inventory/v1/inventory_item/ABC". `query` and `body` are optional.
   */
  async request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown; marketplaceId?: string; contentLanguage?: string } = {},
    retry = { auth: false, rate: false },
  ): Promise<EbayResponse> {
    const token = await this.getToken();
    const url = new URL(this.apiBase + (path.startsWith("/") ? path : `/${path}`));
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

    const lang = opts.contentLanguage ?? "en-US";
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      // eBay's Sell Inventory endpoints require a valid Accept-Language; omitting
      // it yields HTTP 400 error 25709 ("Invalid value for header Accept-Language").
      "Accept-Language": lang,
      "X-EBAY-C-MARKETPLACE-ID": opts.marketplaceId ?? this.config.ebayMarketplaceId,
    };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Language"] = lang;
    }

    let res: Response;
    try {
      res = await fetch(url.toString(), { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
    } catch (err) {
      throw new EbayError(`Network error contacting eBay: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (res.status === 401 && !retry.auth) {
      log.warn("ebay_token_expired_refreshing");
      await this.getToken(true);
      return this.request(method, path, opts, { ...retry, auth: true });
    }
    if (res.status === 429 && !retry.rate) {
      log.warn("ebay_rate_limited");
      await sleep(2000);
      return this.request(method, path, opts, { ...retry, rate: true });
    }

    const location = res.headers.get("Location");
    const raw = await res.text().catch(() => "");
    let data: unknown = undefined;
    if (raw) {
      try { data = JSON.parse(raw); } catch { data = raw; }
    }

    if (!res.ok) {
      const errors = (data as { errors?: EbayApiError[] } | undefined)?.errors;
      if (errors && errors.length) {
        const first = errors[0]!;
        const rendered = errors.map((e) => `${e.message ?? ""}${e.longMessage && e.longMessage !== e.message ? ` (${e.longMessage})` : ""}${e.errorId ? ` [${e.errorId}]` : ""}`).join("; ");
        throw new EbayError(`eBay ${method} ${path} failed (HTTP ${res.status}): ${rendered}`, res.status, first.errorId);
      }
      throw new EbayError(`eBay ${method} ${path} failed (HTTP ${res.status}). ${typeof data === "string" ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300)}`.trim(), res.status);
    }

    return { status: res.status, data, location };
  }
}
