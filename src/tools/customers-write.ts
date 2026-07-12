/**
 * Customer write tools: create, update, update email marketing consent,
 * and send an account invite email.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ShopifyClient, assertNoUserErrors } from "../shopify-client.js";
import { registerTool } from "./shared.js";
import { gidToId, toGid, stripGids } from "../format.js";

// ─── GraphQL ─────────────────────────────────────────────────────────────────

const CREATE_CUSTOMER = /* GraphQL */ `
  mutation CreateCustomer($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer { id displayName email phone }
      userErrors { field message }
    }
  }
`;

const UPDATE_CUSTOMER = /* GraphQL */ `
  mutation UpdateCustomer($input: CustomerInput!) {
    customerUpdate(input: $input) {
      customer { id displayName email phone }
      userErrors { field message }
    }
  }
`;

const UPDATE_EMAIL_MARKETING_CONSENT = /* GraphQL */ `
  mutation UpdateEmailMarketingConsent($input: CustomerEmailMarketingConsentUpdateInput!) {
    customerEmailMarketingConsentUpdate(input: $input) {
      customer {
        id displayName email
        emailMarketingConsent { marketingState marketingOptInLevel consentUpdatedAt }
      }
      userErrors { field message }
    }
  }
`;

const SEND_ACCOUNT_INVITE = /* GraphQL */ `
  mutation SendAccountInvite($customerId: ID!, $email: EmailInput) {
    customerSendAccountInviteEmail(customerId: $customerId, email: $email) {
      customer { id displayName email }
      userErrors { field message }
    }
  }
`;

// ─── Shared shapes ───────────────────────────────────────────────────────────

/** Zod schema for a single MailingAddressInput. Codes follow Shopify's Admin API. */
const addressSchema = z.object({
  address1: z.string().describe("Street address, line 1."),
  address2: z.string().optional().describe("Street address, line 2 (apt, suite, etc.)."),
  city: z.string().optional().describe("City / locality."),
  province: z
    .string()
    .optional()
    .describe('Province/state CODE, e.g. "ON" or "CA" (maps to provinceCode).'),
  zip: z.string().optional().describe("Postal / ZIP code."),
  country: z
    .string()
    .optional()
    .describe('Country ISO code, e.g. "US" or "CA" (maps to countryCode).'),
  firstName: z.string().optional().describe("Recipient first name for this address."),
  lastName: z.string().optional().describe("Recipient last name for this address."),
  phone: z.string().optional().describe("Phone number for this address."),
});

type AddressArg = z.infer<typeof addressSchema>;

interface CustomerMutationResult {
  id: string;
  displayName: string;
  email: string | null;
  phone: string | null;
}

/** Maps a friendly address arg to a Shopify MailingAddressInput, omitting empty fields. */
function toMailingAddressInput(addr: AddressArg): Record<string, unknown> {
  const out: Record<string, unknown> = { address1: addr.address1 };
  if (addr.address2 !== undefined) out.address2 = addr.address2;
  if (addr.city !== undefined) out.city = addr.city;
  if (addr.province !== undefined) out.provinceCode = addr.province;
  if (addr.zip !== undefined) out.zip = addr.zip;
  if (addr.country !== undefined) out.countryCode = addr.country;
  if (addr.firstName !== undefined) out.firstName = addr.firstName;
  if (addr.lastName !== undefined) out.lastName = addr.lastName;
  if (addr.phone !== undefined) out.phone = addr.phone;
  return out;
}

export function registerCustomerWriteTools(server: McpServer, client: ShopifyClient): void {
  registerTool(server, client, {
    name: "shopify_create_customer",
    title: "Create customer",
    description:
      "Create a customer with contact details, an optional note, tags, and one or more addresses. " +
      "At least one of firstName, lastName, email, or phone is normally required by Shopify.",
    inputSchema: {
      firstName: z.string().optional().describe("Customer first name."),
      lastName: z.string().optional().describe("Customer last name."),
      email: z.string().optional().describe("Customer email address (must be unique in the store)."),
      phone: z.string().optional().describe('Customer phone in E.164 format, e.g. "+15551234567".'),
      note: z.string().optional().describe("Internal note about the customer (not shown to them)."),
      tags: z.array(z.string()).optional().describe('Tags, e.g. ["vip", "wholesale"].'),
      addresses: z
        .array(addressSchema)
        .optional()
        .describe("One or more mailing addresses to attach to the customer."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (args, c) => {
      const input: Record<string, unknown> = {};
      if (args.firstName !== undefined) input.firstName = args.firstName;
      if (args.lastName !== undefined) input.lastName = args.lastName;
      if (args.email !== undefined) input.email = args.email;
      if (args.phone !== undefined) input.phone = args.phone;
      if (args.note !== undefined) input.note = args.note;
      if (args.tags !== undefined) input.tags = args.tags;
      if (args.addresses !== undefined) input.addresses = args.addresses.map(toMailingAddressInput);

      const res = await c.request<{
        customerCreate: {
          customer: CustomerMutationResult | null;
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(CREATE_CUSTOMER, { input });
      assertNoUserErrors(res.data.customerCreate.userErrors);
      const customer = res.data.customerCreate.customer!;
      return {
        markdown:
          `Created customer **${customer.displayName}** (id ${gidToId(customer.id)}` +
          `${customer.email ? `, email ${customer.email}` : ""}).`,
        structured: { customer: stripGids(customer) },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_update_customer",
    title: "Update customer",
    description:
      "Partially update a customer. Only the fields you provide are changed. " +
      "Providing `tags` replaces the full tag list; `addresses` replaces the customer's addresses.",
    inputSchema: {
      id: z.string().describe("Customer id (numeric or GID)."),
      firstName: z.string().optional().describe("Customer first name."),
      lastName: z.string().optional().describe("Customer last name."),
      email: z.string().optional().describe("Customer email address (must be unique in the store)."),
      phone: z.string().optional().describe('Customer phone in E.164 format, e.g. "+15551234567".'),
      note: z.string().optional().describe("Internal note about the customer (not shown to them)."),
      tags: z.array(z.string()).optional().describe("Replaces the full tag list."),
      addresses: z
        .array(addressSchema)
        .optional()
        .describe("Replaces the customer's mailing addresses."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const input: Record<string, unknown> = { id: toGid("Customer", args.id) };
      if (args.firstName !== undefined) input.firstName = args.firstName;
      if (args.lastName !== undefined) input.lastName = args.lastName;
      if (args.email !== undefined) input.email = args.email;
      if (args.phone !== undefined) input.phone = args.phone;
      if (args.note !== undefined) input.note = args.note;
      if (args.tags !== undefined) input.tags = args.tags;
      if (args.addresses !== undefined) input.addresses = args.addresses.map(toMailingAddressInput);

      const res = await c.request<{
        customerUpdate: {
          customer: CustomerMutationResult | null;
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(UPDATE_CUSTOMER, { input });
      assertNoUserErrors(res.data.customerUpdate.userErrors);
      const customer = res.data.customerUpdate.customer!;
      return {
        markdown: `Updated customer **${customer.displayName}** (id ${gidToId(customer.id)}).`,
        structured: { customer: stripGids(customer) },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_update_customer_marketing_consent",
    title: "Update customer email marketing consent",
    description:
      "Set a customer's email marketing consent (subscribed or unsubscribed). The customer must have " +
      "an email address. Optionally set the opt-in level.",
    inputSchema: {
      customerId: z.string().describe("Customer id (numeric or GID)."),
      subscribed: z
        .boolean()
        .describe("true subscribes the customer (SUBSCRIBED); false unsubscribes (UNSUBSCRIBED)."),
      marketingOptInLevel: z
        .enum(["SINGLE_OPT_IN", "CONFIRMED_OPT_IN", "UNKNOWN"])
        .optional()
        .describe("Opt-in level for the consent. Optional."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async (args, c) => {
      const emailMarketingConsent: Record<string, unknown> = {
        marketingState: args.subscribed ? "SUBSCRIBED" : "UNSUBSCRIBED",
      };
      if (args.marketingOptInLevel !== undefined) {
        emailMarketingConsent.marketingOptInLevel = args.marketingOptInLevel;
      }

      const res = await c.request<{
        customerEmailMarketingConsentUpdate: {
          customer: {
            id: string;
            displayName: string;
            email: string | null;
            emailMarketingConsent: {
              marketingState: string;
              marketingOptInLevel: string | null;
              consentUpdatedAt: string | null;
            } | null;
          } | null;
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(UPDATE_EMAIL_MARKETING_CONSENT, {
        input: { customerId: toGid("Customer", args.customerId), emailMarketingConsent },
      });
      assertNoUserErrors(res.data.customerEmailMarketingConsentUpdate.userErrors);
      const customer = res.data.customerEmailMarketingConsentUpdate.customer!;
      const state = customer.emailMarketingConsent?.marketingState ?? "?";
      return {
        markdown:
          `Set email marketing consent for **${customer.displayName}** ` +
          `(id ${gidToId(customer.id)}) to **${state}**.`,
        structured: { customer: stripGids(customer) },
        cost: res.cost,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_send_customer_invite",
    title: "Send customer account invite email",
    description:
      "Send an email inviting a customer to create/activate a classic customer account. Optionally " +
      "override the subject line and/or add a custom message. Only works when legacy customer " +
      "accounts are enabled on the shop.",
    inputSchema: {
      customerId: z.string().describe("Customer id (numeric or GID)."),
      subject: z.string().optional().describe("Override the invite email's subject line."),
      customMessage: z.string().optional().describe("Custom message to include in the invite email."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (args, c) => {
      const email: Record<string, unknown> = {};
      if (args.subject !== undefined) email.subject = args.subject;
      if (args.customMessage !== undefined) email.customMessage = args.customMessage;

      const res = await c.request<{
        customerSendAccountInviteEmail: {
          customer: { id: string; displayName: string; email: string | null } | null;
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(SEND_ACCOUNT_INVITE, {
        customerId: toGid("Customer", args.customerId),
        email: Object.keys(email).length > 0 ? email : undefined,
      });
      assertNoUserErrors(res.data.customerSendAccountInviteEmail.userErrors);
      const customer = res.data.customerSendAccountInviteEmail.customer!;
      return {
        markdown:
          `Sent account invite email to **${customer.displayName}**` +
          `${customer.email ? ` (${customer.email})` : ""} (id ${gidToId(customer.id)}).`,
        structured: { customer: stripGids(customer) },
        cost: res.cost,
      };
    },
  });
}
