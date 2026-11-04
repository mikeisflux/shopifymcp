# Hand-off: add IndieCrowdfund tools to the NAS MCP server

You built and run the MCP server on the NAS that exposes the `shopify_*` and
`ebay_*` tools. This brief asks you to add a third family, `icf_*`, that wraps
IndieCrowdfund's new Agent API so the same Claude session can read the platform,
build outreach lists, write and send email campaigns, and steer the built-in AI
marketing. Two files come with this brief:

- `AGENT-API-MCP-SPEC.md` — the full API reference (auth, endpoints, every tool,
  error codes, security notes, a worked Shopify example). Read it once; this
  page is the executive summary plus the build plan.
- `agent-api-catalog.json` — a snapshot of the live tool catalog, so you can
  build and test before the production key exists.

The server side is already live-ready: nothing in the IndieCrowdfund codebase
needs to change for this. The work is entirely in the MCP server.

## 1. What the API is

A JSON-over-HTTPS tool endpoint inside the IndieCrowdfund app.

```
GET  https://indiecrowdfund.com/api/agent/v1              → identity + scopes
GET  https://indiecrowdfund.com/api/agent/v1/tools        → catalog, JSON Schema per tool
POST https://indiecrowdfund.com/api/agent/v1/tools/{name} → run one tool (body = args)
```

Authentication on every request, headers only:

```
X-API-Key:    ick_live_…
X-API-Secret: icsk_live_…
```

Env vars the MCP server should read: `ICF_API_URL` (default
`https://indiecrowdfund.com`), `ICF_API_KEY`, `ICF_API_SECRET`. Mike issues the
pair at Admin → System → Agent API and will paste the three lines.

Responses:

```json
{ "ok": true,  "tool": "list_projects", "result": { … } }
{ "ok": false, "tool": "list_projects", "error": { "code": "invalid_arguments", "message": "…", "details": [ { "path": "limit", "message": "…" } ] } }
```

Rate limit 120 calls/minute per key (`429 rate_limited`). Every call is logged
on the IndieCrowdfund side with its arguments and outcome.

## 2. The tool families (42 tools)

Names below are the server names; prefix each with `icf_` in the MCP server.

| Family | Tools |
|---|---|
| Campaigns | `platform_overview`, `list_projects`, `get_project`, `project_backers`, `campaign_performance`, `category_breakdown`, `project_updates` |
| People | `find_user`, `user_pledges`, `backer_segments`, `creator_pipeline` |
| Matching | `match_emails` — compare up to 5000 addresses (a Shopify/eBay export) against accounts, pledges, newsletter, unsubscribe and blocklist state |
| Email intelligence | `email_engagement`, `user_email_history`, `email_deliverability`, `email_campaigns`, `newsletter_stats` |
| Email campaigns (write) | `add_newsletter_subscribers` (bulk import with names/tags), `create_email_campaign`, `preview_email_campaign`, `send_email_campaign`, `create_email_campaign_draft` |
| Built-in AI marketing | `ai_status`, `ai_run_history`, `smart_segments`, `generate_marketing_copy`, `get_marketing_directives`, `set_marketing_directives` (write), `update_ai_settings` (write), `run_ai_service` (write) |
| Social publicist (X) | `social_posts`, `create_social_post` (write), `publish_social_post` (write), `generate_social_posts` (write) |
| Campaign admin (write) | `extend_campaign`, `set_campaign_goal` |
| Operations | `sentinel_errors`, `sentinel_error_detail`, `search_logs`, `agent_call_log`, `run_sql` (read-only SQL), `server_status` |

Two scopes: `agent:read` covers everything not marked write; `agent:write`
covers the writes and implies read. Every write tool requires `confirm: true`
in its arguments and refuses with `400 confirmation_required` without it.

## 3. Build plan

### 3.1 Register tools from the catalog, don't hand-code them

At startup, `GET /api/agent/v1/tools` and register one MCP tool per entry:

- MCP tool name: `"icf_" + entry.name`
- description: `entry.description`, and for `entry.mutating === true` append
  `"\n\nTHIS CHANGES DATA. Ask the user to approve the exact change first, then call with confirm: true."`
- inputSchema: `entry.inputSchema` verbatim (JSON Schema draft-07, generated
  from the server's own validator, so it's always exactly what it accepts).

If the catalog fetch fails at startup, log it and keep the Shopify/eBay tools
working; retry the catalog on the next ListTools request. Tools added to
IndieCrowdfund later then appear on the NAS after a restart with no code change.

If you cannot load the catalog at all (no key yet), register from
`agent-api-catalog.json` so the shapes can be tested offline.

### 3.2 Dispatch

`CallTool` for a name starting with `icf_` → `POST /api/agent/v1/tools/{name without prefix}`
with the arguments as the JSON body, 300 s timeout for `run_ai_service` and
`send_email_campaign`, 60 s otherwise.

- `ok: true` → return `result` as pretty JSON text. When `result.csv` is a
  string (several tools offer `format: "csv"`), return the CSV verbatim.
- anything else → return an MCP **isError** result whose text is
  `IndieCrowdfund <code>: <message>` plus one line per `details` entry. Do not
  throw; the messages are written for the model to read and self-correct.
- Pass `confirm` through untouched. Never add it on the model's behalf.

Reference implementation (TypeScript, low-level `Server` handlers) is in
section 4 of the spec; it is about 60 lines and can be pasted as-is.

### 3.3 Startup check

Call `GET /api/agent/v1` once and log the key name, scopes and tool count. A
401 means the env is wrong; a key with only `agent:read` will 403 on writes.

### 3.4 Keep the server's own logs clean

Results contain backer names and emails. Log tool names and durations, not
payloads.

## 4. Acceptance test

With the env set:

```bash
curl -s "$ICF_API_URL/api/agent/v1" -H "X-API-Key: $ICF_API_KEY" -H "X-API-Secret: $ICF_API_SECRET" | jq
curl -s "$ICF_API_URL/api/agent/v1/tools" -H "X-API-Key: $ICF_API_KEY" -H "X-API-Secret: $ICF_API_SECRET" | jq -r '.tools | length'
```

Then from a Claude session connected to the NAS server, these should all work:

1. `icf_platform_overview` → numbers.
2. `icf_list_projects { status: ["LIVE"], limit: 5 }` → campaigns with slugs.
3. `icf_match_emails { emails: ["someone@example.com"], include: "all" }` → one row.
4. `icf_extend_campaign { project: "the-ghost-dance", days: 1 }` **without** confirm
   → an isError result saying confirmation is required (proves the guard and the
   error mapping; nothing changes).
5. `icf_run_sql { sql: "SELECT count(*) FROM \"Pledge\" WHERE status = 'COMPLETED'" }` → a count.

Every call should then be visible at `https://indiecrowdfund.com/admin/agent-api`
under Recent calls.

## 5. The workflow this is for

"Look at our Shopify customers, compare them to IndieCrowdfund backers, and
target the ones who haven't come over." In tools:

1. `shopify_list_customers` (yours) → emails and names.
2. `icf_match_emails { emails, include: "never_backed" }` → the outreach list and
   a summary of who is already a backer.
3. `icf_add_newsletter_subscribers { subscribers: [{ email, name }…], tags: ["shopify-not-backer"], source: "shopify", confirm: true }`.
   The same call with the full customer list and no filter is "import the
   Shopify list into the IndieCrowdfund email list".
4. `icf_create_email_campaign { name, mode: "ai", introMessage, audience: "subscriber", segmentTags: ["shopify-not-backer"], confirm: true }`
   → returns the live recipient count.
5. `icf_send_email_campaign { campaignId, testTo: "mike@…", confirm: true }` → one test copy.
6. After the user approves the count and subject:
   `icf_send_email_campaign { campaignId, confirm: true }`.
7. `icf_set_marketing_directives { directives: "…", mode: "append", confirm: true }`
   to make the built-in AI keep that angle in its own automated sends.

Nothing in this flow requires the model to know anything about the
IndieCrowdfund database or server; the tools carry all of it.

## 6. Out of scope, on purpose

The API has no tool that refunds, charges, pays out, edits a pledge, or runs a
shell command. If a task needs one of those, say so rather than working around
it; those are added on the IndieCrowdfund side as named, guarded tools.
