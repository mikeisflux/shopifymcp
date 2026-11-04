# IndieCrowdfund Agent API — MCP integration spec

This document is the hand-off for the MCP server that runs on the NAS next to the
Shopify/eBay one. It describes the HTTP API IndieCrowdfund exposes for agents and
exactly how to wrap it as MCP tools, so the IndieCrowdfund tools can live in the same
server process and show up in Claude alongside the `shopify_*` and `ebay_*` tools.

Nothing in the MCP server needs database access, SSH, or any knowledge of the
IndieCrowdfund codebase. It is a thin client over one authenticated HTTPS API.

```
Claude ──MCP──▶ NAS MCP server ──HTTPS + API key──▶ https://indiecrowdfund.com/api/agent/v1/...
                 (shopify_* tools)                   (tool registry inside the Next.js app)
                 (ebay_* tools)
                 (icf_* tools)   ◀── this spec
```

## 1. Credentials

Issue a key at **Admin → System → Agent API** (`/admin/agent-api`, SUPER_ADMIN only).
It produces two values, shown once:

| Env var | Example | Purpose |
|---|---|---|
| `ICF_API_URL` | `https://indiecrowdfund.com` | Base URL. No trailing slash. |
| `ICF_API_KEY` | `ick_live_…` | Public identifier. |
| `ICF_API_SECRET` | `icsk_live_…` | Proves possession. Only its hash is stored server-side. |

Send both on every request, in headers (never in the URL):

```
X-API-Key: <ICF_API_KEY>
X-API-Secret: <ICF_API_SECRET>
```

`Authorization: Bearer <key>:<secret>` is accepted as an alternative.

**Scopes.** A key has `agent:read` (every reporting/lookup tool) and optionally
`agent:write` (the four guarded mutations). Write implies read. The admin page
shows which a key has. If the MCP server gets a `403 insufficient_scope`, the key
was issued read-only.

**Rotation.** Revoke in the admin page, issue a new one, update the env, restart
the MCP server. Revoked keys return `401` immediately. Their call history is kept.

## 2. Endpoints

All responses are JSON. All timestamps are ISO 8601 UTC. Money is a plain number
of dollars (`93.00` → `93`), never cents.

### `GET /api/agent/v1` — identity check

Use this on startup to fail fast on bad credentials.

```json
{ "ok": true, "version": "1.0", "key": { "name": "NAS MCP server", "scopes": ["agent:read"] }, "tools": 42, "catalog": "/api/agent/v1/tools" }
```

### `GET /api/agent/v1/tools` — tool catalog

```json
{
  "version": "1.0",
  "tools": [
    {
      "name": "list_projects",
      "description": "List campaigns with live funding stats. …",
      "scope": "agent:read",
      "mutating": false,
      "inputSchema": { "type": "object", "properties": { … }, "required": [ … ], "additionalProperties": false }
    }
  ]
}
```

`inputSchema` is JSON Schema (draft-07) generated from the server's own validation
schema, so it is always exactly what the server will accept. Fields with a
`default` are optional; the server fills them in. **This endpoint is the source of
truth.** Fetch it at startup and register one MCP tool per entry; tools added to
IndieCrowdfund later appear without a code change on the NAS.

### `POST /api/agent/v1/tools/{name}` — run a tool

Body: a JSON object of the tool's arguments (or empty for tools with none).
`Content-Type: application/json`.

Success:

```json
{ "ok": true, "tool": "get_project", "result": { … } }
```

Failure:

```json
{ "ok": false, "tool": "get_project", "error": { "code": "not_found", "message": "No project matches \"the-ghost-dnace\"." } }
```

| HTTP | `error.code` | Meaning |
|---|---|---|
| 400 | `invalid_json` | Body wasn't a JSON object. |
| 400 | `invalid_arguments` | Schema validation failed. `error.details` is `[{ path, message }]`. |
| 400 | `confirmation_required` | A mutating tool was called without `confirm: true`. |
| 400 | *(tool-specific)* | The tool refused, e.g. extending a CANCELLED campaign. The message is safe to show the user. |
| 401 | `unauthorized` | Bad or revoked credentials. |
| 403 | `insufficient_scope` | Tool needs `agent:write`; key only has `agent:read`. |
| 404 | `unknown_tool` / `not_found` | No such tool, or the project/user wasn't found. |
| 429 | `rate_limited` | Over 120 calls/minute for this key. Back off until `X-RateLimit-Reset` (unix seconds). |
| 500 | `tool_error` | Server-side failure; already logged in Sentinel. Retry once, then surface. |

Mutating tools also return their own codes in the 400 range (`already_sent`,
`sending`, `conflict`, `no_content` from `send_email_campaign`, for example).
The message is always written to be shown to the user as-is.

Every call, successful or not, is written to the Agent API call log that admins
see in `/admin/agent-api`: key, tool, arguments (anything named like a secret is
redacted), outcome, duration, and response size.

**Timeouts.** Most tools return within a few seconds; `project_backers` with
`limit: 1000`, `search_logs` and `smart_segments` can take ~10 s. `run_ai_service`
with `runAutomation`, and `send_email_campaign` to a large audience, can run for
minutes: the server allows 300 s. Use a 300 s client timeout for those two and
60 s for everything else.

## 3. The tools

Prefix every tool `icf_` on the MCP side (`icf_list_projects`) so they sort
together and cannot collide with Shopify/eBay names.

`*` = required. Everything else has the default shown or is optional.

### Reading campaigns

| Tool | Arguments | Returns |
|---|---|---|
| `platform_overview` | — | Campaign counts by status, raised/pledges/backers all-time and last 30 days, new accounts, top categories. |
| `list_projects` | `status` (array of DRAFT/SUBMITTED/APPROVED/LIVE/PAUSED/FUNDED/FAILED/CANCELLED; default LIVE+FUNDED), `category`, `creatorEmail`, `search`, `sort` (newest/ending_soon/most_funded/most_backed/recently_updated), `limit`=25 (≤100), `offset` | `{ total, projects: [{ slug, title, url, status, goal, raised, fundedPercent, backers, endDate, creator… }] }` |
| `get_project` | `project*` (slug or id), `timelineDays`=60 | Full detail: funding, dates, creator, `rewards[]` and `addons[]` with claimed/remaining, `pledgesByStatus`, `timeline[]` of daily pledges. |
| `project_backers` | `project*`, `status`=["COMPLETED"], `includeAddress`=false, `format`=json/csv, `limit`=100 (≤1000), `offset` | Per backer: name, email, amount, reward, add-ons, shipping paid, country, survey/fulfillment state. `csv` returns `{ total, csv }`. |
| `campaign_performance` | `from`, `to` (default last 30 days), `limit`=50 | Per campaign in the window: raised, pledges, unique backers, average pledge, refunds. |
| `category_breakdown` | `from`, `to` (default 90 days) | Per category: campaigns launched, raised, pledges. |
| `project_updates` | `project*`, `limit`=20 | The creator's posted updates with likes/comments. |

### People

| Tool | Arguments | Returns |
|---|---|---|
| `find_user` | `email` **or** `search`, `limit`=10 | Accounts with role, join date, pledge count/total/last, campaigns created, unsubscribed flag. |
| `user_pledges` | `email*`, `limit`=50 | Every pledge by that backer with campaign, status, reward, add-ons, fulfillment. |
| `backer_segments` | `segment*` (lapsed / repeat / top_spenders / category_fans / project_backers / creator_backers / new_backers), `days`=90, `minPledges`=2, `category`, `project`, `creatorEmail`, `includeUnsubscribed`=false, `format`=json/csv, `limit`=200 (≤2000), `offset` | Outreach list: email, name, pledges, total, first/last pledge, categories. Excludes unsubscribed and deleted accounts by default. |
| `creator_pipeline` | `stage*` (drafts / submitted / approved_not_launched / live / ended / never_created), `inactiveDays`=0, `limit`=50, `offset` | Creators with a campaign at that stage, with last-touched date. |

### Email and outreach

| Tool | Arguments | Returns |
|---|---|---|
| `email_engagement` | `from`, `to`, `groupBy`=domain/type/day, `minSent`=20, `limit`=25 | Sent/opened/clicked by group. Opens are only tracked on marketing mail. |
| `user_email_history` | `email*`, `limit`=20 | What we sent one person: log with opens, Sent-folder copies with the provider's delivered/bounced verdict, blocklist and unsubscribe state. |
| `email_deliverability` | `email*` | `{ reachable, blocklisted, unsubscribedSiteWide, newsletterActive, lastSend }`. |
| `email_campaigns` | `status` (array), `limit`=20 | Marketing campaigns with send/open/click/bounce stats. |
| `newsletter_stats` | — | List size, growth, by source, top tags. |

### Operations

| Tool | Arguments | Returns |
|---|---|---|
| `sentinel_errors` | `status`=["UNRESOLVED"], `hours`=24, `search`, `limit`=25 | Error groups from the built-in tracker. |
| `sentinel_error_detail` | `groupId*`, `occurrences`=10 | Message, stack, metadata, recent occurrences. |
| `search_logs` | `query*` (literal, ≥3 chars), `lines`=50 (≤300), `maxLineLength`=1200 | Most recent matching pm2 log lines (JSON per line). |
| `agent_call_log` | `limit`=50, `tool` | What this API has been asked recently. |

### Guarded writes — `agent:write` scope, `confirm: true` required

| Tool | Arguments | Effect |
|---|---|---|
| `extend_campaign` | `project*`, `days*` (1–90), `confirm*` | Moves a LIVE/FUNDED campaign's end date out. Refuses FAILED/CANCELLED. |
| `set_campaign_goal` | `project*`, `goal*`, `confirm*` | Changes the funding goal. |
| `add_newsletter_subscribers` | `subscribers*` (objects: `email`, `name`, `tags`; ≤5000) or `emails` (strings), `tags`, `source`="agent", `confirm*` | Bulk import, e.g. a Shopify customer export: creates new subscribers with names, merges tags into existing ones, re-activates. Blocklisted and opted-out addresses are skipped and listed in the result. |
| `create_email_campaign_draft` | `name*`, `subject*`, `html*`, `targetAudience`="all", `confirm*` | Creates a DRAFT in Admin → Email. Never sends. |

### Cross-system matching (Shopify / eBay → IndieCrowdfund)

| Tool | Arguments | Returns |
|---|---|---|
| `match_emails` | `emails*` (≤5000), `include`=all / not_on_platform / account_never_backed / never_backed / backers, `format`=json/csv | Per address: `status` (backer / account_never_backed / not_on_platform), name, pledges, total, last pledge, newsletter state, unsubscribed, blocklisted, `reachable`. Plus a summary. |

### Email campaigns, end to end — `agent:write`, `confirm: true`

| Tool | Arguments | Effect |
|---|---|---|
| `create_email_campaign` | `name*`, `mode*` (ai / html), ai: `subjectHint`, `introMessage`, `projectCategory`, `projectSlugs`, `includeProjectCards`; html: `subject`, `html`, `preheader`, `wrapInBrandShell`; `audience`=subscriber / backer / creator / retailer / all, `segmentTags`, `scheduleFor`, `confirm*` | Creates the campaign (DRAFT, or SCHEDULED with `scheduleFor`) using the same AI writer and branded template as Admin → AI Marketing. Returns the id, subject, live recipient count and a text preview. |
| `preview_email_campaign` *(read)* | `campaignId*`, `includeHtml`=false | Subject, status, audience, live recipient count, sample recipients, text rendering, stats. |
| `send_email_campaign` | `campaignId*`, `testTo`, `resend`=false, `confirm*` | With `testTo`: one `[TEST]` copy to that address, nothing else changes. Without: queues to the whole audience through the same path as the admin Send button and marks it SENT. |

Audiences map to the same lists the admin UI uses. `segmentTags` narrows
`subscriber` / `all` to newsletter subscribers carrying those tags, which is how
an arbitrary outreach list is targeted: `add_newsletter_subscribers` with a tag,
then `create_email_campaign` with `segmentTags: [thatTag]`.

### Driving the built-in AI marketing

| Tool | Arguments | Effect |
|---|---|---|
| `ai_status` *(read)* | — | Feature toggles, limits, quiet hours, standing directives, last automated campaign and recent automation performance. |
| `ai_run_history` *(read)* | `serviceId`, `limit`=30 | Run log for every AI service (manual, cron, agent). |
| `smart_segments` *(read)* | — | The AI's behaviour-based segments with sizes. |
| `generate_marketing_copy` *(read)* | `project*` | Tagline, subtitle, email subject, social posts and CTA for one campaign. Returns text; publishes nothing. |
| `get_marketing_directives` *(read)* | — | The standing instructions the marketing AI follows. |
| `set_marketing_directives` | `directives*` (≤4000 chars), `mode`=replace / append, `confirm*` | Plain-English instructions injected into every marketing prompt from then on: campaign emails, the creator newsletter, social posts, marketing copy. "Lead with the Tech category this month", "always mention the Shopify store", "no exclamation marks". |
| `update_ai_settings` | any of `emailPersonalization`, `predictiveAnalytics`, `smartSegmentation`, `sendTimeOptimization`, `contentOptimization`, `abTesting`, `autoTagging`, `emailFrequencyCap`, `dailyEmailLimit`, `quietHoursStart`, `quietHoursEnd`; `confirm*` | Flip features and limits. Only passed fields change. |
| `run_ai_service` | `action*` (runAutomation / runSegmentation / runPredictiveAnalytics / runSendTimeOptimization / runAutoTagging / runUserProfiling / testEmailPersonalization / testContentOptimization), `params`, `confirm*` | Runs the service exactly as the Run Now buttons do, logged in the AI run history. `runAutomation` is the daily orchestrator and **sends** a campaign when eligible. Can take minutes. |

### Social publicist (X)

| Tool | Arguments | Effect |
|---|---|---|
| `social_posts` *(read)* | `status` (array), `limit`=25 | The queue: pending, posted, failed, rejected. |
| `create_social_post` | `content*` (≤280), `imageUrl`, `project`, `confirm*` | Queues a hand-written post as PENDING. |
| `publish_social_post` | `postId*`, `confirm*` | Posts a pending/approved post to X now. Irreversible. |
| `generate_social_posts` | `confirm*` | Runs the publicist's generation pass (launches, milestones, ending soon, weekly roundup). |

### The box

| Tool | Arguments | Returns |
|---|---|---|
| `run_sql` *(read)* | `sql*`, `maxRows`=200 (≤500) | Rows from a single read-only SELECT / WITH / EXPLAIN, inside a READ ONLY transaction with a 15 s timeout. Write keywords and secret-bearing columns are refused. Table and column names are quoted CamelCase as in the Prisma schema. |
| `server_status` *(read)* | — | pm2 workers, memory, disk, uptime, database reachability, email queue depth, last AI run, unresolved errors in 24 h. |

There are deliberately **no** tools that refund, charge, pay out, or edit a
pledge, and no open shell. Money stays behind the admin UI where a human
clicks; `run_sql` is the "run a command on the box" tool, scoped to reading.

## 3a. Worked example: "find Shopify customers who haven't backed us, and email them"

This is the end-to-end flow the server exists for. The NAS MCP server already
has the Shopify tools; the IndieCrowdfund tools close the loop.

1. **Pull the customers** with the existing Shopify tools (`shopify_list_customers`
   or a GraphQL customers query), collecting email addresses.
2. **Compare**: `icf_match_emails { emails: [...], include: "never_backed", format: "csv" }`.
   The summary says how many are backers already, how many have an account but
   never pledged, how many are unknown to the platform. `reachable: false`
   rows are blocklisted or opted out; leave them out.
3. **Import them**: `icf_add_newsletter_subscribers { subscribers: [{ email, name }, …
   the reachable ones], tags: ["shopify-not-backer"], source: "shopify", confirm: true }`.
   Up to 5000 per call; names carry over so the email can say "Hi Mike". Blocklisted
   and opted-out addresses are skipped server-side even if passed. The same call
   with every Shopify customer (no filter) is a plain "import the store list".
4. **Write the email**: `icf_create_email_campaign { name: "Shopify customers →
   first pledge", mode: "ai", introMessage: "You've bought from our store; here's
   what's funding right now…", audience: "subscriber", segmentTags:
   ["shopify-not-backer"], confirm: true }`. Or `mode: "html"` with your own copy.
   The response includes the live recipient count.
5. **Check it**: `icf_preview_email_campaign`, then `icf_send_email_campaign
   { campaignId, testTo: "you@…", confirm: true }` and read the test copy.
6. **Send**: show the user the recipient count and subject, get a yes, then
   `icf_send_email_campaign { campaignId, confirm: true }`.
7. **Watch it**: `icf_email_campaigns` for opens and clicks over the next days;
   `icf_match_emails` again in a month to see who converted.

To make this a standing behaviour of the built-in AI rather than a one-off,
`icf_set_marketing_directives { directives: "Subscribers tagged shopify-not-backer
are store customers who have never backed a campaign; when featuring campaigns,
remind them their store purchases and pledges share one account.", mode: "append",
confirm: true }`, then let `runAutomation` do its daily pass.

## 4. Wrapping it in the MCP server

### Recommended: register tools dynamically from the catalog

At startup, call `GET /api/agent/v1/tools` and add one MCP tool per entry. With
the low-level `Server` from `@modelcontextprotocol/sdk` this is a merge into the
existing `ListTools` / `CallTool` handlers:

```ts
// icf.ts — IndieCrowdfund tools for the NAS MCP server
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const BASE = process.env.ICF_API_URL!;
const HEADERS = {
  "X-API-Key": process.env.ICF_API_KEY!,
  "X-API-Secret": process.env.ICF_API_SECRET!,
  "Content-Type": "application/json",
};
const PREFIX = "icf_";

interface CatalogEntry {
  name: string;
  description: string;
  scope: string;
  mutating: boolean;
  inputSchema: Record<string, unknown>;
}

let catalog: CatalogEntry[] = [];

export async function loadIcfCatalog(): Promise<void> {
  const res = await fetch(`${BASE}/api/agent/v1/tools`, { headers: HEADERS });
  if (!res.ok) throw new Error(`IndieCrowdfund catalog failed: ${res.status} ${await res.text()}`);
  catalog = (await res.json()).tools;
}

/** Entries for the ListTools response, merged with the Shopify/eBay ones. */
export function icfTools(): Tool[] {
  return catalog.map((t) => ({
    name: PREFIX + t.name,
    description: t.mutating
      ? `${t.description}\n\nTHIS CHANGES DATA. Ask the user to approve the exact change first, then call with confirm: true.`
      : t.description,
    inputSchema: t.inputSchema as Tool["inputSchema"],
  }));
}

export function isIcfTool(name: string): boolean {
  return name.startsWith(PREFIX) && catalog.some((t) => PREFIX + t.name === name);
}

/** CallTool handler body. Returns MCP content; errors become isError results. */
export async function callIcfTool(name: string, args: unknown) {
  const tool = name.slice(PREFIX.length);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(`${BASE}/api/agent/v1/tools/${encodeURIComponent(tool)}`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify(args ?? {}),
      signal: controller.signal,
    });
    const body = await res.json();
    if (!res.ok || body.ok === false) {
      const err = body.error ?? { code: "http_" + res.status, message: res.statusText };
      const details = err.details ? "\n" + err.details.map((d: { path: string; message: string }) => `- ${d.path}: ${d.message}`).join("\n") : "";
      return { isError: true, content: [{ type: "text", text: `IndieCrowdfund ${err.code}: ${err.message}${details}` }] };
    }
    // CSV results come back as a string field; hand it over verbatim.
    const result = body.result;
    const text = result && typeof result.csv === "string"
      ? `total=${result.total}\n${result.csv}`
      : JSON.stringify(result, null, 2);
    return { content: [{ type: "text", text }] };
  } finally {
    clearTimeout(timer);
  }
}
```

Wire-up in the existing server:

```ts
await loadIcfCatalog();   // at startup, after env is loaded; log and continue if it fails

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...shopifyTools(), ...ebayTools(), ...icfTools()],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (isIcfTool(name)) return callIcfTool(name, args);
  // …existing Shopify / eBay dispatch
});
```

If the server uses the high-level `McpServer.registerTool`, which wants zod
shapes rather than JSON Schema, either convert with `json-schema-to-zod` at
startup or register the IndieCrowdfund tools through the low-level handlers
shown above. The low-level route is simpler and keeps the catalog authoritative.

### Behaviour the wrapper must keep

- **Pass `confirm` through untouched.** The server refuses mutating calls
  without `confirm: true`; the wrapper must not add it on the model's behalf.
  The appended description text tells the model to get the user's approval first.
- **Surface errors as `isError` results, not thrown exceptions**, so the model
  reads the message (which is written for it) and can correct its arguments.
- **Don't cache results.** Everything is live data; the server sets no cache
  headers on purpose.
- **Keep the `icf_` prefix.** Tool names on the server are stable snake_case;
  never rename them on the wrapper side or the call log stops matching.

## 5. Testing from the NAS

```bash
export ICF_API_URL=https://indiecrowdfund.com ICF_API_KEY=ick_live_… ICF_API_SECRET=icsk_live_…

# Credentials and scopes
curl -s "$ICF_API_URL/api/agent/v1" -H "X-API-Key: $ICF_API_KEY" -H "X-API-Secret: $ICF_API_SECRET" | jq

# Catalog (tool names only)
curl -s "$ICF_API_URL/api/agent/v1/tools" -H "X-API-Key: $ICF_API_KEY" -H "X-API-Secret: $ICF_API_SECRET" | jq -r '.tools[].name'

# A read
curl -s "$ICF_API_URL/api/agent/v1/tools/list_projects" -H "X-API-Key: $ICF_API_KEY" -H "X-API-Secret: $ICF_API_SECRET" \
  -H 'Content-Type: application/json' -d '{"status":["LIVE"],"limit":5}' | jq '.result.projects[] | {slug,raised,backers}'

# A write without confirm → 400 confirmation_required
curl -s "$ICF_API_URL/api/agent/v1/tools/extend_campaign" -H "X-API-Key: $ICF_API_KEY" -H "X-API-Secret: $ICF_API_SECRET" \
  -H 'Content-Type: application/json' -d '{"project":"the-ghost-dance","days":7}' | jq
```

Every one of these shows up in `/admin/agent-api` under Recent calls.

## 6. Security notes

- Keys are minted only by a SUPER_ADMIN; there is no self-service.
- The secret is hashed at rest; the admin page shows only its prefix.
- Transport is HTTPS only. Credentials go in headers so they never land in
  access logs or Referer headers.
- Rate limit: 120 calls/minute per key, per app worker. Treat `429` as "slow down".
- Call log: every call is recorded with arguments (secret-shaped keys redacted),
  outcome and duration. Admins review it in `/admin/agent-api`.
- What the API never returns: passwords or hashes, card numbers or CVCs (none are
  stored anywhere), bank account numbers, payout details, API keys of any kind,
  survey answers beyond the shipping address (and that only when
  `includeAddress: true`), or anything from soft-deleted accounts.
- PII: backer emails and names are returned by design, because outreach is the
  point. Keep the NAS server's own logs from echoing full results, and don't
  write backer lists to disk outside the task that needed them.

## 7. Change management

- New tools, or new arguments on existing ones, appear in the catalog on deploy.
  The NAS server picks them up on its next restart. No wrapper change needed.
- Renames or removals are breaking and will be announced in the commit message
  and in the admin page's tool list before they land.
- `X-API-Version` / `version` is `1.0`. A `2.0` would mean a new base path
  (`/api/agent/v2`) with `v1` kept alive alongside it.

## Appendix: catalog snapshot

`docs/agent-api-catalog.json` is the exact output of `GET /api/agent/v1/tools`
at the time this spec was written, so the wrapper can be built and unit-tested
offline before a key exists. The live endpoint wins whenever they differ.
