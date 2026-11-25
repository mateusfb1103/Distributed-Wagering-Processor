import { createHash } from "node:crypto";

export interface WagerPayloadHashInput {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: string;
  readonly money: {
    readonly amount: string;
    readonly currency: string;
  };
  readonly referenceExternalTransactionId?: string | null;
}

/**
 * Serialização determinística estilo RFC 8785 (chaves ordenadas lexicograficamente,
 * sem espaços, omitindo chaves com valor `undefined`).
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items = value.map((item) =>
      item === undefined ? "null" : canonicalizeJson(item),
    );
    return `[${items.join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort();
  const parts: string[] = [];

  for (const key of sortedKeys) {
    const entry = record[key];
    if (entry === undefined) {
      continue;
    }
    parts.push(`${JSON.stringify(key)}:${canonicalizeJson(entry)}`);
  }

  return `{${parts.join(",")}}`;
}

/**
 * Calcula `SHA-256` (hex minúsculo) do subconjunto de negócio compartilhado entre HTTP e SQS (D12).
 * `referenceExternalTransactionId` é omitido quando ausente ou `null`.
 */
export function hashWagerPayload(input: WagerPayloadHashInput): string {
  const normalized: Record<string, unknown> = {
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId,
    gameId: input.gameId,
    kind: input.kind,
    money: {
      amount: input.money.amount,
      currency: input.money.currency,
    },
  };

  if (
    input.referenceExternalTransactionId !== undefined &&
    input.referenceExternalTransactionId !== null
  ) {
    normalized.referenceExternalTransactionId =
      input.referenceExternalTransactionId;
  }

  return createHash("sha256")
    .update(canonicalizeJson(normalized), "utf8")
    .digest("hex");
}

/**
 * Calcula `SHA-256` (hex minúsculo) do corpo bruto da mensagem SQS para a inbox (D12).
 */
export function hashRawMessageBody(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("hex");
}
