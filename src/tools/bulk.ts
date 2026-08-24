/**
 * Bulk write tools that loop server-side (one Admin API round-trip per item, not
 * per model turn), throttle between calls, capture per-item errors, and return a
 * single aggregated {total, succeeded, failed, failures} summary.
 *
 *   - shopify_bulk_update_product_option : rename an option / its values across many products
 *   - shopify_bulk_graphql_mutation      : run an arbitrary mutation across many variable sets
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ShopifyClient } from "../shopify-client.js";
import { registerTool } from "./shared.js";
import { gidToId, toGid } from "../format.js";
import { assertMutationDoc, requireUserErrorsSelection, findBareIds, collectUserErrors } from "./misc.js";

const MAX_ITEMS = 1000;
const DEFAULT_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const UPDATE_PRODUCT_OPTION = /* GraphQL */ `
  mutation BulkUpdateProductOption(
    $productId: ID!
    $option: OptionUpdateInput!
    $optionValuesToAdd: [OptionValueCreateInput!]
    $optionValuesToUpdate: [OptionValueUpdateInput!]
    $optionValuesToDelete: [ID!]
    $variantStrategy: ProductOptionUpdateVariantStrategy
  ) {
    productOptionUpdate(
      productId: $productId
      option: $option
      optionValuesToAdd: $optionValuesToAdd
      optionValuesToUpdate: $optionValuesToUpdate
      optionValuesToDelete: $optionValuesToDelete
      variantStrategy: $variantStrategy
    ) {
      product { id }
      userErrors { field message }
    }
  }
`;

const GET_PRODUCT_OPTION_VALUES = /* GraphQL */ `
  query BulkOptionValues($id: ID!) {
    product(id: $id) { options { id optionValues { id name } } }
  }
`;

export function registerBulkTools(server: McpServer, client: ShopifyClient): void {
  registerTool(server, client, {
    name: "shopify_bulk_update_product_option",
    title: "Bulk update product option (many products)",
    description:
      "Rename a product option and/or its values across MANY products in one call — the server loops " +
      "productOptionUpdate per item with throttling and per-item error capture, returning an aggregated " +
      "{total, succeeded, failed, failures}. Each update needs productId + optionId; optionally set a new " +
      "option `name`, and/or rename/add/delete values. Value renames/deletes given by name are resolved " +
      "to ids per product (one extra read for those items only). dryRun defaults to FALSE (this tool " +
      "exists for unattended bulk writes); set true to validate + echo without executing. Max " +
      `${MAX_ITEMS} items per call — split larger jobs.`,
    inputSchema: {
      updates: z
        .array(z.object({
          productId: z.string().describe("Product id (numeric or GID)."),
          optionId: z.string().describe("The option to change (numeric or GID)."),
          name: z.string().optional().describe("New name for the option itself."),
          valuesToRename: z.array(z.object({
            from: z.string().optional().describe("Existing value name to rename."),
            id: z.string().optional().describe("Existing value id (alternative to `from`)."),
            to: z.string().describe("New value name."),
          })).optional().describe("Rename option values."),
          valuesToAdd: z.array(z.string()).optional().describe("New value names to add."),
          valuesToDelete: z.array(z.string()).optional().describe("Value names (or ids) to delete."),
        }))
        .min(1).max(MAX_ITEMS)
        .describe("Per-product option updates."),
      dryRun: z.boolean().default(false).describe("If true, validate + echo the planned updates without executing. Default FALSE."),
      delayMs: z.number().int().min(0).max(5000).default(DEFAULT_DELAY_MS).describe("Delay between calls (ms) for rate limiting. Default 500."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async (args, c) => {
      // Fail fast on malformed items — no partial execution.
      args.updates.forEach((u, i) => {
        if (!u.productId?.trim() || !u.optionId?.trim()) throw new Error(`updates[${i}]: productId and optionId are required.`);
        if (u.name === undefined && !u.valuesToRename?.length && !u.valuesToAdd?.length && !u.valuesToDelete?.length) {
          throw new Error(`updates[${i}]: nothing to change (provide name, valuesToRename, valuesToAdd, or valuesToDelete).`);
        }
      });

      if (args.dryRun) {
        return {
          markdown:
            `**DRY RUN** — ${args.updates.length} product option update(s) validated, none executed.\n` +
            args.updates.slice(0, 20).map((u) => `- product ${gidToId(u.productId)} option ${gidToId(u.optionId)}: ` +
              [u.name ? `rename→"${u.name}"` : null, u.valuesToRename?.length ? `${u.valuesToRename.length} value rename(s)` : null, u.valuesToAdd?.length ? `+${u.valuesToAdd.length}` : null, u.valuesToDelete?.length ? `-${u.valuesToDelete.length}` : null].filter(Boolean).join(", ")).join("\n") +
            (args.updates.length > 20 ? `\n… and ${args.updates.length - 20} more` : "") +
            `\n\n_Nothing changed. Re-run with dryRun:false to execute._`,
          structured: { dryRun: true, total: args.updates.length },
          cost: undefined,
        };
      }

      const failures: Array<{ productId: string; optionId: string; error: string }> = [];
      let succeeded = 0;

      for (let i = 0; i < args.updates.length; i++) {
        const u = args.updates[i]!;
        const productGid = toGid("Product", u.productId);
        const optionGid = toGid("ProductOption", u.optionId);
        try {
          const variables: Record<string, unknown> = {
            productId: productGid,
            option: { id: optionGid, ...(u.name !== undefined ? { name: u.name } : {}) },
            variantStrategy: "LEAVE_AS_IS",
          };

          const needsResolve = (u.valuesToRename?.some((v) => v.from && !v.id) ?? false) ||
            (u.valuesToDelete?.some((v) => !v.startsWith("gid://shopify/")) ?? false);
          let valueIdByName = new Map<string, string>();
          if (needsResolve) {
            const q = await c.request<{ product: { options: Array<{ id: string; optionValues: Array<{ id: string; name: string }> }> } | null }>(
              GET_PRODUCT_OPTION_VALUES, { id: productGid },
            );
            const opt = q.data.product?.options.find((o) => o.id === optionGid);
            if (!opt) throw new Error(`option ${gidToId(optionGid)} not found on product`);
            valueIdByName = new Map(opt.optionValues.map((v) => [v.name, v.id] as const));
          }

          if (u.valuesToRename?.length) {
            variables.optionValuesToUpdate = u.valuesToRename.map((v) => {
              const id = v.id ? toGid("ProductOptionValue", v.id) : v.from ? valueIdByName.get(v.from) : undefined;
              if (!id) throw new Error(`value "${v.from ?? v.id}" not found to rename`);
              return { id, name: v.to };
            });
          }
          if (u.valuesToAdd?.length) variables.optionValuesToAdd = u.valuesToAdd.map((name) => ({ name }));
          if (u.valuesToDelete?.length) {
            variables.optionValuesToDelete = u.valuesToDelete.map((v) => {
              if (v.startsWith("gid://shopify/")) return v;
              const id = valueIdByName.get(v);
              if (!id) throw new Error(`value "${v}" not found to delete`);
              return id;
            });
          }

          const res = await c.request<{ productOptionUpdate: { userErrors: Array<{ field: string[] | null; message: string }> } }>(
            UPDATE_PRODUCT_OPTION, variables,
          );
          const ue = res.data.productOptionUpdate.userErrors;
          if (ue.length) failures.push({ productId: gidToId(productGid), optionId: gidToId(optionGid), error: ue.map((e) => e.message).join("; ") });
          else succeeded++;
        } catch (err) {
          failures.push({ productId: gidToId(productGid), optionId: gidToId(optionGid), error: err instanceof Error ? err.message : String(err) });
        }
        if (args.delayMs > 0 && i < args.updates.length - 1) await sleep(args.delayMs);
      }

      const total = args.updates.length;
      return {
        markdown: `Bulk option update: **${succeeded}/${total} succeeded**, ${failures.length} failed.` +
          (failures.length ? `\n\nFirst failures:\n` + failures.slice(0, 15).map((f) => `- ${f.productId} / ${f.optionId}: ${f.error}`).join("\n") : ""),
        structured: { total, succeeded, failed: failures.length, failures: failures.slice(0, 200) },
        cost: undefined,
      };
    },
  });

  registerTool(server, client, {
    name: "shopify_bulk_graphql_mutation",
    title: "Bulk run a GraphQL mutation (many variable sets)",
    description:
      "Run an arbitrary Admin GraphQL MUTATION across MANY variable sets in one call — the general bulk " +
      "escape hatch. Server loops one request per operation with throttling and per-item error capture, " +
      "returning an aggregated {total, succeeded, failed, failures}. Every operation is validated up " +
      "front (must be a mutation, must select userErrors, IDs must be full GIDs); if ANY fails validation " +
      "the whole call is rejected before executing. Non-empty userErrors or transport errors are captured " +
      "per item and the loop continues. dryRun defaults to FALSE (built for unattended bulk writes). Max " +
      `${MAX_ITEMS} operations per call.`,
    inputSchema: {
      operations: z
        .array(z.object({
          mutation: z.string().describe("A GraphQL mutation document (must select userErrors)."),
          variables: z.record(z.unknown()).optional().describe("Variables for this operation (IDs must be full GIDs)."),
        }))
        .min(1).max(MAX_ITEMS)
        .describe("Operations to run."),
      dryRun: z.boolean().default(false).describe("If true, validate + echo the operation names without executing. Default FALSE."),
      delayMs: z.number().int().min(0).max(5000).default(DEFAULT_DELAY_MS).describe("Delay between calls (ms). Default 500."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    handler: async (args, c) => {
      // Validate ALL operations up front — reject the whole call on any malformed item.
      const opNames: string[] = [];
      args.operations.forEach((op, i) => {
        try {
          opNames[i] = assertMutationDoc(op.mutation);
          requireUserErrorsSelection(op.mutation);
          const bare = findBareIds(op.variables);
          if (bare.length) throw new Error(`bare numeric ID(s) need GIDs: ${bare.join("; ")}`);
        } catch (err) {
          throw new Error(`operations[${i}] invalid: ${err instanceof Error ? err.message : String(err)}`);
        }
      });

      if (args.dryRun) {
        return {
          markdown:
            `**DRY RUN** — ${args.operations.length} mutation(s) validated (all are mutations, select userErrors, ids ok), none executed.\n` +
            opNames.slice(0, 20).map((n, i) => `- [${i}] ${n}`).join("\n") +
            (opNames.length > 20 ? `\n… and ${opNames.length - 20} more` : "") +
            `\n\n_Nothing changed. Re-run with dryRun:false to execute._`,
          structured: { dryRun: true, total: args.operations.length, operations: opNames },
          cost: undefined,
        };
      }

      const failures: Array<{ index: number; operationName: string; error: string }> = [];
      let succeeded = 0;
      for (let i = 0; i < args.operations.length; i++) {
        const op = args.operations[i]!;
        try {
          const res = await c.request<Record<string, unknown>>(op.mutation, op.variables);
          const ue = collectUserErrors(res.data);
          if (ue.length) failures.push({ index: i, operationName: opNames[i]!, error: ue.map((e) => `${e.field?.length ? `[${e.field.join(".")}] ` : ""}${e.message}`).join("; ") });
          else succeeded++;
        } catch (err) {
          failures.push({ index: i, operationName: opNames[i]!, error: err instanceof Error ? err.message : String(err) });
        }
        if (args.delayMs > 0 && i < args.operations.length - 1) await sleep(args.delayMs);
      }

      const total = args.operations.length;
      return {
        markdown: `Bulk mutation: **${succeeded}/${total} succeeded**, ${failures.length} failed.` +
          (failures.length ? `\n\nFirst failures:\n` + failures.slice(0, 15).map((f) => `- [${f.index}] ${f.operationName}: ${f.error}`).join("\n") : ""),
        structured: { total, succeeded, failed: failures.length, failures: failures.slice(0, 200) },
        cost: undefined,
      };
    },
  });
}
