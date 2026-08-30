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
| `EBAY_CLIENT_ID` + `EBAY_CLIENT_SECRET` | optional | App ID (Client ID) + Cert ID (Client secret) from [developer.ebay.com](https://developer.ebay.com). Set **both** to enable the `ebay_*` tools, or **neither** to disable eBay. |
| `EBAY_REFRESH_TOKEN` | optional | User OAuth refresh token (Sell scopes). Required for the Sell APIs. The server exchanges it for a short-lived user access token and refreshes automatically. Without it, only client-credentials app-token endpoints work. |
| `EBAY_SCOPES` | optional | Space-separated OAuth scopes. Optional with a refresh token (its granted scopes are used); required when falling back to a client-credentials app token. |
| `EBAY_MARKETPLACE_ID` | — | Sent as `X-EBAY-C-MARKETPLACE-ID`. Defaults to `EBAY_US`. |
| `EBAY_SELLER_TIMEZONE` | — | IANA timezone of the account's "Date sold" display. Defaults to `America/Los_Angeles`. Used by `ebay_search_orders` to interpret local date ranges. |
| `EBAY_ENV` | — | `production` (default) or `sandbox`. Selects `api.ebay.com` vs `api.sandbox.ebay.com`. |
| `EBAY_DELETION_VERIFICATION_TOKEN` + `EBAY_DELETION_ENDPOINT_URL` | optional | Enable the eBay **Marketplace Account Deletion** notification endpoint that eBay requires before a production keyset activates. Set **both** (see below). |

Provide **either** `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` **or** `SHOPIFY_ACCESS_TOKEN`. The
server validates this at startup and exits with a clear message if credentials are missing or
malformed.

**eBay is optional.** When `EBAY_CLIENT_ID` + `EBAY_CLIENT_SECRET` are both set, the `ebay_*` tools
are registered so this server can also talk to eBay (independent of `ENABLE_WRITES`; eBay write tools
default to `dryRun`). Leave both blank and eBay stays off entirely.

#### Activating an eBay production keyset (Marketplace Account Deletion endpoint)

eBay will **not activate a production keyset** until you satisfy its **Marketplace Account
Deletion/Closure** requirement (Developer Portal → your app → **Alerts & Notifications** →
**Marketplace Account Deletion** radio — *not* "Platform Notifications", which is a separate optional
feature). You either stand up an endpoint that answers eBay's challenge, or request an exemption.

This server includes that endpoint. To use it:

1. **Invent a verification token** — 32–80 chars, letters/digits/`_`/`-` only. Generate one with
   `openssl rand -hex 24`.
2. In `.env`, set:
   - `EBAY_DELETION_VERIFICATION_TOKEN` = that token
   - `EBAY_DELETION_ENDPOINT_URL` = your public HTTPS base + `/ebay/deletion`
     (e.g. `https://your-tunnel-host/ebay/deletion`). The URL is part of the challenge hash, so it
     must match **exactly** what you register with eBay.
3. Restart the container.
4. In eBay's **Marketplace Account Deletion** form, enter the same URL and the same verification
   token, then **Save** (or **Send Test Notification**). eBay `GET`s the endpoint with a
   `challenge_code`; the server replies with `SHA-256(challengeCode + verificationToken + endpointUrl)`
   and eBay marks it verified.

The endpoint is unauthenticated (eBay calls it directly, like `/healthz`) and lives outside the
secret MCP path. It acknowledges deletion `POST`s with `200` and logs them; the server stores no eBay
marketplace-user data, so there is nothing to purge.

> Alternatively, if you don't want to run the endpoint, you can toggle **"Exempted from Marketplace
> Account Deletion"** in the same eBay form — but the endpoint above is the reliable, self-contained path.

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

Every tool has a Zod-validated input schema (with per-field descriptions), and MCP annotations
(`readOnlyHint` / `destructiveHint` / `idempotentHint`). Responses return **Markdown text** for
readability plus **`structuredContent`** with the raw shaped data. Shopify GID strings
(`gid://shopify/Product/123`) are converted to plain numeric ids in output; either form is accepted
in input. Lists use cursor pagination (`first` default 25, max 100; `after` cursor).

**Enablement & safety at a glance:**

- **Read** tools (get / list / search) are **always on**.
- **Write** tools (create / update / delete / bulk / normalize) require **`ENABLE_WRITES=true`**.
- **eBay** tools require `EBAY_CLIENT_ID` + `EBAY_CLIENT_SECRET`; the cross-service **workflow** tools
  and the **auction** controls require both Shopify writes **and** eBay creds.
- Destructive and all eBay-write tools default to **`dryRun:true`** — they echo the planned call and
  do nothing until you pass `dryRun:false`.

There are **154 tools**. They're grouped by domain below.

### Products & variants

| Tool | What it does |
|---|---|
| `shopify_list_products` | *(read)* Filter by query/status/collection; returns id, title, status, handle, variant count, price range. |
| `shopify_get_product` | *(read)* Full product: variants (SKUs, prices, inventory, policy, tracking), options, media (with ids), SEO, metafields. |
| `shopify_create_product` | Create a product incl. handle + SEO (a default variant is created automatically). |
| `shopify_update_product` | Partial update: title, description, vendor, type, tags, handle, SEO, template, status. |
| `shopify_duplicate_product` | Duplicate a product (variants, options, optionally images) with a new title/status. |
| `shopify_delete_product` | Delete a product (irreversible). |
| `shopify_create_variant` | Add one or more variants (with option values) to a product. |
| `shopify_update_variant` | Update a variant's price, compare-at, SKU, inventory policy/tracking, weight, requires-shipping, taxable. |
| `shopify_delete_variant` | Delete variants (a product keeps ≥1 variant). |
| `shopify_set_variant_taxable` | **Bulk:** flip every variant of a product/collection taxable/non-taxable. |
| `shopify_create_product_option` | Add a new option (e.g. Size) with values to a product. |
| `shopify_update_product_option` | Rename a product option and/or its values. |
| `shopify_delete_product_option` | Remove a product option. |
| `shopify_reorder_option_values` | Set the display order of an option's values. |
| `shopify_add_product_media` | Add image(s) from public URLs, with alt text. |
| `shopify_delete_product_media` | Remove media from a product by media id. |
| `shopify_assign_variant_media` | Attach product media to variants (one-to-all or explicit pairs); de-dupes. |
| `shopify_set_metafield` | Set/overwrite a metafield on a product or variant. |
| `shopify_reset_handles` | **Bulk:** set each product's handle to slugify(title); skips correct, reports collisions. |

### Collections

| Tool | What it does |
|---|---|
| `shopify_list_collections` | *(read)* Smart + custom collections with product counts. |
| `shopify_get_collection` | *(read)* One collection's detail incl. smart rules. |
| `shopify_create_collection` | Create a manual collection, or a smart one via a rule set. |
| `shopify_update_collection` | Update title, description, handle, sort order, SEO, or smart rules. |
| `shopify_delete_collection` | Delete a collection. |
| `shopify_add_products_to_collection` | Add products to a manual collection. |
| `shopify_remove_products_from_collection` | Remove products from a manual collection (async job). |
| `shopify_reorder_collection_products` | Reorder products within a manual collection. |
| `shopify_set_collection_image` | Set or clear a collection's image. |

### Inventory & locations

| Tool | What it does |
|---|---|
| `shopify_get_inventory_levels` | *(read)* By SKU/inventory item across locations (available/on-hand/committed). |
| `shopify_list_locations` | *(read)* Store locations with ids. |
| `shopify_adjust_inventory` | Adjust available quantity at a location by a signed delta. |
| `shopify_set_inventory_quantity` | Set the absolute available/on-hand quantity for one item at a location. |
| `shopify_bulk_set_inventory_quantity` | **Bulk:** set absolute quantity for every variant of a product/collection; auto-activates unstocked items. |
| `shopify_set_inventory_tracking` | **Bulk:** turn tracking on/off for every variant of a product/collection. |
| `shopify_activate_inventory` | Activate an inventory item at a location so it can carry stock. |

### Orders & fulfillment

| Tool | What it does |
|---|---|
| `shopify_list_orders` | *(read)* Filter by status, financial/fulfillment status, created-at range, query. |
| `shopify_get_order` | *(read)* Line items w/ SKUs, shipping address, fulfillments + tracking, transactions. |
| `shopify_update_order` | Update order note, tags, email, or shipping address. |
| `shopify_edit_order` | Add variant/custom line items to an existing order (begin→add→commit); `dryRun` shows the recalculated total. |
| `shopify_cancel_order` | Cancel an order (with reason; optional refund/restock). |
| `shopify_close_order` | Close (archive) an order. |
| `shopify_reopen_order` | Reopen a closed order. |
| `shopify_mark_order_paid` | Mark an order as paid. |
| `shopify_capture_order_payment` | Capture an authorized payment. |
| `shopify_create_refund` | Refund line items and/or shipping (optional restock). |
| `shopify_create_return` | Open a return against fulfilled lines (by fulfillmentLineItemId/variantId/SKU). |
| `shopify_issue_store_credit` | Credit a customer's store-credit account; `dryRun` shows current→resulting balance. |
| `shopify_fulfill_order` | Fulfill line items with optional tracking + customer notification. |
| `shopify_update_fulfillment_tracking` | Update tracking number/URL/company on an existing fulfillment. |
| `shopify_send_order_invoice` | Email the order invoice to the customer. |

### Draft orders

| Tool | What it does |
|---|---|
| `shopify_list_draft_orders` | *(read)* Filter by status. |
| `shopify_get_draft_order` | *(read)* Line items, totals, customer, invoice URL. |
| `shopify_create_draft_order` | Line items by variant id or SKU, customer, shipping, discount. |
| `shopify_update_draft_order` | Update a draft's line items, customer, shipping, discount, or note. |
| `shopify_complete_draft_order` | Turn a draft into a real order. |
| `shopify_delete_draft_order` | Delete a draft order. |
| `shopify_send_draft_order_invoice` | Email the draft-order invoice to the customer. |

### Customers

| Tool | What it does |
|---|---|
| `shopify_list_customers` | *(read)* Search customers; returns order count + total spent. |
| `shopify_get_customer` | *(read)* Order count, lifetime spend, tags, default address. |
| `shopify_create_customer` | Create a customer record. |
| `shopify_update_customer` | Update a customer's details, tags, or address. |
| `shopify_update_customer_marketing_consent` | Set email-marketing consent state. |
| `shopify_send_customer_invite` | Email a customer an account-activation invite. |
| `shopify_delete_customer` | Delete a customer. |

### Discounts, gift cards & credit

| Tool | What it does |
|---|---|
| `shopify_list_discounts` | *(read)* List code + automatic discounts. |
| `shopify_create_discount_code` | Create a basic percentage/fixed code discount. |
| `shopify_create_automatic_discount` | Create an automatic (no-code) discount. |
| `shopify_deactivate_discount` | Deactivate a code or automatic discount. |
| `shopify_create_gift_card` | Issue a gift card (value, optional customer + expiry). |
| `shopify_update_gift_card` | Update a gift card's note/expiry/customer. |
| `shopify_deactivate_gift_card` | Disable a gift card. |

### Content, navigation, redirects & files

| Tool | What it does |
|---|---|
| `shopify_list_blogs` | *(read)* List blogs. |
| `shopify_create_blog` | Create a blog. |
| `shopify_delete_blog` | Delete a blog. |
| `shopify_list_articles` | *(read)* List blog articles. |
| `shopify_create_article` | Create a blog article. |
| `shopify_update_article` | Update a blog article. |
| `shopify_delete_article` | Delete a blog article. |
| `shopify_list_pages` | *(read)* List online-store pages. |
| `shopify_create_page` | Create a page. |
| `shopify_update_page` | Update a page. |
| `shopify_delete_page` | Delete a page. |
| `shopify_list_menus` | *(read)* Navigation menus with full item trees. Needs `read_online_store_navigation`. |
| `shopify_upsert_menu` | Create/update a navigation menu with a recursive item tree (merge mode available). |
| `shopify_delete_menu` | Delete a navigation menu. |
| `shopify_list_url_redirects` | *(read)* List storefront URL redirects. |
| `shopify_create_url_redirect` | Create a URL redirect (e.g. after a handle change). |
| `shopify_delete_url_redirect` | Delete a URL redirect. |
| `shopify_upload_file` | Upload a file to Files from a public URL. |
| `shopify_delete_files` | Delete files by id. |
| `shopify_list_publications` | *(read)* Sales channels (publications) with ids. Needs `read_publications`. |
| `shopify_publish_resource` | Publish/unpublish products or a collection's products to sales channels. Needs `write_publications`. |

### Metaobjects & metafields

| Tool | What it does |
|---|---|
| `shopify_list_metaobject_definitions` | *(read)* Metaobject definitions/schemas. |
| `shopify_list_metaobjects` | *(read)* Metaobject entries by type. |
| `shopify_get_metaobject` | *(read)* One entry by id/handle. |
| `shopify_create_metaobject` | Create a metaobject entry (optional publish status). |
| `shopify_update_metaobject` | Update a metaobject entry. |
| `shopify_delete_metaobject` | Delete a metaobject entry. |
| `shopify_delete_metafield` | Delete a metafield from a resource. |

### Themes

| Tool | What it does |
|---|---|
| `shopify_list_themes` | *(read)* Themes with role (MAIN = live). |
| `shopify_get_theme_files` | *(read)* Read theme file contents. |
| `shopify_edit_theme_files` | Create/update theme files (Liquid/JSON/assets); live theme needs `allowLiveTheme:true`. |
| `shopify_delete_theme_files` | Delete theme files. |
| `shopify_publish_theme` | Make a theme live (shows what it replaces). |
| `shopify_delete_theme` | Delete a non-live theme. |

### Shop, shipping & escape hatches

| Tool | What it does |
|---|---|
| `shopify_get_shop` | *(read)* Shop info (name, domains, currency, plan, features). |
| `shopify_update_shipping_package` | Update a saved shipping package (name, type, weight, dimensions, default). |
| `shopify_search` | *(read)* Quick cross-resource search (products, orders, customers). |
| `shopify_graphql_query` | *(read)* Escape hatch: run an arbitrary read-only GraphQL query (rejects mutations). |
| `shopify_graphql_mutation` | Write escape hatch: run an arbitrary Admin GraphQL mutation (requires `userErrors`, GIDs; `dryRun` on). |

### Bulk & catalog-normalization tools

| Tool | What it does |
|---|---|
| `shopify_bulk_set_product_status` | **Bulk:** set ACTIVE/DRAFT/ARCHIVED across productIds, a collection, or a productType. |
| `shopify_bulk_adjust_prices` | **Bulk:** delta/percent/set prices across a collection/product(s)/type; per-option-value overrides; before/after plan. |
| `shopify_bulk_tag` | **Bulk:** add/remove tags across a product / list / collection(s) / productType. |
| `shopify_tag_resource` | Add/remove tags on a single product/order/customer/draft, or in bulk across a collection. |
| `shopify_bulk_set_variant_weight` | **Bulk:** set the same weight+unit on every variant of a product/list/collection. |
| `shopify_bulk_update_product_option` | **Bulk:** rename an option / its values across many products. |
| `shopify_bulk_graphql_mutation` | **Bulk escape hatch:** run one mutation across many variable sets, validated up front, per-item errors. |
| `shopify_normalize_print_variants` | **Domain:** bring art-print products to the standard P/FP/MP/MTC set (titles/prices/weights/option order/media/tracking). |
| `shopify_normalize_book_variants` | **Domain/destructive:** normalize books to the 5-cover set, merging standalone Foil/Metal/GITD/RM siblings into the base and carrying inventory across. |
| `shopify_bulk_split_variants_to_products` | **"Ebay Live Splitoff":** split every variant of every product in a collection into its own `-ebaylive` single-variant product; cursor-paginated; idempotent. |
| `shopify_bulk_sync_variant_images` | Copy one product's primary image onto many targets (delete-then-add per target); skips already-in-sync and warns on unchanged source. |

### eBay — core Sell/Inventory API

These call eBay's REST APIs. `ebay_request` is the universal escape hatch — it reaches **any** eBay
endpoint (Sell, Buy, Commerce, Account, Marketing, Feed, Analytics, …), so any API-supported task is
available even without a typed tool. Write tools default to `dryRun:true`.

| Tool | What it does |
|---|---|
| `ebay_test_connection` | Mint a token and call a lightweight endpoint to confirm creds, grant type, marketplace. |
| `ebay_request` | **Universal escape hatch:** any REST call (GET/POST/PUT/DELETE) to any eBay path; writes respect `dryRun`. |
| `ebay_listing_defaults` | Show the server's baked-in listing defaults (ship-from, business policies, category, condition, duration). |
| `ebay_get_inventory_item` / `ebay_get_inventory_items` | Read one inventory item (by SKU) or a page of them. |
| `ebay_create_or_replace_inventory_item` | Create/replace an inventory item record. |
| `ebay_delete_inventory_item` | Delete an inventory item by SKU. |
| `ebay_get_offer` / `ebay_get_offers` | Read one offer (by offerId) or all offers for a SKU. |
| `ebay_create_offer` / `ebay_update_offer` | Create or update an offer (price, quantity, marketplace, policies) for a SKU. |
| `ebay_publish_offer` | Publish an offer to make the listing live. |
| `ebay_withdraw_offer` / `ebay_delete_offer` | End a published listing (withdraw), or delete an unpublished offer. |
| `ebay_bulk_update_price_quantity` | Bulk-update price and/or available quantity across many SKUs/offers (up to 25). |
| `ebay_get_inventory_locations` / `ebay_create_inventory_location` | List merchant locations, or create one (required before publishing). |
| `ebay_upload_hosted_image` | Copy an external image (Shopify CDN URL) to eBay Picture Services so it shows on **eBay Live**. |

### eBay ↔ Shopify workflow tools

Higher-level tools that span both platforms. All default to `dryRun:true` (or read-only preview).

| Tool | What it does |
|---|---|
| `ebay_bulk_list_auctions` | **Bulk:** list every product in a Shopify collection as an eBay auction — Shopify price as the start price, the product's own eBay-hosted image, auction/7-day, unique `[SKU]` titles; reports title collisions; `skipExisting` avoids duplicates. |
| `ebay_search_orders` | Search recent eBay orders by keyword (line item titles), buyer name, SKU-presence (`noSkuOnly`), and total, within a date range in the **seller's local timezone**; paginates the Fulfillment API internally, returns compact summaries. |
| `ebay_merge_sales_to_draft_orders` | Group a local day's eBay sales by buyer and create one Shopify draft order per buyer with ≥ `minOrdersToMerge` orders — SKUs resolved to variants, no-SKU listings kept as custom lines, shipping address + customer auto-linked from the eBay buyer. `priceSource:"ebay"` (default) prices each line at what was actually paid (variant lines keep their link via a price override); `closeSourceIfSynced` archives duplicate auto-synced orders; a note marker makes re-runs safe. |
| `shopify_reprice_order_lines_to_ebay` | Rewrite completed Shopify orders so each line shows the real eBay sale price (from the note's eBay order ids or `sourceEbayOrderIds`), running the whole Order-Editing cycle internally per order. `skipAlreadyFulfilledLines` (default) leaves fulfilled lines untouched (Shopify won't zero them → doubled total). `findCandidates` auto-discovers old orders to fix. |
| `shopify_resolve_skus` | Batch-resolve many SKUs (up to ~200) to variant GIDs — variant/product id, title, price, optional inventory — preserving input order, with `found`/`reason` for misses. |
| `ebay_check_listing_status` | Batch-check eBay listing status per SKU: `active` / `ended` / `unpublished` / `no_offer` / `no_inventory_item`, plus offerId, listingId, price. |
| `ebay_relist_sold_covers` | End-to-end relist: take specific SKUs (or a collection's ended covers), clear stale offer/inventory, republish, and return item numbers filtered to just the requested SKUs, with a distinct `alreadyActive` bucket. |
| `shopify_duplicate_listing_for_extra_copies` | Create N extra copies of a single-variant listing (incrementing `F2`/`F3` suffix, same image/price). `destination` is required — `ebay_only` publishes auctions without touching the catalog; `shopify_and_ebay` also creates products. |
| `ebay_sync_fulfillment_tracking` | Push tracking from shipped Shopify orders onto the matching eBay order(s) and mark them shipped. Matches by order name (the eBay order id verbatim) or, for merge-draft orders, every eBay id in the note (pushed to each). Skips no-tracking, non-eBay, and already-FULFILLED orders (idempotent). **Runs automatically every `EBAY_TRACKING_SYNC_INTERVAL_MIN` minutes** when `EBAY_TRACKING_SYNC_ENABLED=true`; this triggers it on demand. `dryRun` previews. |

### Automated auction engine

A self-hosted scheduler (`AUTO_AUCTION_ENABLED=true`) that runs **on the server** — no Claude session
required — turning your `*ebaylive*` collections into a continuously-managed auction pipeline. State
persists to a docker volume at `/data` (`mcp-data`).

- **Lists batches on a timer** from every collection whose title contains `AUTO_AUCTION_COLLECTION_MATCH`
  (default `ebaylive`), publishing top performers first.
- **No duplicate live auctions** — a SKU is relisted only after its current auction closes.
- **Ingests sold orders** (Fulfillment API), tracks per-cover-type sell-through + average sale price.
- **Adapts the start-price floor per cover type** (RM/GITD/M/F/REG) within your hard min/max bounds.
- **Standing daily no-SKU check** — flags manual/lot sales that can't auto-sync to Shopify.
- **Optional nightly LLM review** (`AUTO_AUCTION_ANTHROPIC_API_KEY`) for a strategy narrative.

Control/inspect it with these tools:

| Tool | What it does |
|---|---|
| `ebay_auction_status` | Active auctions, history, current adaptive floors, per-cover performance, last-cycle times, latest review. |
| `ebay_auction_list_now` | Trigger one listing cycle now (`dryRun` previews the selection + start prices). |
| `ebay_auction_ingest_sales` | Pull recent sold orders, mark auctions sold, reap closed ones into history. |
| `ebay_auction_review` | Recompute performance and adapt floors within bounds; optional LLM narrative. `apply=false` previews. |
| `ebay_auction_nosku_check` | Scan recent orders for no-SKU (manual/lot) sales and record findings. Runs daily automatically. |
| `ebay_auction_set_floor` | Manually set the start-price floor for a cover type (RM/GITD/M/F/REG). |

All settings are `AUTO_AUCTION_*` env vars (see `.env.example`). Start with `AUTO_AUCTION_ENABLED=false`
and a `dryRun` list to observe before going fully automatic, and set `AUTO_AUCTION_HARD_MIN_FLOORS` to
your real cost + fees so automation can't sell at a loss.


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
