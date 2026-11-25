import { Injectable } from "@nestjs/common";
import pino, { type Logger } from "pino";
import { requestContext } from "./request-context.ts";

const FORBIDDEN_LOG_KEYS = new Set([
  "amount",
  "balance",
  "balanceBefore",
  "balanceAfter",
  "initialBalance",
  "resultBalance",
  "playerId",
  "payload",
  "body",
  "rawBody",
]);

/**
 * Remove recursivamente campos monetários, `playerId` e payloads completos (§12).
 */
export function sanitizeLogMeta(
  meta?: Record<string, unknown>,
): Record<string, unknown> {
  if (!meta) {
    return {};
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (FORBIDDEN_LOG_KEYS.has(key)) {
      continue;
    }
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !(value instanceof Date) &&
      !(value instanceof Error)
    ) {
      sanitized[key] = sanitizeLogMeta(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

@Injectable()
export class AppLogger {
  private readonly logger: Logger;

  constructor() {
    const level = process.env.LOG_LEVEL ?? "info";
    this.logger = pino({
      level: process.env.NODE_ENV === "test" ? "silent" : level,
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
    });
  }

  info(msg: string, meta?: Record<string, unknown>): void {
    this.logger.info(this.buildFields(meta), msg);
  }

  warn(msg: string, meta?: Record<string, unknown>): void {
    this.logger.warn(this.buildFields(meta), msg);
  }

  error(msg: string, meta?: Record<string, unknown>): void {
    this.logger.error(this.buildFields(meta), msg);
  }

  private buildFields(meta?: Record<string, unknown>): Record<string, unknown> {
    const ctx = requestContext.get();
    return {
      ...ctx,
      ...sanitizeLogMeta(meta),
    };
  }
}
