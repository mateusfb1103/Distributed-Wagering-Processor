import {
  type BusinessFailureCode,
  type ConflictFailureCode,
  type ContractFailureCode,
  type FailureCode,
  getFailureCodeMeta,
} from "./failure-codes.ts";

/**
 * Erro base de domínio carregando código estável (D14) e indicação de retryability.
 */
export class DomainError extends Error {
  readonly code: FailureCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: FailureCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.retryable = getFailureCodeMeta(code).retryable;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export class ContractViolationError extends DomainError {
  constructor(
    code: ContractFailureCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(code, message, details);
  }
}

export class ConflictError extends DomainError {
  constructor(
    code: ConflictFailureCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(code, message, details);
  }
}

export class BusinessRuleError extends DomainError {
  constructor(
    code: BusinessFailureCode | "WALLET_NOT_FOUND",
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(code, message, details);
  }
}

export class InvalidStateTransitionError extends DomainError {
  constructor(
    message: string,
    details?: Record<string, unknown>,
  ) {
    super("PROCESSING_FAILED", message, details);
  }
}
