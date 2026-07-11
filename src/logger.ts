/**
 * Structured JSON logging to stdout.
 *
 * NEVER logs the Shopify access token, MCP auth token, or full customer PII.
 * Log resource IDs (order/customer/product), not names/emails/addresses.
 */

import type { LogLevel } from "./config.js";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let threshold = LEVEL_ORDER.info;

export function configureLogger(level: LogLevel): void {
  threshold = LEVEL_ORDER[level];
}

export interface LogFields {
  [key: string]: unknown;
}

function emit(level: LogLevel, message: string, fields?: LogFields): void {
  if (LEVEL_ORDER[level] < threshold) return;
  const record: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    msg: message,
    ...fields,
  };
  // Emit a single-line JSON object per log line for structured ingestion.
  const line = JSON.stringify(record);
  if (level === "error" || level === "warn") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export const log = {
  debug: (message: string, fields?: LogFields) => emit("debug", message, fields),
  info: (message: string, fields?: LogFields) => emit("info", message, fields),
  warn: (message: string, fields?: LogFields) => emit("warn", message, fields),
  error: (message: string, fields?: LogFields) => emit("error", message, fields),
};

/**
 * Logs the outcome of a tool invocation. Records tool name, duration,
 * Shopify query cost, and success/error — never argument values (which may
 * contain PII such as customer search terms).
 */
export function logToolCall(fields: {
  tool: string;
  durationMs: number;
  cost?: number | undefined;
  success: boolean;
  error?: string | undefined;
}): void {
  emit(fields.success ? "info" : "error", "tool_call", {
    tool: fields.tool,
    duration_ms: fields.durationMs,
    query_cost: fields.cost,
    success: fields.success,
    error: fields.error,
  });
}
