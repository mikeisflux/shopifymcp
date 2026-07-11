# Shopify Admin MCP Server — Build Spec

**Target:** Self-hosted MCP server exposing the Shopify Admin API, running as a Docker container on a NAS, connected to Claude (claude.ai / Claude Desktop) as a custom connector.

**Audience:** Claude Code. Build everything in this spec. Ask before deviating on security items.

---

## 1. Overview

Build a TypeScript MCP server using the official `@modelcontextprotocol/sdk` that wraps the **Shopify Admin GraphQL API** (do NOT use the REST Admin API — it's legacy). Transport is **Streamable HTTP, stateless JSON** (no SSE sessions), so it scales trivially and works behind reverse proxies.

Before writing code, fetch and follow:
- MCP spec sitemap: `https://modelcontextprotocol.io/sitemap.xml` (streamable HTTP transport page in particular)
- TypeScript SDK README: `https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/README.md`
- Shopify Admin GraphQL docs: `https://shopify.dev/docs/api/admin-graphql` (pin to the latest stable API version and put it in an env var, e.g. `SHOPIFY_API_VERSION=2026-04`)

## 2. Shopify auth (manual step — document in README, don't automate)

1. Shopify admin → Settings → Apps and sales channels → Develop apps → Create app ("Claude MCP").
2. Configure Admin API scopes (see §5 for read vs write).
3. Install app, reveal the **Admin API access token** (`shpat_...`). This goes in `.env`, never in the image or repo.
4. All requests: `POST https://{SHOPIFY_STORE_DOMAIN}/admin/api/{SHOPIFY_API_VERSION}/graphql.json` with header `X-Shopify-Access-Token`.

## 3. Server auth (protecting the MCP endpoint)

The endpoint will be exposed to the internet so claude.ai can reach it. Two layers, both required:

1. **Secret path segment:** serve MCP at `/mcp/{MCP_PATH_SECRET}` where `MCP_PATH_SECRET` is a 32+ char random string from env. Return 404 on anything else.
2. **Bearer token check:** require `Authorization: Bearer {MCP_AUTH_TOKEN}` if `MCP_AUTH_TOKEN` is set. Make it optional via env so it can be disabled for clients that can't send headers, leaving layer 1.

No OAuth for v1. Keep it simple.

## 4. Exposure (NAS is behind LAN)

Claude.ai custom connectors need a public HTTPS URL. Implement/document **Cloudflare Tunnel** as the primary path:

- Add a `cloudflared` service to docker-compose using `cloudflare/cloudflared:latest`, `tunnel run` with `TUNNEL_TOKEN` from env.
- Route `mcp.{mydomain}` → `http://shopify-mcp:3000` inside the compose network.
- No ports published to the LAN except optionally `3000` for local testing.

Document in README the alternative: reverse-proxying from an existing external server (Nginx on Hetzner) over WireGuard/Tailscale to the NAS. Don't implement it, just describe it in a short section.

## 5. Tools

Prefix everything `shopify_`. Comprehensive coverage of common admin operations. Every tool: Zod input schema with descriptions and examples, concise tool description, pagination support (`first`/`after` cursor passthrough, default page size 25, max 100), and annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`).

**Read tools (always enabled):**

| Tool | Notes |
|---|---|
| `shopify_list_products` | filter by query string, status, collection; return id, title, status, handle, variant count, price range |
| `shopify_get_product` | full product incl. variants, SKUs, inventory quantities, metafields |
| `shopify_list_orders` | filter by status, financial_status, fulfillment_status, created_at range, query |
| `shopify_get_order` | line items w/ SKUs, shipping address, fulfillments, transactions summary |
| `shopify_list_customers` | search query support |
| `shopify_get_customer` | incl. order count, total spent, default address |
| `shopify_list_draft_orders` | status filter |
| `shopify_get_draft_order` | |
| `shopify_list_collections` | smart + custom |
| `shopify_get_inventory_levels` | by SKU or inventory item, across locations |
| `shopify_search` | generic GraphQL query search across resource types if trivial; otherwise skip |
| `shopify_graphql_query` | escape hatch: run an arbitrary **read-only** GraphQL query (reject strings containing `mutation`) |

**Write tools (only registered when `ENABLE_WRITES=true`):**

| Tool | Notes |
|---|---|
| `shopify_create_product` | |
| `shopify_update_product` | partial updates |
| `shopify_update_variant` | price, SKU, inventory policy |
| `shopify_adjust_inventory` | delta adjust at a location |
| `shopify_create_draft_order` | line items by variant id or SKU, customer, shipping, discount |
| `shopify_complete_draft_order` | |
| `shopify_create_discount_code` | basic code discount |
| `shopify_tag_resource` | add/remove tags on products/orders/customers |

No delete tools in v1.

**Responses:** return Markdown-formatted text content for human readability plus `structuredContent` with the raw shaped data. Truncate long lists and say so. Convert Shopify GID strings (`gid://shopify/Product/123`) to plain numeric IDs in output, accept either in input.

**Errors:** actionable messages. Surface Shopify `userErrors` verbatim. On 429, respect `Retry-After` and retry once with backoff before failing. On scope errors, tell the agent which access scope is missing.

## 6. Project structure

```
shopify-mcp/
├── src/
│   ├── index.ts            # express app, transport, auth middleware
│   ├── shopify-client.ts   # GraphQL client, retries, cost handling
│   ├── tools/
│   │   ├── products.ts
│   │   ├── orders.ts
│   │   ├── customers.ts
│   │   ├── inventory.ts
│   │   ├── draft-orders.ts
│   │   └── misc.ts         # collections, discounts, tags, graphql escape hatch
│   └── format.ts           # markdown/structured formatting, GID helpers
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

## 7. Environment variables

```
SHOPIFY_STORE_DOMAIN=yourstore.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_xxx
SHOPIFY_API_VERSION=2026-04
MCP_PATH_SECRET=<random 32+ chars>
MCP_AUTH_TOKEN=            # optional bearer token
ENABLE_WRITES=false
PORT=3000
LOG_LEVEL=info
TUNNEL_TOKEN=              # cloudflared, compose only
```

Validate all required env at startup; exit with a clear message if missing.

## 8. Docker

**Dockerfile:** multi-stage (`node:22-alpine` build → runtime), `npm ci`, compile TS, prune dev deps, run as non-root `node` user, `HEALTHCHECK` hitting `GET /healthz` (unauthenticated, returns 200 + version, no store info).

**docker-compose.yml:** services `shopify-mcp` and `cloudflared`, shared network, `restart: unless-stopped`, `env_file: .env`, memory limit 256M, log rotation (`max-size: 10m`, `max-file: 3`). Comment the `ports:` mapping out by default (tunnel handles ingress).

NAS notes for README: works on any NAS with Docker/Container Manager (Synology/QNAP/Unraid); deploy by dropping the folder and running `docker compose up -d --build`, or build the image elsewhere and `docker save`/`load` if the NAS can't build.

## 9. Logging

Structured JSON logs to stdout: timestamp, tool name, duration, Shopify query cost, success/error. **Never log the access token, auth token, or full customer PII.** Log order/customer IDs, not names/emails/addresses.

## 10. Testing & acceptance

1. `npm run build` passes clean; strict tsconfig.
2. Test with MCP Inspector (`npx @modelcontextprotocol/inspector`) against local container: tools list correctly, a product list call round-trips.
3. `curl` the endpoint without the secret path → 404; without bearer (when set) → 401; `/healthz` → 200.
4. With `ENABLE_WRITES=false`, write tools do not appear in tools/list.
5. `shopify_graphql_query` rejects mutations.
6. README covers: Shopify custom app setup, .env, compose up, Cloudflare Tunnel setup, adding the connector in claude.ai (Settings → Connectors → Add custom connector → paste `https://mcp.{domain}/mcp/{secret}`), and the Hetzner reverse-proxy alternative.

## 11. Out of scope (v1)

OAuth, multi-store support, webhooks, delete operations, theme/content editing, storefront API, metrics dashboard.
