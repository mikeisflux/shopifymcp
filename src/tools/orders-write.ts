/**
 * Order write tools: update, cancel, close/open, mark-as-paid, fulfill,
 * update fulfillment tracking, and create refund.
 *
 * Mutation shapes are pinned to Admin GraphQL 2025-07+ (this server targets
 * 2026-04): orderCancel uses `refundMethod` (the old `refund: Boolean` is
 * deprecated) and returns `orderCancelUserErrors`; fulfillment uses the
 * fulfillment-order model via `fulfillmentCreate`.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ShopifyClient, assertNoUserErrors } from "../shopify-client.js";
import { registerTool } from "./shared.js";
import { gidToId, toGid, detailLines, stripGids } from "../format.js";

const UPDATE_ORDER = /* GraphQL */ `
  mutation UpdateOrder($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { id name note tags email poNumber }
      userErrors { field message }
    }
  }
`;

const CANCEL_ORDER = /* GraphQL */ `
  mutation CancelOrder(
    $orderId: ID!
    $notifyCustomer: Boolean
    $refundMethod: OrderCancelRefundMethodInput!
    $restock: Boolean!
    $reason: OrderCancelReason!
    $staffNote: String
  ) {
    orderCancel(
      orderId: $orderId
      notifyCustomer: $notifyCustomer
      refundMethod: $refundMethod
      restock: $restock
      reason: $reason
      staffNote: $staffNote
    ) {
      job { id done }
      orderCancelUserErrors { field message code }
    }
  }
`;

const CLOSE_ORDER = /* GraphQL */ `
  mutation CloseOrder($input: OrderCloseInput!) {
    orderClose(input: $input) {
      order { id name closed closedAt displayFulfillmentStatus }
      userErrors { field message }
    }
  }
`;

const OPEN_ORDER = /* GraphQL */ `
  mutation OpenOrder($input: OrderOpenInput!) {
    orderOpen(input: $input) {
      order { id name closed displayFulfillmentStatus }
      userErrors { field message }
    }
  }
`;

const MARK_ORDER_PAID = /* GraphQL */ `
  mutation MarkOrderPaid($input: OrderMarkAsPaidInput!) {
    orderMarkAsPaid(input: $input) {
      order { id name displayFinancialStatus }
      userErrors { field message }
    }
  }
`;

const ORDER_FULFILLMENT_ORDERS = /* GraphQL */ `
  query OrderFulfillmentOrders($id: ID!) {
    order(id: $id) {
      id name
      fulfillmentOrders(first: 50) {
        nodes { id status }
      }
    }
  }
`;

const CREATE_FULFILLMENT = /* GraphQL */ `
  mutation CreateFulfillment($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment {
        id status
        trackingInfo { number company url }
      }
      userErrors { field message }
    }
  }
`;

const UPDATE_FULFILLMENT_TRACKING = /* GraphQL */ `
  mutation UpdateFulfillmentTracking(
    $fulfillmentId: ID!
    $trackingInfoInput: FulfillmentTrackingInput!
    $notifyCustomer: Boolean
  ) {
    fulfillmentTrackingInfoUpdate(
      fulfillmentId: $fulfillmentId
      trackingInfoInput: $trackingInfoInput
      notifyCustomer: $notifyCustomer
    ) {
      fulfillment {
        id status
        trackingInfo { number company url }
      }
      userErrors { field message }
    }
  }
`;

const CREATE_REFUND = /* GraphQL */ `
  mutation CreateRefund($input: RefundInput!) {
    refundCreate(input: $input) {
      refund {
        id note
        totalRefundedSet { shopMoney { amount currencyCode } }
      }
      order { id name displayFinancialStatus }
      userErrors { field message }
    }
  }
`;

/** userErrors as returned by the standard mutation payloads. */
type UserError = { field?: string[] | null; message: string };

export function registerOrderWriteTools(server: McpServer, client: ShopifyClient): void {
  registerTool(server, client, {
    name: "shopify_update_order",
    title: "Update order",
    description:
      "Update editable order attributes: the note, tags, customer email, and purchase-order (PO) " +
      "number. Only the fields you provide are changed. `tags` replaces the full tag list.",
    inputSchema: {
      id: z.string().describe("Order id (numeric or GID)."),
      note: z.string().optional().describe("New note text for the order."),
      tags: z.array(z.string()).optional().describe("Replaces the full tag list on the order."),
      email: z.string().optional().describe("New customer email address for the order."),
      poNumber: z.string().optional().describe("New purchase order (PO) number for the order."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const input: Record<string, unknown> = { id: toGid("Order", args.id) };
      if (args.note !== undefined) input.note = args.note;
      if (args.tags !== undefined) input.tags = args.tags;
      if (args.email !== undefined) input.email = args.email;
      if (args.poNumber !== undefined) input.poNumber = args.poNumber;

      const res = await c.request<{
        orderUpdate: {
          order: {
            id: string;
            name: string;
            note: string | null;
            tags: string[];
            email: string | null;
            poNumber: string | null;
          } | null;
          userErrors: UserError[];
        };
      }>(UPDATE_ORDER, { input });
      assertNoUserErrors(res.data.orderUpdate.userErrors);
      const order = res.data.orderUpdate.order;
      return {
        markdown: order
          ? `Updated order **${order.name}** (id ${gidToId(order.id)}).\n\n` +
            detailLines([
              ["Note", order.note],
              ["Tags", order.tags.join(", ")],
              ["Email", order.email],
              ["PO number", order.poNumber],
            ])
          : "Order updated.",
        structured: { order: order ? stripGids(order) : null },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_cancel_order",
    title: "Cancel order",
    description:
      "Cancel an order. Optionally refund to the original payment method(s), restock inventory, and " +
      "notify the customer. A reason is required. Cancellation is irreversible and runs asynchronously " +
      "(a job id is returned).",
    inputSchema: {
      id: z.string().describe("Order id (numeric or GID)."),
      reason: z
        .enum(["CUSTOMER", "DECLINED", "FRAUD", "INVENTORY", "OTHER", "STAFF"])
        .describe("Reason for the cancellation."),
      refund: z
        .boolean()
        .default(true)
        .describe("Refund the order to its original payment method(s). Defaults to true."),
      restock: z
        .boolean()
        .default(true)
        .describe("Restock the order's line items back into inventory. Defaults to true."),
      notifyCustomer: z
        .boolean()
        .optional()
        .describe("Send the customer a cancellation notification email."),
      staffNote: z.string().optional().describe("Merchant-facing staff note explaining the cancellation."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    handler: async (args, c) => {
      const res = await c.request<{
        orderCancel: {
          job: { id: string; done: boolean } | null;
          orderCancelUserErrors: Array<{ field?: string[] | null; message: string; code?: string | null }>;
        };
      }>(CANCEL_ORDER, {
        orderId: toGid("Order", args.id),
        notifyCustomer: args.notifyCustomer,
        refundMethod: { originalPaymentMethodsRefund: args.refund },
        restock: args.restock,
        reason: args.reason,
        staffNote: args.staffNote,
      });
      assertNoUserErrors(res.data.orderCancel.orderCancelUserErrors);
      const job = res.data.orderCancel.job;
      return {
        markdown:
          `Cancellation requested for order ${gidToId(args.id)} (reason ${args.reason}; ` +
          `refund ${args.refund}, restock ${args.restock}). ` +
          (job
            ? `Shopify is processing it asynchronously (job ${gidToId(job.id)}, done: ${job.done}).`
            : "Shopify is processing it asynchronously."),
        structured: { job: job ? stripGids(job) : null },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_close_order",
    title: "Close order",
    description:
      "Mark an open order as closed (archived). Closing does not cancel, fulfill, or refund — it just " +
      "removes the order from the open queue. Use shopify_reopen_order to undo.",
    inputSchema: {
      id: z.string().describe("Order id (numeric or GID)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{
        orderClose: {
          order: {
            id: string;
            name: string;
            closed: boolean;
            closedAt: string | null;
            displayFulfillmentStatus: string | null;
          } | null;
          userErrors: UserError[];
        };
      }>(CLOSE_ORDER, { input: { id: toGid("Order", args.id) } });
      assertNoUserErrors(res.data.orderClose.userErrors);
      const order = res.data.orderClose.order;
      return {
        markdown: order
          ? `Closed order **${order.name}** (id ${gidToId(order.id)})${order.closedAt ? ` at ${order.closedAt}` : ""}.`
          : `Closed order ${gidToId(args.id)}.`,
        structured: { order: order ? stripGids(order) : null },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_reopen_order",
    title: "Reopen order",
    description: "Reopen a previously closed order, returning it to the open queue.",
    inputSchema: {
      id: z.string().describe("Order id (numeric or GID)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{
        orderOpen: {
          order: {
            id: string;
            name: string;
            closed: boolean;
            displayFulfillmentStatus: string | null;
          } | null;
          userErrors: UserError[];
        };
      }>(OPEN_ORDER, { input: { id: toGid("Order", args.id) } });
      assertNoUserErrors(res.data.orderOpen.userErrors);
      const order = res.data.orderOpen.order;
      return {
        markdown: order
          ? `Reopened order **${order.name}** (id ${gidToId(order.id)}).`
          : `Reopened order ${gidToId(args.id)}.`,
        structured: { order: order ? stripGids(order) : null },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_mark_order_paid",
    title: "Mark order as paid",
    description:
      "Record a payment for the order's outstanding balance, marking it as paid. Only works when the " +
      "order has a positive outstanding balance and is not already PAID.",
    inputSchema: {
      id: z.string().describe("Order id (numeric or GID)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{
        orderMarkAsPaid: {
          order: { id: string; name: string; displayFinancialStatus: string | null } | null;
          userErrors: UserError[];
        };
      }>(MARK_ORDER_PAID, { input: { id: toGid("Order", args.id) } });
      assertNoUserErrors(res.data.orderMarkAsPaid.userErrors);
      const order = res.data.orderMarkAsPaid.order;
      return {
        markdown: order
          ? `Marked order **${order.name}** (id ${gidToId(order.id)}) as paid ` +
            `(financial status: ${order.displayFinancialStatus ?? "?"}).`
          : `Marked order ${gidToId(args.id)} as paid.`,
        structured: { order: order ? stripGids(order) : null },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_fulfill_order",
    title: "Fulfill order",
    description:
      "Fulfill an order's open/in-progress fulfillment order(s) in one call, optionally attaching " +
      "tracking info. This fulfills ALL remaining items across those fulfillment orders. Provide " +
      "tracking number/company/URL to record shipment tracking. By default the customer is NOT notified.",
    inputSchema: {
      orderId: z.string().describe("Order id (numeric or GID)."),
      trackingNumber: z.string().optional().describe("Shipment tracking number."),
      trackingCompany: z
        .string()
        .optional()
        .describe('Carrier name, e.g. "UPS". A supported carrier lets Shopify auto-generate the tracking URL.'),
      trackingUrl: z.string().optional().describe("Tracking URL (overrides the auto-generated one)."),
      notifyCustomer: z
        .boolean()
        .default(false)
        .describe("Send the customer a shipment notification email. Defaults to false."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (args, c) => {
      const orderGid = toGid("Order", args.orderId);

      const foRes = await c.request<{
        order: {
          id: string;
          name: string;
          fulfillmentOrders: { nodes: Array<{ id: string; status: string }> };
        } | null;
      }>(ORDER_FULFILLMENT_ORDERS, { id: orderGid });

      if (!foRes.data.order) {
        return {
          markdown: `No order found with id ${gidToId(args.orderId)}.`,
          structured: { order: null },
          cost: foRes.cost,
        };
      }

      const openOrders = foRes.data.order.fulfillmentOrders.nodes.filter(
        (fo) => fo.status === "OPEN" || fo.status === "IN_PROGRESS",
      );
      if (openOrders.length === 0) {
        return {
          markdown: `Order ${foRes.data.order.name} has no open fulfillment orders to fulfill.`,
          structured: { order: gidToId(foRes.data.order.id), fulfilled: 0 },
          cost: foRes.cost,
        };
      }

      const trackingInfo: Record<string, unknown> = {};
      if (args.trackingNumber !== undefined) trackingInfo.number = args.trackingNumber;
      if (args.trackingCompany !== undefined) trackingInfo.company = args.trackingCompany;
      if (args.trackingUrl !== undefined) trackingInfo.url = args.trackingUrl;

      const fulfillment: Record<string, unknown> = {
        lineItemsByFulfillmentOrder: openOrders.map((fo) => ({ fulfillmentOrderId: fo.id })),
        notifyCustomer: args.notifyCustomer,
      };
      if (Object.keys(trackingInfo).length > 0) fulfillment.trackingInfo = trackingInfo;

      const res = await c.request<{
        fulfillmentCreate: {
          fulfillment: {
            id: string;
            status: string;
            trackingInfo: Array<{ number: string | null; company: string | null; url: string | null }>;
          } | null;
          userErrors: UserError[];
        };
      }>(CREATE_FULFILLMENT, { fulfillment });
      assertNoUserErrors(res.data.fulfillmentCreate.userErrors);
      const f = res.data.fulfillmentCreate.fulfillment;
      return {
        markdown: f
          ? `Fulfilled order ${foRes.data.order.name} across ${openOrders.length} fulfillment order(s). ` +
            `Fulfillment ${gidToId(f.id)} status: ${f.status}.` +
            (Object.keys(trackingInfo).length
              ? ` Tracking: ${[args.trackingCompany, args.trackingNumber].filter(Boolean).join(" ")}.`
              : "")
          : `Fulfillment created for order ${foRes.data.order.name}.`,
        structured: { fulfillment: f ? stripGids(f) : null },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_update_fulfillment_tracking",
    title: "Update fulfillment tracking",
    description:
      "Update (or add) tracking information on an existing fulfillment: tracking number, carrier " +
      "company, and/or URL. Get fulfillment ids from shopify_get_order. Optionally notify the customer.",
    inputSchema: {
      fulfillmentId: z.string().describe("Fulfillment id (numeric or GID) — from shopify_get_order."),
      trackingNumber: z.string().optional().describe("Shipment tracking number."),
      trackingCompany: z
        .string()
        .optional()
        .describe('Carrier name, e.g. "UPS". A supported carrier lets Shopify auto-generate the tracking URL.'),
      trackingUrl: z.string().optional().describe("Tracking URL (overrides the auto-generated one)."),
      notifyCustomer: z
        .boolean()
        .default(false)
        .describe("Notify the customer of this tracking update. Defaults to false."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const trackingInfoInput: Record<string, unknown> = {};
      if (args.trackingNumber !== undefined) trackingInfoInput.number = args.trackingNumber;
      if (args.trackingCompany !== undefined) trackingInfoInput.company = args.trackingCompany;
      if (args.trackingUrl !== undefined) trackingInfoInput.url = args.trackingUrl;
      if (Object.keys(trackingInfoInput).length === 0) {
        throw new Error("Provide at least one of trackingNumber, trackingCompany, or trackingUrl.");
      }

      const res = await c.request<{
        fulfillmentTrackingInfoUpdate: {
          fulfillment: {
            id: string;
            status: string;
            trackingInfo: Array<{ number: string | null; company: string | null; url: string | null }>;
          } | null;
          userErrors: UserError[];
        };
      }>(UPDATE_FULFILLMENT_TRACKING, {
        fulfillmentId: toGid("Fulfillment", args.fulfillmentId),
        trackingInfoInput,
        notifyCustomer: args.notifyCustomer,
      });
      assertNoUserErrors(res.data.fulfillmentTrackingInfoUpdate.userErrors);
      const f = res.data.fulfillmentTrackingInfoUpdate.fulfillment;
      const tracking = (f?.trackingInfo ?? [])
        .map((t) => [t.company, t.number].filter(Boolean).join(" "))
        .filter(Boolean)
        .join(", ");
      return {
        markdown: f
          ? `Updated tracking on fulfillment ${gidToId(f.id)} (status ${f.status})${tracking ? `: ${tracking}` : ""}.`
          : `Updated tracking on fulfillment ${gidToId(args.fulfillmentId)}.`,
        structured: { fulfillment: f ? stripGids(f) : null },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_create_refund",
    title: "Create refund",
    description:
      "Create a refund on an order for specific line items (with optional restocking) and/or a note. " +
      "Each refund line item needs the order's line-item id (from shopify_get_order) and a quantity. " +
      "Note: this does not take a shipping-refund amount or explicit payment transactions — Shopify " +
      "calculates the refund from the line items; use the Shopify admin for partial-transaction or " +
      "shipping-only refunds.",
    inputSchema: {
      orderId: z.string().describe("Order id (numeric or GID)."),
      note: z.string().optional().describe("Reason/note stored on the refund."),
      notify: z.boolean().optional().describe("Send the customer a refund notification."),
      refundLineItems: z
        .array(
          z.object({
            lineItemId: z.string().describe("Order line item id (numeric or GID) — from shopify_get_order."),
            quantity: z.number().int().min(1).describe("Quantity of this line item to refund."),
            restockType: z
              .enum(["NO_RESTOCK", "CANCEL", "RETURN"])
              .optional()
              .describe("How to restock: RETURN or CANCEL to restock, NO_RESTOCK to leave inventory unchanged."),
          }),
        )
        .optional()
        .describe("Line items to refund. Omit to create a refund with only a note (no line items)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (args, c) => {
      const input: Record<string, unknown> = { orderId: toGid("Order", args.orderId) };
      if (args.note !== undefined) input.note = args.note;
      if (args.notify !== undefined) input.notify = args.notify;
      if (args.refundLineItems !== undefined) {
        input.refundLineItems = args.refundLineItems.map((li) => {
          const out: Record<string, unknown> = {
            lineItemId: toGid("LineItem", li.lineItemId),
            quantity: li.quantity,
          };
          if (li.restockType !== undefined) out.restockType = li.restockType;
          return out;
        });
      }

      const res = await c.request<{
        refundCreate: {
          refund: {
            id: string;
            note: string | null;
            totalRefundedSet: { shopMoney: { amount: string; currencyCode: string } } | null;
          } | null;
          order: { id: string; name: string; displayFinancialStatus: string | null } | null;
          userErrors: UserError[];
        };
      }>(CREATE_REFUND, { input });
      assertNoUserErrors(res.data.refundCreate.userErrors);
      const refund = res.data.refundCreate.refund;
      const order = res.data.refundCreate.order;
      const total = refund?.totalRefundedSet?.shopMoney;
      return {
        markdown: refund
          ? `Created refund ${gidToId(refund.id)} on order ${order?.name ?? gidToId(args.orderId)}` +
            (total ? ` for ${total.amount} ${total.currencyCode}` : "") +
            (order?.displayFinancialStatus ? ` (financial status: ${order.displayFinancialStatus})` : "") +
            "."
          : `Refund created on order ${gidToId(args.orderId)}.`,
        structured: {
          refund: refund ? stripGids(refund) : null,
          order: order ? stripGids(order) : null,
        },
        cost: res.cost,
      };
    },
  });
}
