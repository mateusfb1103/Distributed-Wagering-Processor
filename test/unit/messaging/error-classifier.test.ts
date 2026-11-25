import { describe, expect, test } from "bun:test";
import {
  FaultInjectionError,
  PermanentSqsMessageError,
  classifySqsError,
  computeSqsVisibilityBackoffSeconds,
} from "../../../src/messaging/application/sqs-message-classifier.ts";
import {
  BusinessRuleError,
  ConflictError,
  ContractViolationError,
} from "../../../src/shared/domain/domain-error.ts";
import {
  getActiveFaultInjectionPoint,
  loadEnv,
} from "../../../src/shared/infrastructure/config/env.ts";
import { TransientServiceException } from "../../../src/shared/infrastructure/http/http-exception.filter.ts";

describe("SQS Error Classifier & Fault Injection Policy (D10)", () => {
  test("classifies business, permanent and transient errors correctly", () => {
    expect(
      classifySqsError(new BusinessRuleError("WALLET_NOT_FOUND", "missing")),
    ).toEqual({ action: "ACK" });

    expect(classifySqsError(new SyntaxError("Unexpected token"))).toEqual({
      action: "DLQ",
      reason: "MALFORMED_JSON",
      failureCode: "INVALID_PAYLOAD",
    });

    expect(
      classifySqsError(new ContractViolationError("INVALID_MONEY", "bad")),
    ).toEqual({
      action: "DLQ",
      reason: "CONTRACT_VIOLATION",
      failureCode: "INVALID_MONEY",
    });

    expect(
      classifySqsError(
        new ConflictError("IDEMPOTENCY_KEY_CONFLICT", "conflict"),
      ),
    ).toEqual({
      action: "DLQ",
      reason: "CONFLICT",
      failureCode: "IDEMPOTENCY_KEY_CONFLICT",
    });

    expect(
      classifySqsError(
        new PermanentSqsMessageError(
          "INBOX_PAYLOAD_HASH_MISMATCH",
          "IDEMPOTENCY_KEY_CONFLICT",
          "mismatch",
        ),
      ),
    ).toEqual({
      action: "DLQ",
      reason: "INBOX_PAYLOAD_HASH_MISMATCH",
      failureCode: "IDEMPOTENCY_KEY_CONFLICT",
    });

    expect(
      classifySqsError(new TransientServiceException("WALLET_BUSY", "busy")),
    ).toEqual({
      action: "RETRY",
      reason: "WALLET_BUSY",
    });

    expect(
      classifySqsError(new FaultInjectionError("AFTER_COMMIT_BEFORE_SQS_ACK")),
    ).toEqual({
      action: "RETRY",
      reason: "AFTER_COMMIT_BEFORE_SQS_ACK",
    });

    expect(classifySqsError(new Error("socket hang up"))).toEqual({
      action: "RETRY",
      reason: "Error",
    });
  });

  test("computes exponential visibility backoff capped at 30s", () => {
    expect(computeSqsVisibilityBackoffSeconds(1)).toBe(1);
    expect(computeSqsVisibilityBackoffSeconds(2)).toBe(2);
    expect(computeSqsVisibilityBackoffSeconds(3)).toBe(4);
    expect(computeSqsVisibilityBackoffSeconds(4)).toBe(8);
    expect(computeSqsVisibilityBackoffSeconds(5)).toBe(16);
    expect(computeSqsVisibilityBackoffSeconds(6)).toBe(30);
    expect(computeSqsVisibilityBackoffSeconds(10)).toBe(30);
  });

  test("disables FAULT_INJECTION_POINT in production", () => {
    const devEnv = loadEnv({
      NODE_ENV: "development",
      FAULT_INJECTION_POINT: "AFTER_COMMIT_BEFORE_SQS_ACK",
    });
    expect(getActiveFaultInjectionPoint(devEnv)).toBe(
      "AFTER_COMMIT_BEFORE_SQS_ACK",
    );

    const prodEnv = loadEnv({
      NODE_ENV: "production",
      FAULT_INJECTION_POINT: "AFTER_COMMIT_BEFORE_SQS_ACK",
    });
    expect(getActiveFaultInjectionPoint(prodEnv)).toBeNull();
  });
});
