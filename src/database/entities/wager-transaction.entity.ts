import { defineEntity, p } from "@mikro-orm/core";

export const WagerTransactionSchema = defineEntity({
  name: "WagerTransactionRecord",
  tableName: "wager_transactions",
  properties: {
    id: p.string().primary(),
    providerId: p.string().name("provider_id"),
    idempotencyKey: p.string().name("idempotency_key"),
    externalTransactionId: p.string().name("external_transaction_id"),
    playerId: p.string().name("player_id"),
    walletId: p.string().name("wallet_id"),
    roundId: p.string().name("round_id"),
    gameId: p.string().name("game_id"),
    kind: p.string(),
    amount: p.decimal().precision(20).scale(2).$type<string>(),
    currency: p.string().length(3),
    payloadHash: p.string().name("payload_hash"),
    referenceExternalTransactionId: p
      .string()
      .strictNullable()
      .name("reference_external_transaction_id"),
    referenceTransactionId: p
      .string()
      .strictNullable()
      .name("reference_transaction_id"),
    status: p.string(),
    failureCode: p.string().strictNullable().name("failure_code"),
    resultBalance: p
      .decimal()
      .precision(20)
      .scale(2)
      .$type<string>()
      .strictNullable()
      .name("result_balance"),
    resultWalletVersion: p
      .integer()
      .strictNullable()
      .name("result_wallet_version"),
    attemptCount: p.integer().name("attempt_count"),
    nextAttemptAt: p.datetime().strictNullable().name("next_attempt_at"),
    expiresAt: p.datetime().strictNullable().name("expires_at"),
    processedAt: p.datetime().strictNullable().name("processed_at"),
    createdAt: p.datetime().name("created_at"),
    updatedAt: p.datetime().name("updated_at"),
  },
});

export type WagerTransactionRecord =
  (typeof WagerTransactionSchema)["~entity"];
