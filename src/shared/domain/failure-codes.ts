export type FailureCategory =
  | "CONTRACT"
  | "CONFLICT"
  | "BUSINESS"
  | "NON_PERSISTED_BUSINESS"
  | "TRANSIENT"
  | "INFRA_PERMANENT";

export const CONTRACT_FAILURE_CODES = [
  "INVALID_PAYLOAD",
  "INVALID_MONEY",
  "UNSUPPORTED_KIND",
  "REFERENCE_REQUIRED",
  "REFERENCE_NOT_ALLOWED",
  "IDEMPOTENCY_KEY_REQUIRED",
] as const;

export const CONFLICT_FAILURE_CODES = [
  "IDEMPOTENCY_KEY_CONFLICT",
  "EXTERNAL_TRANSACTION_ID_CONFLICT",
  "WALLET_ALREADY_EXISTS",
] as const;

export const BUSINESS_FAILURE_CODES = [
  "INSUFFICIENT_FUNDS",
  "REVERSAL_INSUFFICIENT_FUNDS",
  "CURRENCY_MISMATCH",
  "WALLET_PLAYER_MISMATCH",
  "REFERENCE_NOT_FOUND",
  "REFERENCE_MISMATCH",
  "REFERENCE_KIND_NOT_ALLOWED",
  "REFERENCE_NOT_PROCESSED",
  "REFERENCE_ALREADY_REVERSED",
  "AMOUNT_MISMATCH",
] as const;

export const NON_PERSISTED_BUSINESS_FAILURE_CODES = [
  "WALLET_NOT_FOUND",
] as const;

export const TRANSIENT_FAILURE_CODES = [
  "DATABASE_UNAVAILABLE",
  "WALLET_BUSY",
  "SERVICE_UNAVAILABLE",
] as const;

export const INFRA_FAILURE_CODES = ["PROCESSING_FAILED"] as const;

export type ContractFailureCode = (typeof CONTRACT_FAILURE_CODES)[number];
export type ConflictFailureCode = (typeof CONFLICT_FAILURE_CODES)[number];
export type BusinessFailureCode = (typeof BUSINESS_FAILURE_CODES)[number];
export type NonPersistedBusinessFailureCode =
  (typeof NON_PERSISTED_BUSINESS_FAILURE_CODES)[number];
export type TransientFailureCode = (typeof TRANSIENT_FAILURE_CODES)[number];
export type InfraFailureCode = (typeof INFRA_FAILURE_CODES)[number];

export type FailureCode =
  | ContractFailureCode
  | ConflictFailureCode
  | BusinessFailureCode
  | NonPersistedBusinessFailureCode
  | TransientFailureCode
  | InfraFailureCode;

export interface FailureCodeMetadata {
  readonly category: FailureCategory;
  readonly httpStatus: number | null;
  readonly persisted: boolean;
  readonly retryable: boolean;
}

function buildMeta<T extends FailureCode>(
  codes: readonly T[],
  meta: FailureCodeMetadata,
): Record<T, FailureCodeMetadata> {
  const entries = codes.map((code) => [code, meta] as const);
  return Object.fromEntries(entries) as Record<T, FailureCodeMetadata>;
}

export const FAILURE_CODE_META: Record<FailureCode, FailureCodeMetadata> = {
  ...buildMeta(CONTRACT_FAILURE_CODES, {
    category: "CONTRACT",
    httpStatus: 400,
    persisted: false,
    retryable: false,
  }),
  ...buildMeta(CONFLICT_FAILURE_CODES, {
    category: "CONFLICT",
    httpStatus: 409,
    persisted: false,
    retryable: false,
  }),
  ...buildMeta(BUSINESS_FAILURE_CODES, {
    category: "BUSINESS",
    httpStatus: 422,
    persisted: true,
    retryable: false,
  }),
  ...buildMeta(NON_PERSISTED_BUSINESS_FAILURE_CODES, {
    category: "NON_PERSISTED_BUSINESS",
    httpStatus: 422,
    persisted: false,
    retryable: true,
  }),
  ...buildMeta(TRANSIENT_FAILURE_CODES, {
    category: "TRANSIENT",
    httpStatus: 503,
    persisted: false,
    retryable: true,
  }),
  ...buildMeta(INFRA_FAILURE_CODES, {
    category: "INFRA_PERMANENT",
    httpStatus: null,
    persisted: true,
    retryable: false,
  }),
};

export function getFailureCodeMeta(code: FailureCode): FailureCodeMetadata {
  return FAILURE_CODE_META[code];
}
