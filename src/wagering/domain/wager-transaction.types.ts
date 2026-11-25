export const WAGER_TRANSACTION_KINDS = [
  "OPENING",
  "BET",
  "WIN",
  "LOSS",
  "REFUND",
  "ROLLBACK",
] as const;

export type WagerTransactionKind = (typeof WAGER_TRANSACTION_KINDS)[number];
export type ExternalWagerKind = Exclude<WagerTransactionKind, "OPENING">;

export const WAGER_TRANSACTION_STATUSES = [
  "PENDING_REFERENCE",
  "PROCESSED",
  "REJECTED",
  "FAILED",
] as const;

export type WagerTransactionStatus =
  (typeof WAGER_TRANSACTION_STATUSES)[number];

export function isTerminalStatus(status: WagerTransactionStatus): boolean {
  return status === "PROCESSED" || status === "REJECTED" || status === "FAILED";
}

export function isReversalKind(kind: WagerTransactionKind): boolean {
  return kind === "REFUND" || kind === "ROLLBACK";
}
