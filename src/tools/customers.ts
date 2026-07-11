/**
 * Customer tools: list, get (read-only).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ShopifyClient } from "../shopify-client.js";
import { registerTool, paginationShape } from "./shared.js";
import { gidToId, toGid, markdownTable, detailLines, money, stripGids } from "../format.js";

const LIST_CUSTOMERS = /* GraphQL */ `
  query ListCustomers($first: Int!, $after: String, $query: String) {
    customers(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id displayName email numberOfOrders
        amountSpent { amount currencyCode }
      }
    }
  }
`;

const GET_CUSTOMER = /* GraphQL */ `
  query GetCustomer($id: ID!) {
    customer(id: $id) {
      id displayName email phone note tags createdAt
      numberOfOrders
      amountSpent { amount currencyCode }
      defaultAddress { name address1 address2 city province zip country phone }
    }
  }
`;

export function registerCustomerTools(server: McpServer, client: ShopifyClient): void {
  registerTool(server, client, {
    name: "shopify_list_customers",
    title: "List customers",
    description:
      "List/search customers. Returns id, name, email, order count and total spent. " +
      "Supports Shopify customer search syntax and cursor pagination.",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe('Search, e.g. "email:foo@bar.com", "country:US", or a name.'),
      ...paginationShape,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{
        customers: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<{
            id: string;
            displayName: string;
            email: string | null;
            numberOfOrders: string;
            amountSpent: { amount: string; currencyCode: string } | null;
          }>;
        };
      }>(LIST_CUSTOMERS, { first: args.first, after: args.after, query: args.query });

      const { customers } = res.data;
      const rows = customers.nodes.map((cu) => [
        gidToId(cu.id),
        cu.displayName,
        cu.email ?? "",
        cu.numberOfOrders,
        money(cu.amountSpent),
      ]);

      const markdown =
        customers.nodes.length === 0
          ? "No customers matched."
          : markdownTable(["ID", "Name", "Email", "Orders", "Spent"], rows, args.first) +
            (customers.pageInfo.hasNextPage
              ? `\n\n_More available. Pass \`after: "${customers.pageInfo.endCursor}"\` for the next page._`
              : "");

      return {
        markdown,
        structured: { customers: stripGids(customers.nodes), pageInfo: customers.pageInfo },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_get_customer",
    title: "Get customer",
    description:
      "Get a single customer including order count, lifetime total spent, tags and default address.",
    inputSchema: {
      id: z.string().describe("Customer id (numeric or GID)."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{ customer: Record<string, any> | null }>(GET_CUSTOMER, {
        id: toGid("Customer", args.id),
      });
      const customer = res.data.customer;
      if (!customer) {
        return {
          markdown: `No customer found with id ${gidToId(args.id)}.`,
          structured: { customer: null },
          cost: res.cost,
        };
      }

      const addr = customer.defaultAddress;
      const markdown =
        `### ${customer.displayName}\n\n` +
        detailLines([
          ["ID", gidToId(customer.id)],
          ["Email", customer.email],
          ["Phone", customer.phone],
          ["Orders", customer.numberOfOrders],
          ["Total spent", money(customer.amountSpent)],
          ["Tags", (customer.tags ?? []).join(", ")],
          ["Default address", addr
            ? [addr.address1, addr.city, addr.province, addr.zip, addr.country]
                .filter(Boolean)
                .join(", ")
            : ""],
        ]);

      return {
        markdown,
        structured: { customer: stripGids(customer) },
        cost: res.cost,
      };
    },
  });
}
