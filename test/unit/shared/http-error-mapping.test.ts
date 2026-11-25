import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  BusinessRuleError,
  ConflictError,
  ContractViolationError,
} from "../../../src/shared/domain/domain-error.ts";
import {
  mapDomainErrorToHttp,
  TransientServiceException,
} from "../../../src/shared/infrastructure/http/http-exception.filter.ts";
import { parseWithZod } from "../../../src/shared/infrastructure/http/zod-validation.ts";
import { sanitizeLogMeta } from "../../../src/shared/infrastructure/observability/logger.service.ts";

describe("HTTP Error Mapping, Zod Strict & Log Sanitization (D07, D12, D14, §12)", () => {
  test("maps DomainError categories to expected HTTP status codes and retryable flags", () => {
    const contract = mapDomainErrorToHttp(
      new ContractViolationError("INVALID_MONEY", "bad money"),
    );
    expect(contract.status).toBe(400);
    expect(contract.body.retryable).toBe(false);

    const conflict = mapDomainErrorToHttp(
      new ConflictError("IDEMPOTENCY_KEY_CONFLICT", "conflict"),
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.retryable).toBe(false);

    const notFoundWallet = mapDomainErrorToHttp(
      new BusinessRuleError("WALLET_NOT_FOUND", "missing"),
    );
    expect(notFoundWallet.status).toBe(422);
    expect(notFoundWallet.body.retryable).toBe(true);

    const transient = mapDomainErrorToHttp(
      new TransientServiceException("WALLET_BUSY", "locked", 3),
    );
    expect(transient.status).toBe(503);
    expect(transient.retryAfterSeconds).toBe(3);
    expect(transient.body.retryable).toBe(true);
  });

  test("parseWithZod rejects unknown fields when using .strict()", () => {
    const schema = z.object({ a: z.string() }).strict();
    expect(parseWithZod(schema, { a: "ok" })).toEqual({ a: "ok" });
    expect(() =>
      parseWithZod(schema, { a: "ok", unexpected: 123 }),
    ).toThrow(ContractViolationError);
  });

  test("sanitizeLogMeta strips financial amounts, playerId and full payloads", () => {
    const cleaned = sanitizeLogMeta({
      kind: "BET",
      amount: "100.00",
      balance: "50.00",
      playerId: "p-1",
      nested: {
        balanceAfter: "50.00",
        payload: { secret: true },
        status: "PROCESSED",
      },
    });

    expect(cleaned).toEqual({
      kind: "BET",
      nested: { status: "PROCESSED" },
    });
  });
});
