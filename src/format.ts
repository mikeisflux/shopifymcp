/**
 * Formatting helpers: Shopify GID <-> numeric ID conversion, Markdown
 * table/section builders, and list truncation.
 *
 * Tool responses return Markdown text (for humans) plus structuredContent
 * (raw shaped data for programmatic use).
 */

/** Maximum items rendered in a Markdown list before truncation kicks in. */
export const DEFAULT_RENDER_LIMIT = 100;

/**
 * Converts a Shopify GID (`gid://shopify/Product/123`) to its numeric id
 * (`123`). Returns the input unchanged if it is not a GID.
 */
export function gidToId(gid: string | null | undefined): string {
  if (!gid) return "";
  const match = /^gid:\/\/shopify\/[A-Za-z0-9_]+\/(\d+)/.exec(gid);
  return match ? match[1]! : gid;
}

/**
 * Converts a numeric id (or a full GID) to a Shopify GID for the given
 * resource type. Accepts either form as input so callers can be lenient.
 *
 * @param resource e.g. "Product", "Order", "Customer", "ProductVariant"
 */
export function toGid(resource: string, idOrGid: string | number): string {
  const value = String(idOrGid).trim();
  if (value.startsWith("gid://shopify/")) return value;
  return `gid://shopify/${resource}/${value}`;
}

/** Recursively rewrites any string `id` GID fields to numeric ids for output. */
export function stripGids<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripGids(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (typeof val === "string" && val.startsWith("gid://shopify/")) {
        out[key] = gidToId(val);
      } else {
        out[key] = stripGids(val);
      }
    }
    return out as T;
  }
  return value;
}

/** Escapes pipe/newline characters so a value is safe inside a Markdown cell. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

/**
 * Renders a Markdown table. Rows longer than `limit` are truncated with a
 * trailing note so the agent knows the list was cut.
 */
export function markdownTable(
  headers: string[],
  rows: Array<Array<unknown>>,
  limit: number = DEFAULT_RENDER_LIMIT,
): string {
  const shown = rows.slice(0, limit);
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = shown
    .map((row) => `| ${row.map((c) => cell(c)).join(" | ")} |`)
    .join("\n");
  let table = [head, sep, body].filter(Boolean).join("\n");
  if (rows.length > limit) {
    table += `\n\n_Showing ${limit} of ${rows.length} rows (truncated)._`;
  }
  return table;
}

/** Renders `key: value` detail lines, skipping empty values. */
export function detailLines(pairs: Array<[string, unknown]>): string {
  return pairs
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `- **${k}:** ${cell(v)}`)
    .join("\n");
}

/** Standard money formatter given a `{ amount, currencyCode }` shape. */
export function money(m: { amount?: string; currencyCode?: string } | null | undefined): string {
  if (!m || m.amount === undefined) return "";
  return m.currencyCode ? `${m.amount} ${m.currencyCode}` : m.amount;
}

/** Builds a Markdown text-content block for a tool result. */
export function textContent(markdown: string): { type: "text"; text: string } {
  return { type: "text", text: markdown };
}
