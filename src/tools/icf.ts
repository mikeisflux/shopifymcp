/**
 * IndieCrowdfund Agent API tools for the NAS MCP server.
 *
 * A thin client over one authenticated HTTPS API (https://indiecrowdfund.com
 * /api/agent/v1). Tools are registered dynamically from the platform's own tool
 * catalog, so new IndieCrowdfund tools appear here after a restart with no code
 * change. The whole family is prefixed `icf_` to sort together and never collide
 * with the Shopify / eBay tool names.
 *
 * Design notes:
 *   • This server uses the high-level McpServer.registerTool, which wants Zod
 *     shapes, so the catalog's draft-07 JSON Schemas are converted to Zod here.
 *   • `confirm` (the write guard) is deliberately registered as an OPTIONAL
 *     boolean, never a required literal. The IndieCrowdfund server enforces the
 *     guard itself and returns a readable `confirmation_required` error, which
 *     we surface to the model — exactly the reference behaviour. We NEVER add
 *     `confirm` on the model's behalf; the model must send it after the user
 *     approves the change.
 *   • Errors come back as MCP isError results (text the model can read and
 *     self-correct on), not thrown exceptions.
 *   • Results are never cached (everything is live data).
 */

import { z, type ZodTypeAny, type ZodRawShape } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { log, logToolCall } from "../logger.js";
import { textContent } from "../format.js";
import { ICF_FALLBACK_CATALOG, type IcfCatalogEntry } from "../icf-catalog.js";

const PREFIX = "icf_";
const MUTATING_NOTE =
  "\n\nTHIS CHANGES DATA. Ask the user to approve the exact change first, then call with confirm: true.";
/** Tools that can run for minutes server-side get a 300s client timeout; others 60s. */
const LONG_TOOLS = new Set(["run_ai_service", "send_email_campaign"]);
const CATALOG_PATH = "/api/agent/v1/tools";
const IDENTITY_PATH = "/api/agent/v1";
const TOOL_PATH = "/api/agent/v1/tools/";

interface PreparedTool {
  toolName: string; // icf_<name>
  baseName: string; // <name> (what the API expects)
  description: string;
  shape: ZodRawShape;
  timeoutMs: number;
}

/** Module-level cache: seeded synchronously, refreshed from the live catalog. */
let prepared: PreparedTool[] = [];
let lastSource: "live" | "bundled" | "none" = "none";

// ─── JSON Schema (draft-07 subset) → Zod ──────────────────────────────────────
// Covers exactly the constructs the catalog uses: string/integer/number/boolean/
// array/object, enum, const, min/max, minLength/maxLength, minItems/maxItems,
// default, required, and open objects (propertyNames + additionalProperties).

function nodeToZod(node: Record<string, unknown>): ZodTypeAny {
  const type = typeof node.type === "string" ? node.type : undefined;
  const enumVals = Array.isArray(node.enum) ? (node.enum as unknown[]) : undefined;
  let zt: ZodTypeAny;

  if (node.const !== undefined) {
    zt = z.literal(node.const as string | number | boolean);
  } else if (type === "string" && enumVals && enumVals.length > 0) {
    zt = z.enum(enumVals as [string, ...string[]]);
  } else if (type === "string") {
    let s = z.string();
    if (typeof node.minLength === "number") s = s.min(node.minLength);
    if (typeof node.maxLength === "number") s = s.max(node.maxLength);
    zt = s;
  } else if (type === "integer" || type === "number") {
    let n = z.number();
    if (type === "integer") n = n.int();
    if (typeof node.minimum === "number") n = n.min(node.minimum);
    if (typeof node.maximum === "number") n = n.max(node.maximum);
    if (typeof node.exclusiveMinimum === "number") n = n.gt(node.exclusiveMinimum);
    zt = n;
  } else if (type === "boolean") {
    zt = z.boolean();
  } else if (type === "array") {
    const items = (node.items && typeof node.items === "object" ? node.items : {}) as Record<string, unknown>;
    let arr = z.array(nodeToZod(items));
    if (typeof node.minItems === "number") arr = arr.min(node.minItems);
    if (typeof node.maxItems === "number") arr = arr.max(node.maxItems);
    zt = arr;
  } else if (type === "object") {
    const props = node.properties as Record<string, unknown> | undefined;
    if (props && Object.keys(props).length > 0) {
      zt = z.object(objectShape(node));
    } else {
      // Open object (e.g. run_ai_service.params): arbitrary string-keyed values.
      zt = z.record(z.string(), z.unknown());
    }
  } else {
    zt = z.unknown();
  }

  if (typeof node.description === "string") zt = zt.describe(node.description);
  return zt;
}

/** Builds the Zod raw shape for an object schema's `properties`. */
function objectShape(schema: Record<string, unknown>): ZodRawShape {
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const shape: ZodRawShape = {};

  for (const [key, node] of Object.entries(props)) {
    // The write guard is enforced server-side (confirmation_required), never
    // client-side, so the server's readable error reaches the model. Always an
    // optional boolean here — we never require or inject it.
    if (key === "confirm") {
      const desc =
        typeof node.description === "string"
          ? node.description
          : "Must be true. Send only after the user has approved the change.";
      shape[key] = z.boolean().optional().describe(desc);
      continue;
    }

    let zt = nodeToZod(node);
    if (node.default !== undefined) {
      zt = zt.default(node.default);
    } else if (!required.has(key)) {
      zt = zt.optional();
    }
    shape[key] = zt;
  }

  return shape;
}

/** Converts a catalog into registerable tool descriptors. Bad entries are skipped. */
function prepare(catalog: IcfCatalogEntry[]): PreparedTool[] {
  const out: PreparedTool[] = [];
  for (const entry of catalog) {
    try {
      const shape = objectShape(entry.inputSchema ?? {});
      out.push({
        toolName: PREFIX + entry.name,
        baseName: entry.name,
        description: entry.mutating ? entry.description + MUTATING_NOTE : entry.description,
        shape,
        timeoutMs: LONG_TOOLS.has(entry.name) ? 300_000 : 60_000,
      });
    } catch (err) {
      log.warn("icf_tool_prepare_failed", {
        tool: entry.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

// ─── HTTP dispatch ────────────────────────────────────────────────────────────

interface IcfResponse {
  ok?: boolean;
  tool?: string;
  result?: unknown;
  error?: { code?: string; message?: string; details?: Array<{ path?: string; message?: string }> };
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: true };

function headers(config: Config): Record<string, string> {
  return {
    "X-API-Key": config.icfApiKey!,
    "X-API-Secret": config.icfApiSecret!,
    "Content-Type": "application/json",
  };
}

/** POSTs one tool call and maps the response to MCP content (errors → isError). */
async function callIcf(config: Config, baseName: string, args: unknown, timeoutMs: number): Promise<ToolResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.icfApiUrl}${TOOL_PATH}${encodeURIComponent(baseName)}`, {
      method: "POST",
      headers: headers(config),
      body: JSON.stringify(args ?? {}),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => undefined)) as IcfResponse | undefined;

    if (!res.ok || !body || body.ok === false) {
      const err = body?.error ?? { code: `http_${res.status}`, message: res.statusText || "request failed" };
      const details =
        Array.isArray(err.details) && err.details.length
          ? "\n" + err.details.map((d) => `- ${d.path ?? ""}: ${d.message ?? ""}`).join("\n")
          : "";
      return {
        content: [textContent(`IndieCrowdfund ${err.code ?? "error"}: ${err.message ?? "request failed"}${details}`)],
        isError: true,
      };
    }

    // CSV results come back as a string field (format: "csv"); hand it over verbatim.
    const result = body.result;
    const resObj = result && typeof result === "object" ? (result as Record<string, unknown>) : undefined;
    const text =
      resObj && typeof resObj.csv === "string"
        ? `total=${resObj.total ?? ""}\n${resObj.csv}`
        : JSON.stringify(result ?? {}, null, 2);
    return { content: [textContent(text)] };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    const msg = aborted
      ? `request timed out after ${Math.round(timeoutMs / 1000)}s`
      : e instanceof Error
        ? e.message
        : String(e);
    return { content: [textContent(`IndieCrowdfund request_failed: ${msg}`)], isError: true };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Catalog loading + startup check ──────────────────────────────────────────

/** Fetches the live catalog and, on success, replaces the cached tool set. */
async function refreshCatalog(config: Config): Promise<void> {
  try {
    const res = await fetch(`${config.icfApiUrl}${CATALOG_PATH}`, {
      headers: headers(config),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`catalog fetch returned ${res.status}`);
    const data = (await res.json()) as { tools?: IcfCatalogEntry[] };
    if (!Array.isArray(data.tools) || data.tools.length === 0) throw new Error("catalog had no tools");
    prepared = prepare(data.tools);
    lastSource = "live";
    log.info("icf_catalog_loaded", { source: "live", count: prepared.length });
  } catch (err) {
    log.warn("icf_catalog_refresh_failed", {
      error: err instanceof Error ? err.message : String(err),
      keeping: lastSource,
      tools: prepared.length,
    });
  }
}

/** Identity check: logs the key name, scopes and advertised tool count. */
async function startupCheck(config: Config): Promise<void> {
  try {
    const res = await fetch(`${config.icfApiUrl}${IDENTITY_PATH}`, {
      headers: headers(config),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => undefined)) as
      | { key?: { name?: string; scopes?: string[] }; tools?: number }
      | undefined;
    if (!res.ok) {
      log.warn("icf_identity_check_failed", {
        status: res.status,
        hint: res.status === 401 ? "bad/revoked ICF_API_KEY or ICF_API_SECRET" : undefined,
      });
      return;
    }
    log.info("icf_identity", { key: body?.key?.name, scopes: body?.key?.scopes, tools: body?.tools });
  } catch (err) {
    log.warn("icf_identity_check_failed", { error: err instanceof Error ? err.message : String(err) });
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** True when both ICF credentials are configured (gates registration). */
export function icfConfigured(config: Config): boolean {
  return Boolean(config.icfApiKey && config.icfApiSecret);
}

/**
 * Seeds the tool cache synchronously from the bundled catalog so the icf_ tools
 * are available on the first request, then refreshes from the live catalog and
 * runs the identity check in the background. No-op when ICF is not configured.
 */
export function initIcf(config: Config): void {
  if (!icfConfigured(config)) return;
  prepared = prepare(ICF_FALLBACK_CATALOG);
  lastSource = "bundled";
  log.info("icf_tools_seeded", { source: "bundled", count: prepared.length });
  void refreshCatalog(config);
  void startupCheck(config);
}

/** Registers every cached icf_ tool on a fresh per-request server. */
export function registerIcfTools(server: McpServer, config: Config): void {
  for (const t of prepared) {
    server.registerTool(
      t.toolName,
      { description: t.description, inputSchema: t.shape },
      (async (args: unknown) => {
        const start = Date.now();
        const out = await callIcf(config, t.baseName, args, t.timeoutMs);
        logToolCall({ tool: t.toolName, durationMs: Date.now() - start, success: out.isError !== true });
        return out;
      }) as never,
    );
  }
}
