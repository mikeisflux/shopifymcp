/**
 * Environment configuration + startup validation.
 * Exits the process with a clear message if a required var is missing.
 */

export interface Config {
  shopifyStoreDomain: string;
  shopifyAccessToken: string;
  shopifyApiVersion: string;
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

/**
 * Reads and validates configuration from process.env.
 * Throws with an aggregated message listing every problem found.
 */
export function loadConfig(): Config {
  const errors: string[] = [];

  const shopifyStoreDomain = required("SHOPIFY_STORE_DOMAIN", errors);
  const shopifyAccessToken = required("SHOPIFY_ACCESS_TOKEN", errors);
  const shopifyApiVersion = required("SHOPIFY_API_VERSION", errors);
  const mcpPathSecret = required("MCP_PATH_SECRET", errors);

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
    shopifyAccessToken,
    shopifyApiVersion,
    mcpPathSecret,
    mcpAuthToken,
    enableWrites,
    port,
    logLevel,
  };
}
