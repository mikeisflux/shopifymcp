/**
 * Order tools: list, get (read-only). Order mutations are out of scope for v1.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ShopifyClient } from "../shopify-client.js";
import { registerTool, paginationShape } from "./shared.js";
import { gidToId, toGid, markdownTable, detailLines, money, stripGids } from "../format.js";

/** Builds an order search query from the individual filter fields. */
function buildOrderQuery(args: {
  query?: string;
  status?: string;
  financialStatus?: string;
  fulfillmentStatus?: string;
  createdAtMin?: string;
  createdAtMax?: string;
}): string | undefined {
  const parts: string[] = [];
  if (args.query?.trim()) parts.push(args.query.trim());
  if (args.status) parts.push(`status:${args.status.toLowerCase()}`);
  if (args.financialStatus) parts.push(`financial_status:${args.financialStatus.toLowerCase()}`);
  if (args.fulfillmentStatus) parts.push(`fulfillment_status:${args.fulfillmentStatus.toLowerCase()}`);
  if (args.createdAtMin) parts.push(`created_at:>=${args.createdAtMin}`);
  if (args.createdAtMax) parts.push(`created_at:<=${args.createdAtMax}`);
  return parts.length ? parts.join(" ") : undefined;
}

const LIST_ORDERS = /* GraphQL */ `
  query ListOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id name createdAt displayFinancialStatus displayFulfillmentStatus
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        customer { id displayName }
      }
    }
  }
`;

const GET_ORDER = /* GraphQL */ `
  query GetOrder($id: ID!) {
    order(id: $id) {
      id name createdAt processedAt note
      displayFinancialStatus displayFulfillmentStatus
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      totalShippingPriceSet { shopMoney { amount currencyCode } }
      totalTaxSet { shopMoney { amount currencyCode } }
      customer { id displayName numberOfOrders }
      shippingAddress { name address1 address2 city province zip country phone }
      lineItems(first: 100) {
        nodes {
          title quantity sku
          variant { id }
          originalUnitPriceSet { shopMoney { amount currencyCode } }
        }
      }
      fulfillments(first: 25) {
        status
        trackingInfo { number company url }
      }
      transactions {
        kind status gateway
        amountSet { shopMoney { amount currencyCode } }
      }
    }
  }
`;

interface ShopMoney {
  shopMoney: { amount: string; currencyCode: string };
}

export function registerOrderTools(server: McpServer, client: ShopifyClient): void {
  registerTool(server, client, {
    name: "shopify_list_orders",
    title: "List orders",
    description:
      "List orders filtered by status, financial status, fulfillment status, a created-at date " +
      "range, and/or a free-text query. Returns a summary row per order. Supports pagination.",
    inputSchema: {
      query: z.string().optional().describe('Free-text search, e.g. "email:foo@bar.com" or an order name like "#1001".'),
      status: z.enum(["OPEN", "CLOSED", "CANCELLED", "ANY"]).optional().describe("Order status."),
      financialStatus: z
        .enum(["PAID", "PENDING", "REFUNDED", "PARTIALLY_REFUNDED", "PARTIALLY_PAID", "VOIDED", "AUTHORIZED"])
        .optional(),
      fulfillmentStatus: z
        .enum(["FULFILLED", "UNFULFILLED", "PARTIAL", "RESTOCKED"])
        .optional(),
      createdAtMin: z.string().optional().describe("ISO date/datetime lower bound, e.g. 2026-01-01."),
      createdAtMax: z.string().optional().describe("ISO date/datetime upper bound, e.g. 2026-06-30."),
      ...paginationShape,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{
        orders: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<{
            id: string;
            name: string;
            createdAt: string;
            displayFinancialStatus: string | null;
            displayFulfillmentStatus: string | null;
            currentTotalPriceSet: ShopMoney | null;
            customer: { id: string; displayName: string } | null;
          }>;
        };
      }>(LIST_ORDERS, { first: args.first, after: args.after, query: buildOrderQuery(args) });

      const { orders } = res.data;
      const rows = orders.nodes.map((o) => [
        gidToId(o.id),
        o.name,
        o.createdAt.slice(0, 10),
        o.displayFinancialStatus ?? "",
        o.displayFulfillmentStatus ?? "",
        money(o.currentTotalPriceSet?.shopMoney),
        o.customer?.displayName ?? "",
      ]);

      const markdown =
        orders.nodes.length === 0
          ? "No orders matched."
          : markdownTable(
              ["ID", "Order", "Created", "Financial", "Fulfillment", "Total", "Customer"],
              rows,
              args.first,
            ) +
            (orders.pageInfo.hasNextPage
              ? `\n\n_More available. Pass \`after: "${orders.pageInfo.endCursor}"\` for the next page._`
              : "");

      return {
        markdown,
        structured: { orders: stripGids(orders.nodes), pageInfo: orders.pageInfo },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_get_order",
    title: "Get order",
    description:
      "Get a single order with line items (incl. SKUs), shipping address, fulfillments with " +
      "tracking, and a transactions summary.",
    inputSchema: {
      id: z.string().describe("Order id (numeric or GID)."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{ order: Record<string, any> | null }>(GET_ORDER, {
        id: toGid("Order", args.id),
      });
      const order = res.data.order;
      if (!order) {
        return {
          markdown: `No order found with id ${gidToId(args.id)}.`,
          structured: { order: null },
          cost: res.cost,
        };
      }

      const header = detailLines([
        ["Order", order.name],
        ["ID", gidToId(order.id)],
        ["Created", order.createdAt],
        ["Financial", order.displayFinancialStatus],
        ["Fulfillment", order.displayFulfillmentStatus],
        ["Total", money(order.currentTotalPriceSet?.shopMoney)],
        ["Shipping", money(order.totalShippingPriceSet?.shopMoney)],
        ["Tax", money(order.totalTaxSet?.shopMoney)],
        ["Customer", order.customer?.displayName],
      ]);

      const lineRows = (order.lineItems?.nodes ?? []).map((li: any) => [
        li.title,
        li.sku ?? "",
        li.quantity,
        money(li.originalUnitPriceSet?.shopMoney),
      ]);
      const lineTable = markdownTable(["Item", "SKU", "Qty", "Unit price"], lineRows);

      const ship = order.shippingAddress;
      const shipBlock = ship
        ? "\n\n**Shipping address**\n\n" +
          detailLines([
            ["Name", ship.name],
            ["Address", [ship.address1, ship.address2].filter(Boolean).join(", ")],
            ["City", [ship.city, ship.province, ship.zip].filter(Boolean).join(" ")],
            ["Country", ship.country],
          ])
        : "";

      const fulfills = order.fulfillments ?? [];
      const fulfillBlock = fulfills.length
        ? "\n\n**Fulfillments**\n\n" +
          fulfills
            .map((f: any) => {
              const tracking = (f.trackingInfo ?? [])
                .map((t: any) => [t.company, t.number].filter(Boolean).join(" "))
                .filter(Boolean)
                .join(", ");
              return `- ${f.status}${tracking ? ` — ${tracking}` : ""}`;
            })
            .join("\n")
        : "";

      const txns = order.transactions ?? [];
      const txnBlock = txns.length
        ? "\n\n**Transactions**\n\n" +
          markdownTable(
            ["Kind", "Status", "Gateway", "Amount"],
            txns.map((t: any) => [t.kind, t.status, t.gateway, money(t.amountSet?.shopMoney)]),
          )
        : "";

      return {
        markdown: `### Order ${order.name}\n\n${header}\n\n**Line items**\n\n${lineTable}${shipBlock}${fulfillBlock}${txnBlock}`,
        structured: { order: stripGids(order) },
        cost: res.cost,
      };
    },
  });
}
