import {
  BusinessRuleError,
  ConflictError,
  ContractViolationError,
} from "../../shared/domain/domain-error.ts";
import { TransientServiceException } from "../../shared/infrastructure/http/http-exception.filter.ts";

export type SqsErrorClassification =
  | { readonly action: "ACK" }
  | {
      readonly action: "DLQ";
      readonly reason: string;
      readonly failureCode: string;
    }
  | {
      readonly action: "RETRY";
      readonly reason: string;
    };

export class PermanentSqsMessageError extends Error {
  constructor(
    readonly reason: string,
    readonly failureCode: string,
    message: string,
  ) {
    super(message);
    this.name = "PermanentSqsMessageError";
  }
}

export class FaultInjectionError extends Error {
  constructor(readonly point: string) {
    super(`Injected fault at ${point}`);
    this.name = "FaultInjectionError";
  }
}

/**
 * Classificação híbrida D10:
 * - Negócio (`WALLET_NOT_FOUND` etc.) → ack (não vai para DLQ)
 * - Permanente (contrato inválido, JSON inválido, conflitos de idempotência/hash) → DLQ + delete
 * - Transitório (banco indisponível, lock timeout, fault injection, rede) → retry com ChangeMessageVisibility
 */
export function classifySqsError(error: unknown): SqsErrorClassification {
  if (error instanceof PermanentSqsMessageError) {
    return {
      action: "DLQ",
      reason: error.reason,
      failureCode: error.failureCode,
    };
  }

  if (error instanceof SyntaxError) {
    return {
      action: "DLQ",
      reason: "MALFORMED_JSON",
      failureCode: "INVALID_PAYLOAD",
    };
  }

  if (error instanceof ContractViolationError) {
    return {
      action: "DLQ",
      reason: "CONTRACT_VIOLATION",
      failureCode: error.code,
    };
  }

  if (error instanceof ConflictError) {
    return {
      action: "DLQ",
      reason: "CONFLICT",
      failureCode: error.code,
    };
  }

  if (error instanceof BusinessRuleError) {
    return { action: "ACK" };
  }

  if (
    error instanceof TransientServiceException ||
    error instanceof FaultInjectionError
  ) {
    return {
      action: "RETRY",
      reason: error instanceof FaultInjectionError ? error.point : error.code,
    };
  }

  return {
    action: "RETRY",
    reason: error instanceof Error ? error.name : "UNEXPECTED_TRANSIENT_ERROR",
  };
}

/**
 * Backoff exponencial em segundos baseado em `ApproximateReceiveCount` (D10).
 */
export function computeSqsVisibilityBackoffSeconds(
  approximateReceiveCount: number,
  maxSeconds = 30,
): number {
  const exponent = Math.max(0, approximateReceiveCount - 1);
  return Math.min(2 ** exponent, maxSeconds);
}
