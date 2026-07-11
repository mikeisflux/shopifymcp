/**
 * Shared plumbing for tool modules: pagination schema, a typed registration
 * helper that times/logs each call, and standard result shaping.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { ShopifyClient, ShopifyError } from "../shopify-client.js";
import { logToolCall } from "../logger.js";
import { textContent } from "../format.js";

/** Cursor pagination inputs shared by every list tool. */
export const paginationShape = {
  first: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(25)
    .describe("Page size (number of records to return). Default 25, max 100."),
  after: z
    .string()
    .optional()
    .describe("Opaque cursor from a previous response's pageInfo.endCursor, to fetch the next page."),
};

export interface ToolResult {
  /** Human-readable Markdown rendered into the text content block. */
  markdown: string;
  /** Raw shaped data returned as structuredContent. */
  structured: Record<string, unknown>;
  /** Shopify query cost, for logging. */
  cost?: number | undefined;
}

export interface ToolDefinition<Shape extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  annotations: ToolAnnotations;
  handler: (args: z.objectOutputType<Shape, z.ZodTypeAny>, client: ShopifyClient) => Promise<ToolResult>;
}

/**
 * Registers a tool on the server, wrapping the handler with duration/cost
 * logging and converting thrown errors into MCP error results (isError:true)
 * with an actionable message rather than crashing the request.
 */
export function registerTool<Shape extends z.ZodRawShape>(
  server: McpServer,
  client: ShopifyClient,
  def: ToolDefinition<Shape>,
): void {
  const callback = async (args: z.objectOutputType<Shape, z.ZodTypeAny>) => {
    const start = Date.now();
    try {
      const result = await def.handler(args, client);
      logToolCall({
        tool: def.name,
        durationMs: Date.now() - start,
        cost: result.cost,
        success: true,
      });
      return {
        content: [textContent(result.markdown)],
        structuredContent: result.structured,
      };
    } catch (err) {
      const message =
        err instanceof ShopifyError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      logToolCall({
        tool: def.name,
        durationMs: Date.now() - start,
        success: false,
        error: message,
      });
      return {
        content: [textContent(`Error: ${message}`)],
        isError: true,
      };
    }
  };

  // The SDK infers the callback's arg type from inputSchema; our generic
  // wrapper can't line up with that inference, so cast at the boundary.
  server.registerTool(
    def.name,
    {
      title: def.title,
      description: def.description,
      inputSchema: def.inputSchema,
      annotations: def.annotations,
    },
    callback as never,
  );
}
