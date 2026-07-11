# Shopify Admin MCP Server

A self-hosted [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the
**Shopify Admin GraphQL API** to Claude (claude.ai / Claude Desktop) as a custom connector. It runs
as a Docker container — designed to live on a NAS behind a Cloudflare Tunnel — and speaks
**Streamable HTTP in stateless JSON mode**, so it scales trivially and sits happily behind a reverse
proxy.

- **Read tools** are always available (products, orders, customers, inventory, collections, draft
  orders, plus a read-only GraphQL escape hatch).
- **Write tools** are only registered when `ENABLE_WRITES=true` (create/update products & variants,
  adjust inventory, create/complete draft orders, create discount codes, tag resources).
- No delete operations, no OAuth — see [Out of scope](#out-of-scope-v1).

---

## Contents

1. [Architecture](#architecture)
2. [1. Create a Shopify custom app & access token](#1-create-a-shopify-custom-app--access-token)
3. [2. Configure `.env`](#2-configure-env)
4. [3. Run with Docker Compose](#3-run-with-docker-compose)
5. [4. Expose it: Cloudflare Tunnel](#4-expose-it-cloudflare-tunnel)
6. [5. Add the connector in claude.ai](#5-add-the-connector-in-claudeai)
7. [Alternative exposure: Hetzner reverse proxy over WireGuard/Tailscale](#alternative-exposure-hetzner-reverse-proxy-over-wireguardtailscale)
8. [Tools reference](#tools-reference)
9. [Access scopes](#access-scopes)
10. [Local testing with MCP Inspector](#local-testing-with-mcp-inspector)
11. [Security model](#security-model)
12. [NAS deployment notes](#nas-deployment-notes)
13. [Out of scope (v1)](#out-of-scope-v1)

---

## Architecture

```
claude.ai ──HTTPS──▶ Cloudflare Tunnel ──▶ cloudflared ──▶ shopify-mcp:3000
                                                              │
                                                              ▼
                                         Shopify Admin GraphQL API (your store)
```

The MCP endpoint is served at `POST /mcp/{MCP_PATH_SECRET}`. Every request creates a fresh, stateless
transport — there are no SSE sessions to keep alive. An unauthenticated `GET /healthz` is exposed for
container health checks and returns only `{ status, server, version }` (no store info).

Project layout:

```
src/
  index.ts            express app, transport, auth middleware, health check
  config.ts           env parsing + startup validation
  logger.ts           structured JSON logging (no secrets / PII)
  shopify-client.ts   GraphQL client: retries, 429/throttle handling, scope errors
  format.ts           markdown/structured formatting, GID <-> numeric id helpers
  tools/
    shared.ts         tool registration helper (timing/logging), pagination schema
    products.ts       list/get + create/update/update-variant
    orders.ts         list/get (read-only)
    customers.ts      list/get (read-only)
    inventory.ts      get levels + adjust
    draft-orders.ts   list/get + create/complete
    misc.ts           collections, search, graphql escape hatch, discounts, tags
```

---

## 1. Create a Shopify custom app & access token

This step is manual and is **not** automated by this project.

1. In Shopify admin go to **Settings → Apps and sales channels → Develop apps**.
   (You may need to click **Allow custom app development** the first time.)
2. Click **Create an app**, name it e.g. `Claude MCP`.
3. Open **Configuration → Admin API integration → Configure** and select the Admin API access scopes
   you need — see [Access scopes](#access-scopes). Grant only `read_*` scopes if you will keep
   `ENABLE_WRITES=false`.
4. Click **Install app**.
5. Under **API credentials**, reveal and copy the **Admin API access token** (starts with `shpat_`).
   You can only reveal it once — store it safely.

> The access token grants API access to your store. It goes in `.env` only — **never** commit it or
> bake it into the Docker image.

All requests this server makes are `POST https://{SHOPIFY_STORE_DOMAIN}/admin/api/{SHOPIFY_API_VERSION}/graphql.json`
with the header `X-Shopify-Access-Token: {token}`.

---

## 2. Configure `.env`

Copy the example and fill it in:

```bash
cp .env.example .env
```

| Variable | Required | Notes |
|---|---|---|
| `SHOPIFY_STORE_DOMAIN` | ✅ | `yourstore.myshopify.com` (no protocol, no path). |
| `SHOPIFY_ACCESS_TOKEN` | ✅ | The `shpat_...` token from step 1. |
| `SHOPIFY_API_VERSION` | ✅ | Pin the latest **stable** version, e.g. `2026-04`. See the [API version docs](https://shopify.dev/docs/api/admin-graphql). |
| `MCP_PATH_SECRET` | ✅ | 32+ random chars. Generate with `openssl rand -hex 24`. |
| `MCP_AUTH_TOKEN` | optional | Bearer token. If set, requests must send `Authorization: Bearer …`. Leave blank to rely on the secret path only. |
| `ENABLE_WRITES` | — | `true` to register write/mutation tools. Defaults to `false`. |
| `PORT` | — | Defaults to `3000`. |
| `LOG_LEVEL` | — | `debug` \| `info` \| `warn` \| `error`. Defaults to `info`. |
| `TUNNEL_TOKEN` | — | Cloudflare Tunnel token (used by the `cloudflared` compose service only). |

The server validates all required variables at startup and exits with a clear message listing every
problem if something is missing or malformed.

---

## 3. Run with Docker Compose

```bash
docker compose up -d --build
```

This starts two services:

- **`shopify-mcp`** — the MCP server (memory-limited to 256M, logs rotated at 10 MB × 3).
- **`cloudflared`** — the Cloudflare Tunnel (see next section).

By default no ports are published to the LAN. For local testing you can uncomment the `ports:`
mapping in `docker-compose.yml` to expose `3000`.

Check health:

```bash
docker compose ps
docker compose logs -f shopify-mcp
# If you exposed the port locally:
curl http://localhost:3000/healthz
```

### Running without Docker (development)

```bash
npm ci
npm run build
node dist/index.js       # reads env from your shell / a sourced .env
```

---

## 4. Expose it: Cloudflare Tunnel

claude.ai needs a public HTTPS URL. Cloudflare Tunnel is the primary, recommended path — it needs no
open inbound ports on your NAS or router.

1. In the [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/) go to
   **Networks → Tunnels → Create a tunnel** (choose **Cloudflared**).
2. Name the tunnel and copy its **token**. Put it in `.env` as `TUNNEL_TOKEN`.
3. Under the tunnel's **Public Hostname** tab, add a hostname:
   - **Subdomain/domain:** `mcp.yourdomain.com`
   - **Service:** `HTTP` → `shopify-mcp:3000`
     (this resolves inside the compose network — the `cloudflared` container reaches the MCP
     container by service name).
4. `docker compose up -d` — the `cloudflared` service picks up `TUNNEL_TOKEN` and connects.

Your public MCP URL is then:

```
https://mcp.yourdomain.com/mcp/<MCP_PATH_SECRET>
```

---

## 5. Add the connector in claude.ai

1. In claude.ai go to **Settings → Connectors → Add custom connector**.
2. Paste your full URL including the secret path segment:
   `https://mcp.yourdomain.com/mcp/<MCP_PATH_SECRET>`
3. If you set `MCP_AUTH_TOKEN`, provide it as a Bearer token / authorization header in the connector
   configuration.
4. Save. Claude will call `tools/list`; the Shopify tools should appear. Try:
   *"List my 5 most recent orders"* or *"Show product 123 with its variants."*

---

## Alternative exposure: Hetzner reverse proxy over WireGuard/Tailscale

If you already run a public server (e.g. an Nginx box on Hetzner) you can reverse-proxy to the NAS
instead of using Cloudflare Tunnel. This is **described here but not implemented** by this repo.

- Connect the Hetzner box and the NAS over a private overlay (WireGuard or Tailscale) so the NAS is
  reachable at a stable private IP (e.g. `100.x.y.z`).
- Publish the MCP container's port on the NAS to that private interface only.
- On the Hetzner box, terminate TLS (Let's Encrypt) and proxy to the NAS:

  ```nginx
  server {
      listen 443 ssl;
      server_name mcp.yourdomain.com;
      # ssl_certificate / ssl_certificate_key ...

      location /mcp/ {
          proxy_pass http://100.x.y.z:3000;
          proxy_http_version 1.1;
          proxy_set_header Host $host;
          proxy_set_header X-Forwarded-For $remote_addr;
          proxy_read_timeout 300s;
      }
  }
  ```

- Point `mcp.yourdomain.com` DNS at the Hetzner box. The secret path + bearer token still protect the
  endpoint; the reverse proxy just moves ingress off Cloudflare.

---

## Tools reference

All tools are prefixed `shopify_`. Every tool has a Zod-validated input schema (with descriptions),
cursor pagination on lists (`first` default 25, max 100; `after` cursor), and MCP annotations
(`readOnlyHint` / `destructiveHint` / `idempotentHint`).

Responses return **Markdown text** for readability plus **`structuredContent`** with the raw shaped
data. Shopify GID strings (`gid://shopify/Product/123`) are converted to plain numeric ids in output;
either form is accepted in input. Long lists are truncated with a note.

### Read tools (always enabled)

| Tool | Description |
|---|---|
| `shopify_list_products` | Filter by query, status, or collection. Returns id, title, status, handle, variant count, price range. |
| `shopify_get_product` | Full product incl. variants (SKUs, prices, inventory qty, policy), options, metafields. |
| `shopify_list_orders` | Filter by status, financial status, fulfillment status, created-at range, query. |
| `shopify_get_order` | Line items w/ SKUs, shipping address, fulfillments + tracking, transactions summary. |
| `shopify_list_customers` | Search customers; returns order count and total spent. |
| `shopify_get_customer` | Order count, lifetime spend, tags, default address. |
| `shopify_list_draft_orders` | Filter by status. |
| `shopify_get_draft_order` | Line items, totals, customer, invoice URL. |
| `shopify_list_collections` | Smart + custom collections, with product counts. |
| `shopify_get_inventory_levels` | By SKU or inventory item, across locations (available/on-hand/committed). |
| `shopify_search` | Quick cross-resource search (products, orders, customers). |
| `shopify_graphql_query` | Escape hatch: run an arbitrary **read-only** GraphQL query. Rejects any string containing a `mutation`. |

### Write tools (only when `ENABLE_WRITES=true`)

| Tool | Description |
|---|---|
| `shopify_create_product` | Create a product (a default variant is created automatically). |
| `shopify_update_product` | Partial product update. |
| `shopify_update_variant` | Update a variant's price, compare-at, SKU, inventory policy. |
| `shopify_adjust_inventory` | Adjust available quantity at a location by a signed delta. |
| `shopify_create_draft_order` | Line items by variant id or SKU, customer, shipping, discount. |
| `shopify_complete_draft_order` | Turn a draft order into a real order. |
| `shopify_create_discount_code` | Basic percentage/fixed code discount. |
| `shopify_tag_resource` | Add/remove tags on a product, order, customer, or draft order. |

### Errors

Error messages are actionable. Shopify `userErrors` are surfaced verbatim. On HTTP 429 the client
respects `Retry-After` and retries once with backoff; GraphQL `THROTTLED` cost errors back off based
on the reported restore rate and retry once. On an `ACCESS_DENIED` scope error the message names the
missing access scope so you know which one to add.

---

## Access scopes

Grant the app the scopes matching the tools you use. Read scopes are sufficient when
`ENABLE_WRITES=false`.

**Read (minimum):**
`read_products`, `read_orders`, `read_customers`, `read_draft_orders`, `read_inventory`,
`read_locations`, `read_discounts`

**Write (add when `ENABLE_WRITES=true`):**
`write_products`, `write_inventory`, `write_draft_orders`, `write_discounts`

> `shopify_tag_resource` needs the write scope for whichever resource you tag (e.g. `write_products`,
> `write_orders`, `write_customers`).

If a call returns an access-denied error, the message tells you the missing scope — add it in the
app's configuration and **reinstall** the app for the change to take effect.

---

## Local testing with MCP Inspector

Point the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) at a locally running
container (uncomment the `ports:` mapping first):

```bash
npx @modelcontextprotocol/inspector
```

In the Inspector UI choose **Streamable HTTP** transport and connect to:

```
http://localhost:3000/mcp/<MCP_PATH_SECRET>
```

(Add the `Authorization: Bearer <MCP_AUTH_TOKEN>` header if you configured one.) You should see the
tools list; a `shopify_list_products` call should round-trip against your store.

Quick smoke tests with `curl`:

```bash
# Health check → 200
curl http://localhost:3000/healthz

# Wrong secret path → 404
curl -X POST http://localhost:3000/mcp/nope -H 'Content-Type: application/json' -d '{}'

# tools/list (Accept header is required by the transport)
curl -X POST "http://localhost:3000/mcp/<MCP_PATH_SECRET>" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

---

## Security model

Two layers protect the internet-facing MCP endpoint, both applied before any request reaches the MCP
handler:

1. **Secret path segment** — MCP is served only at `/mcp/{MCP_PATH_SECRET}`. Any other path returns
   `404`. Use 32+ random characters.
2. **Bearer token (optional)** — when `MCP_AUTH_TOKEN` is set, requests must send
   `Authorization: Bearer {token}` or receive `401`. It's optional so it can be disabled for clients
   that cannot send custom headers, leaving layer 1 in force.

Both comparisons are constant-time. There is **no OAuth** in v1.

Logging is structured JSON to stdout with timestamp, tool name, duration, Shopify query cost, and
success/error. The access token, auth token, and full customer PII are **never** logged — only
resource ids (order/customer/product), not names, emails, or addresses.

---

## NAS deployment notes

Works on any NAS with Docker / Container Manager (Synology, QNAP, Unraid, …).

- **Simplest:** copy this folder to the NAS and run `docker compose up -d --build`.
- **If the NAS can't build images:** build elsewhere and transfer the image —
  ```bash
  docker build -t shopify-admin-mcp:latest .
  docker save shopify-admin-mcp:latest | gzip > shopify-mcp.tar.gz
  # copy to NAS, then:
  gunzip -c shopify-mcp.tar.gz | docker load
  ```
  Then run compose with the pre-built image (remove/ignore the `build:` line).
- Keep `.env` on the NAS only; it is git-ignored and Docker-ignored so it never lands in the image or
  the repo.

---

## Out of scope (v1)

OAuth, multi-store support, webhooks, delete operations, theme/content editing, the Storefront API,
and a metrics dashboard.
