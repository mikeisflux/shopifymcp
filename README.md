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
- No delete operations, and no user-facing OAuth on the MCP endpoint — see [Out of scope](#out-of-scope-v1).

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

## 1. Create a Shopify app & get credentials

This step is manual and is **not** automated by this project.

> **Heads up (2026):** Legacy *custom apps* created from the store admin (the `shpat_…`-token flow)
> can **no longer be created** as of **January 1, 2026**. New setups use a **Dev Dashboard app** with
> the **client-credentials grant** — you get a **Client ID + Client secret** instead of a static
> token, and this server exchanges them for a short-lived access token that it **refreshes
> automatically** (client-credentials tokens last ~24h). See
> [Using the client credentials grant](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant).

**Method 1 — Dev Dashboard app (recommended):**

1. Go to the [Shopify Dev Dashboard](https://dev.shopify.com) → your organization → **Apps → Create app**.
2. Open the app's config (**Versions → create/edit a version**) and set:
   - **App URL:** your future tunnel URL, e.g. `https://mcp.yourdomain.com` (placeholder is fine — this
     server has no app UI).
   - **Embed app in Shopify admin:** **off**.
   - **Scopes:** paste the list from [Access scopes](#access-scopes).
   - **Redirect URLs:** any placeholder HTTPS URL (not used by this server).
   - **Release** the version.
3. **Install the app on your store** (the store must belong to the *same organization* as the app, or
   client credentials returns `shop_not_permitted`).
4. Copy the app's **Client ID** and **Client secret** into `.env` as `SHOPIFY_CLIENT_ID` /
   `SHOPIFY_CLIENT_SECRET`.

**Method 2 — legacy static token (only if you already have one):** if you created a custom app *before*
2026-01-01, its `shpat_…` token still works — leave the client id/secret blank and set
`SHOPIFY_ACCESS_TOKEN` instead.

> Credentials go in `.env` only — **never** commit them or bake them into the Docker image.

All API requests go to `POST https://{SHOPIFY_STORE_DOMAIN}/admin/api/{SHOPIFY_API_VERSION}/graphql.json`
with an `X-Shopify-Access-Token` header. In client-credentials mode the token is obtained from
`POST https://{SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token` and cached/refreshed by the server.

---

## 2. Configure `.env`

Copy the example and fill it in:

```bash
cp .env.example .env
```

| Variable | Required | Notes |
|---|---|---|
| `SHOPIFY_STORE_DOMAIN` | ✅ | `yourstore.myshopify.com` (no protocol, no path). |
| `SHOPIFY_API_VERSION` | ✅ | Pin the latest **stable** version, e.g. `2026-07`. See the [API version docs](https://shopify.dev/docs/api/admin-graphql). |
| `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` | ✅ (method 1) | From your Dev Dashboard app. The server auto-fetches/refreshes the access token. |
| `SHOPIFY_ACCESS_TOKEN` | ✅ (method 2) | A pre-2026 `shpat_…` token. Use **instead of** client id/secret. |
| `MCP_PATH_SECRET` | ✅ | 32+ random chars. Generate with `openssl rand -hex 24`. |
| `MCP_AUTH_TOKEN` | optional | Bearer token. If set, requests must send `Authorization: Bearer …`. Leave blank to rely on the secret path only. |
| `ENABLE_WRITES` | — | `true` to register write/mutation tools (needs `write_*` scopes). Defaults to `false`. |
| `PORT` | — | Defaults to `3000`. |
| `LOG_LEVEL` | — | `debug` \| `info` \| `warn` \| `error`. Defaults to `info`. |
| `TUNNEL_TOKEN` | — | Cloudflare Tunnel token (used by the `cloudflared` compose service only). |

Provide **either** `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` **or** `SHOPIFY_ACCESS_TOKEN`. The
server validates this at startup and exits with a clear message if credentials are missing or
malformed.

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
| `shopify_get_product` | Full product incl. variants (SKUs, prices, inventory qty, policy, tracking), options, media (with ids), SEO, and metafields. |
| `shopify_list_orders` | Filter by status, financial status, fulfillment status, created-at range, query. |
| `shopify_get_order` | Line items w/ SKUs, shipping address, fulfillments + tracking, transactions summary. |
| `shopify_list_customers` | Search customers; returns order count and total spent. |
| `shopify_get_customer` | Order count, lifetime spend, tags, default address. |
| `shopify_list_draft_orders` | Filter by status. |
| `shopify_get_draft_order` | Line items, totals, customer, invoice URL. |
| `shopify_list_collections` | Smart + custom collections, with product counts. |
| `shopify_get_inventory_levels` | By SKU or inventory item, across locations (available/on-hand/committed). |
| `shopify_search` | Quick cross-resource search (products, orders, customers). |
| `shopify_list_publications` | List sales channels (publications) with ids. Needs `read_publications`. |
| `shopify_list_menus` | List navigation menus with their full item trees (up to 3 levels). Needs `read_online_store_navigation`. |
| `shopify_graphql_query` | Escape hatch: run an arbitrary **read-only** GraphQL query. Rejects any string containing a `mutation`. |

### Write tools (only when `ENABLE_WRITES=true`)

| Tool | Description |
|---|---|
| `shopify_create_product` | Create a product, incl. handle and SEO title/description (a default variant is created automatically). |
| `shopify_update_product` | Partial product update: title, description, vendor, type, tags, handle, SEO, theme template, status. |
| `shopify_duplicate_product` | Duplicate a product (copies variants, options, and optionally images) with a new title/status. |
| `shopify_update_variant` | Update a variant's price, compare-at, SKU, inventory policy, or inventory tracking. |
| `shopify_create_variant` | Add one or more variants (with option values) to an existing product. |
| `shopify_reorder_option_values` | Set the display order of a product option's values (list order = position). |
| `shopify_reset_handles` | **Bulk:** set each product's URL handle to slugify(title); skips already-correct, reports collisions (never auto-suffixes). No redirects created. `dryRun` defaults on. |
| `shopify_normalize_print_variants` | **Bulk/domain:** bring art-print products to the standard P/FP/MP/MTC set (fixed titles/prices/weights, option "Style", value order, media on all variants, tracking off); leaves MAG untouched. `dryRun` defaults on; existing-variant repricing is flagged. |
| `shopify_normalize_book_variants` | **Bulk/domain/destructive:** normalize book products to the 5-cover set, MERGING standalone sibling listings (Foil/Metal/GITD/RM) into the base product, carrying inventory across, then deleting the emptied sibling. Optional `excludeAbovePrice` (skip premium covers), name exclusion (`excludeNames`, defaults LTD/Exclusive/Sketch/Damaged/Pin-Up matched on title or option value), and per-cover `weights` (oz, applied to existing variants too). `dryRun` defaults on and reports deletes/inventory-moves/reprices/reweights separately; on execute a sibling is deleted only after its stock is verified on the new variant. |
| `shopify_delete_variant` | Delete variants from a product (irreversible; a product keeps ≥1 variant). |
| `shopify_add_product_media` | Add image(s) to a product from public URLs, with alt text. |
| `shopify_assign_variant_media` | Attach product media to variants — one media to all variants, or explicit variant→media pairs. De-dupes, so re-runs are safe. |
| `shopify_delete_product_media` | Remove media from a product by media id. |
| `shopify_set_metafield` | Set/overwrite a metafield on a product or variant. |
| `shopify_set_inventory_tracking` | **Bulk:** turn inventory tracking on/off for every variant of a product, or every product in a collection, in one call. Iterates + paginates server-side. |
| `shopify_bulk_set_inventory_quantity` | **Bulk:** set the absolute available/on-hand quantity at a location for every variant of a product or collection. Reads current for compare-and-swap; auto-activates items not yet stocked there. |
| `shopify_adjust_inventory` | Adjust available quantity at a location by a signed delta. |
| `shopify_create_draft_order` | Line items by variant id or SKU, customer, shipping, discount. |
| `shopify_complete_draft_order` | Turn a draft order into a real order. |
| `shopify_create_discount_code` | Basic percentage/fixed code discount. |
| `shopify_tag_resource` | Add/remove tags on a single product/order/customer/draft order, or in bulk on every product in a collection. |
| `shopify_create_collection` | Create a manual collection, or a smart/automated one via a rule set. |
| `shopify_update_collection` | Update a collection's title, description, handle, sort order, SEO, or smart rules. |
| `shopify_add_products_to_collection` | Add products to a manual collection. |
| `shopify_remove_products_from_collection` | Remove products from a manual collection (async job). |
| `shopify_publish_resource` | Publish/unpublish products or a whole collection's products to sales channels (all or specific). Needs `write_publications`. |
| `shopify_upsert_menu` | Create/update a navigation menu with a recursive item tree (link items to collections/products/URLs). Merge mode avoids replacing the whole menu. Needs `write_online_store_navigation`. |
| `shopify_update_shipping_package` | Update a saved shipping package (name, type, weight, dimensions, default). Needs a shipping scope; package GID must be supplied (no list query exists in the API). |

### Errors

Error messages are actionable. Shopify `userErrors` are surfaced verbatim. On HTTP 429 the client
respects `Retry-After` and retries once with backoff; GraphQL `THROTTLED` cost errors back off based
on the reported restore rate and retry once. On an `ACCESS_DENIED` scope error the message names the
missing access scope so you know which one to add.

---

## Access scopes

Grant the app the scopes matching the tools you use. Read scopes are sufficient when
`ENABLE_WRITES=false`.

Paste these as a comma-separated list in the app's **Scopes** field.

**Read (minimum):**
```
read_products,read_orders,read_customers,read_draft_orders,read_inventory,read_locations,read_discounts
```

**Read + write (when `ENABLE_WRITES=true`):**
```
read_products,read_orders,read_customers,read_draft_orders,read_inventory,read_locations,read_discounts,write_products,write_orders,write_customers,write_inventory,write_draft_orders,write_discounts
```

**Additional scopes for the extended tools** (add only the ones whose tools you use):
- Fulfillment (`shopify_fulfill_order`, `shopify_update_fulfillment_tracking`): `write_merchant_managed_fulfillment_orders` (and/or `write_assigned_fulfillment_orders`)
- Content — pages/blogs/articles (`shopify_*_page/_blog/_article`): `read_content`, `write_content`
- File upload (`shopify_upload_file`, `shopify_delete_files`): `write_files` (`read_files` for reads)
- Gift cards (`shopify_create_gift_card`, `shopify_update_gift_card`, `shopify_deactivate_gift_card`): `read_gift_cards`, `write_gift_cards` (store must have gift cards enabled)
- Navigation (`shopify_*_menu`): `read_online_store_navigation`, `write_online_store_navigation`
- Publishing (`shopify_publish_resource`, `shopify_list_publications`): `read_publications`, `write_publications`
- Shipping packages (`shopify_update_shipping_package`): `write_shipping`
- Marketing consent (`shopify_update_customer_marketing_consent`): `write_customers` (already listed)

> `shopify_tag_resource` needs the write scope for whichever resource you tag (`write_products`,
> `write_orders`, `write_customers`).
>
> `shopify_update_shipping_package` needs a shipping/delivery scope (`write_shipping`). There is **no
> query to list shipping packages** in the Admin API, so you must supply the package's GID — find it
> in the admin URL when editing the package (Settings → Shipping → Packages).
>
> `shopify_list_publications` needs `read_publications`; `shopify_publish_resource` needs
> `write_publications`. Add these to the app's scopes (and reinstall/update) before publishing to
> sales channels.
>
> `shopify_list_menus` needs `read_online_store_navigation`; `shopify_upsert_menu` needs
> `write_online_store_navigation`. Menu items link to resources via `type` + `resourceId` (e.g. a
> `COLLECTION` item with the collection GID as `resourceId`), or `HTTP` + `url` for arbitrary links.

If a call returns an access-denied error, the message names the missing scope — add it to the app's
scopes, **release a new app version, and reinstall/update** the app on the store for the change to
take effect. (For a legacy static-token app, update its scopes and reinstall.)

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

Both comparisons are constant-time. The MCP endpoint itself uses no OAuth (bearer + secret path only).

**Shopify token handling:** in client-credentials mode the Shopify access token is fetched
server-side, held only in memory, and refreshed automatically before it expires (and on a `401`). The
client id/secret, the access token, the MCP auth token, and full customer PII are **never** logged —
logs carry only resource ids (order/customer/product), not names, emails, or addresses.

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

User-facing / multi-tenant OAuth on the MCP endpoint (the Shopify side does use the client-credentials
grant), multi-store support, webhooks, delete operations, theme/content editing, the Storefront API,
and a metrics dashboard.
