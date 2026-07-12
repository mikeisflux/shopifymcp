/**
 * Extra commerce tools:
 *   read  — list_discounts
 *   write — create_automatic_discount, deactivate_discount, create_gift_card,
 *           create_product_option, delete_product_option
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ShopifyClient, assertNoUserErrors } from "../shopify-client.js";
import { registerTool, paginationShape } from "./shared.js";
import { gidToId, toGid, markdownTable, stripGids, money } from "../format.js";

// ─── Discounts ───────────────────────────────────────────────────────────────

const LIST_DISCOUNTS = /* GraphQL */ `
  query ListDiscounts($first: Int!, $after: String) {
    discountNodes(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        discount {
          __typename
          ... on DiscountCodeBasic {
            title
            status
            codes(first: 1) { nodes { code } }
          }
          ... on DiscountAutomaticBasic {
            title
            status
          }
        }
      }
    }
  }
`;

const CREATE_AUTOMATIC_DISCOUNT = /* GraphQL */ `
  mutation CreateAutomaticDiscount($automaticBasicDiscount: DiscountAutomaticBasicInput!) {
    discountAutomaticBasicCreate(automaticBasicDiscount: $automaticBasicDiscount) {
      automaticDiscountNode {
        id
        automaticDiscount {
          ... on DiscountAutomaticBasic {
            title
            status
            startsAt
            endsAt
          }
        }
      }
      userErrors { field message }
    }
  }
`;

const DEACTIVATE_CODE_DISCOUNT = /* GraphQL */ `
  mutation DeactivateCodeDiscount($id: ID!) {
    discountCodeDeactivate(id: $id) {
      codeDiscountNode { id }
      userErrors { field message }
    }
  }
`;

const DEACTIVATE_AUTOMATIC_DISCOUNT = /* GraphQL */ `
  mutation DeactivateAutomaticDiscount($id: ID!) {
    discountAutomaticDeactivate(id: $id) {
      automaticDiscountNode { id }
      userErrors { field message }
    }
  }
`;

// ─── Gift cards ──────────────────────────────────────────────────────────────

const CREATE_GIFT_CARD = /* GraphQL */ `
  mutation CreateGiftCard($input: GiftCardCreateInput!) {
    giftCardCreate(input: $input) {
      giftCard {
        id
        lastCharacters
        balance { amount currencyCode }
      }
      giftCardCode
      userErrors { field message }
    }
  }
`;

// ─── Product options ─────────────────────────────────────────────────────────

const CREATE_PRODUCT_OPTION = /* GraphQL */ `
  mutation CreateProductOption(
    $productId: ID!
    $options: [OptionCreateInput!]!
    $variantStrategy: ProductOptionCreateVariantStrategy
  ) {
    productOptionsCreate(productId: $productId, options: $options, variantStrategy: $variantStrategy) {
      product { id }
      userErrors { field message }
    }
  }
`;

const DELETE_PRODUCT_OPTION = /* GraphQL */ `
  mutation DeleteProductOption($productId: ID!, $options: [ID!]!, $strategy: ProductOptionDeleteStrategy) {
    productOptionsDelete(productId: $productId, options: $options, strategy: $strategy) {
      deletedOptionsIds
      product { id }
      userErrors { field message }
    }
  }
`;

export function registerCommerceExtraReadTools(server: McpServer, client: ShopifyClient): void {
  registerTool(server, client, {
    name: "shopify_list_discounts",
    title: "List discounts",
    description:
      "List discounts (both code and automatic). Returns id, type (code/automatic), title, status, " +
      "and — for code discounts — the discount code. Requires the read_discounts scope.",
    inputSchema: {
      ...paginationShape,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const res = await c.request<{
        discountNodes: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<{
            id: string;
            discount: {
              __typename: string;
              title?: string;
              status?: string;
              codes?: { nodes: Array<{ code: string }> };
            } | null;
          }>;
        };
      }>(LIST_DISCOUNTS, { first: args.first, after: args.after });

      const { discountNodes } = res.data;
      const isCode = (typename: string | undefined): boolean =>
        typename === "DiscountCodeBasic";

      const rows = discountNodes.nodes.map((node) => {
        const d = node.discount;
        const type = isCode(d?.__typename) ? "code" : "automatic";
        const code = d?.codes?.nodes?.[0]?.code ?? "";
        return [gidToId(node.id), type, d?.title ?? "", d?.status ?? "", code];
      });

      const markdown =
        discountNodes.nodes.length === 0
          ? "No discounts found."
          : markdownTable(["ID", "Type", "Title", "Status", "Code"], rows, args.first) +
            (discountNodes.pageInfo.hasNextPage
              ? `\n\n_More available. Pass \`after: "${discountNodes.pageInfo.endCursor}"\` for the next page._`
              : "");

      return {
        markdown,
        structured: { discounts: stripGids(discountNodes.nodes), pageInfo: discountNodes.pageInfo },
        cost: res.cost,
      };
    },
  });
}

export function registerCommerceExtraWriteTools(server: McpServer, client: ShopifyClient): void {
  registerTool(server, client, {
    name: "shopify_create_automatic_discount",
    title: "Create automatic discount",
    description:
      "Create a basic automatic discount (percentage or fixed amount) that applies to the whole order " +
      "automatically at checkout — no code required. Requires the write_discounts scope.",
    inputSchema: {
      title: z.string().describe("Discount title shown in the admin, e.g. 'Summer Sale'."),
      valueType: z.enum(["PERCENTAGE", "FIXED_AMOUNT"]).default("PERCENTAGE"),
      value: z
        .number()
        .positive()
        .describe("For PERCENTAGE, e.g. 10 = 10%. For FIXED_AMOUNT, the currency amount, e.g. 5."),
      startsAt: z
        .string()
        .optional()
        .describe("ISO datetime the discount becomes active. Defaults to now."),
      endsAt: z.string().optional().describe("ISO datetime the discount expires. Optional."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (args, c) => {
      const customerGetsValue =
        args.valueType === "PERCENTAGE"
          ? { percentage: args.value / 100 }
          : { discountAmount: { amount: args.value, appliesOnEachItem: false } };

      const automaticBasicDiscount: Record<string, unknown> = {
        title: args.title,
        startsAt: args.startsAt ?? new Date().toISOString(),
        customerGets: { value: customerGetsValue, items: { all: true } },
      };
      if (args.endsAt) automaticBasicDiscount.endsAt = args.endsAt;

      const res = await c.request<{
        discountAutomaticBasicCreate: {
          automaticDiscountNode: {
            id: string;
            automaticDiscount: { title: string; status: string } | null;
          } | null;
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(CREATE_AUTOMATIC_DISCOUNT, { automaticBasicDiscount });

      assertNoUserErrors(res.data.discountAutomaticBasicCreate.userErrors);
      const node = res.data.discountAutomaticBasicCreate.automaticDiscountNode!;
      return {
        markdown: `Created automatic discount **${args.title}** (id ${gidToId(node.id)}, ${args.value}${args.valueType === "PERCENTAGE" ? "%" : ""} off).`,
        structured: { discount: stripGids(node) },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_deactivate_discount",
    title: "Deactivate a discount",
    description:
      "Deactivate (pause) a code or automatic discount without deleting it. Set `type` to match the " +
      "discount ('code' or 'automatic'). Requires the write_discounts scope.",
    inputSchema: {
      id: z.string().describe("Discount id (numeric or GID) from shopify_list_discounts."),
      type: z
        .enum(["code", "automatic"])
        .describe("Which kind of discount this is: 'code' or 'automatic'."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      if (args.type === "code") {
        const gid = toGid("DiscountCodeNode", args.id);
        const res = await c.request<{
          discountCodeDeactivate: {
            codeDiscountNode: { id: string } | null;
            userErrors: Array<{ field: string[] | null; message: string }>;
          };
        }>(DEACTIVATE_CODE_DISCOUNT, { id: gid });
        assertNoUserErrors(res.data.discountCodeDeactivate.userErrors);
        return {
          markdown: `Deactivated code discount ${gidToId(gid)}.`,
          structured: { id: gidToId(gid), type: "code", deactivated: true },
          cost: res.cost,
        };
      }

      const gid = toGid("DiscountAutomaticNode", args.id);
      const res = await c.request<{
        discountAutomaticDeactivate: {
          automaticDiscountNode: { id: string } | null;
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(DEACTIVATE_AUTOMATIC_DISCOUNT, { id: gid });
      assertNoUserErrors(res.data.discountAutomaticDeactivate.userErrors);
      return {
        markdown: `Deactivated automatic discount ${gidToId(gid)}.`,
        structured: { id: gidToId(gid), type: "automatic", deactivated: true },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_create_gift_card",
    title: "Create gift card",
    description:
      "Issue a gift card with an initial balance. Optionally assign it to a customer, set an expiry " +
      "date, an internal note, and a custom code (8-20 letters/numbers; a random code is generated " +
      "if omitted). Requires the write_gift_cards scope.",
    inputSchema: {
      initialValue: z
        .number()
        .positive()
        .describe("The gift card's starting balance, e.g. 50 (in the store's currency)."),
      note: z.string().optional().describe("Internal note (not shown to the customer)."),
      expiresOn: z.string().optional().describe("Expiry date (YYYY-MM-DD). Never expires if omitted."),
      customerId: z
        .string()
        .optional()
        .describe("Customer id (numeric or GID) to assign the gift card to."),
      code: z
        .string()
        .optional()
        .describe("Custom code, 8-20 letters/numbers. A random code is generated if omitted."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (args, c) => {
      const input: Record<string, unknown> = {
        // GiftCardCreateInput.initialValue is a Decimal — pass as a string.
        initialValue: String(args.initialValue),
      };
      if (args.note !== undefined) input.note = args.note;
      if (args.expiresOn !== undefined) input.expiresOn = args.expiresOn;
      if (args.customerId !== undefined) input.customerId = toGid("Customer", args.customerId);
      if (args.code !== undefined) input.code = args.code;

      const res = await c.request<{
        giftCardCreate: {
          giftCard: {
            id: string;
            lastCharacters: string;
            balance: { amount: string; currencyCode: string };
          } | null;
          giftCardCode: string | null;
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(CREATE_GIFT_CARD, { input });

      assertNoUserErrors(res.data.giftCardCreate.userErrors);
      const card = res.data.giftCardCreate.giftCard!;
      const code = res.data.giftCardCreate.giftCardCode ?? `••••${card.lastCharacters}`;
      return {
        markdown: `Created gift card **${code}** (id ${gidToId(card.id)}, balance ${money(card.balance)}).`,
        structured: {
          giftCard: stripGids(card),
          giftCardCode: res.data.giftCardCreate.giftCardCode,
        },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_create_product_option",
    title: "Create product option",
    description:
      "Add a new option (e.g. Size or Color) with its values to an existing product. By default " +
      "existing variants are left as-is (LEAVE_AS_IS); use variantStrategy CREATE to generate new " +
      "variants for the new option values. Requires the write_products scope.",
    inputSchema: {
      productId: z.string().describe("Product id (numeric or GID)."),
      name: z.string().describe("Option name, e.g. 'Size' or 'Color'."),
      values: z.array(z.string()).min(1).describe("Option values, e.g. ['Small', 'Medium', 'Large']."),
      variantStrategy: z
        .enum(["LEAVE_AS_IS", "CREATE"])
        .default("LEAVE_AS_IS")
        .describe("LEAVE_AS_IS keeps existing variants; CREATE generates variants for the new values."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (args, c) => {
      const options = [{ name: args.name, values: args.values.map((v) => ({ name: v })) }];
      const res = await c.request<{
        productOptionsCreate: {
          product: { id: string } | null;
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(CREATE_PRODUCT_OPTION, {
        productId: toGid("Product", args.productId),
        options,
        variantStrategy: args.variantStrategy,
      });
      assertNoUserErrors(res.data.productOptionsCreate.userErrors);
      const product = res.data.productOptionsCreate.product!;
      return {
        markdown: `Added option **${args.name}** (${args.values.join(", ")}) to product ${gidToId(product.id)}.`,
        structured: { productId: gidToId(product.id), option: { name: args.name, values: args.values } },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_delete_product_option",
    title: "Delete product option",
    description:
      "Delete one or more options from a product by their option ids. This can remove option values " +
      "and, depending on the strategy, affect variants. With the default strategy, options that would " +
      "create conflicting variants are not deleted (an error is returned instead) — use POSITION or " +
      "NON_DESTRUCTIVE to override. Requires the write_products scope.",
    inputSchema: {
      productId: z.string().describe("Product id (numeric or GID)."),
      optionIds: z.array(z.string()).min(1).describe("Option ids to delete (numeric or GID)."),
      strategy: z
        .enum(["DEFAULT", "POSITION", "NON_DESTRUCTIVE"])
        .optional()
        .describe("Deletion behaviour when variants would conflict. Defaults to DEFAULT."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async (args, c) => {
      const variables: Record<string, unknown> = {
        productId: toGid("Product", args.productId),
        options: args.optionIds.map((id) => toGid("ProductOption", id)),
      };
      if (args.strategy !== undefined) variables.strategy = args.strategy;

      const res = await c.request<{
        productOptionsDelete: {
          deletedOptionsIds: string[] | null;
          product: { id: string } | null;
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(DELETE_PRODUCT_OPTION, variables);
      assertNoUserErrors(res.data.productOptionsDelete.userErrors);
      const deleted = res.data.productOptionsDelete.deletedOptionsIds ?? [];
      return {
        markdown: `Deleted ${deleted.length} option(s) from product ${gidToId(args.productId)}.`,
        structured: {
          productId: gidToId(args.productId),
          deletedOptionsIds: deleted.map((id) => gidToId(id)),
        },
        cost: res.cost,
      };
    },
  });
}
