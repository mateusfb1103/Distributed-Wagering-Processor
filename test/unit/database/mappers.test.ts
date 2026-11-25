import { describe, expect, test } from "bun:test";
import { domainEventToOutboxRecord } from "../../../src/messaging/infrastructure/persistence/outbox.mapper.ts";
import { Money } from "../../../src/shared/domain/money.ts";
import { buildWagerProcessedEvent } from "../../../src/wagering/domain/wager-events.ts";
import { WagerTransaction } from "../../../src/wagering/domain/wager-transaction.ts";
import {
  wagerTransactionToDomain,
  wagerTransactionToRecord,
} from "../../../src/wagering/infrastructure/persistence/wager-transaction.mapper.ts";
import { Wallet } from "../../../src/wallet/domain/wallet.ts";
import {
  ledgerEntryToDomain,
  ledgerEntryToRecord,
  walletToDomain,
  walletToRecord,
} from "../../../src/wallet/infrastructure/persistence/wallet.mapper.ts";

describe("Persistence Mappers (D05 rehydrate)", () => {
  const now = new Date("2026-11-25T12:00:00.000Z");

  test("round-trips Wallet and WalletLedgerEntry via rehydrate", () => {
    const { wallet, openingLedgerEntry } = Wallet.create({
      id: "w-1",
      playerId: "p-1",
      initialBalance: Money.fromString("150.25", "BRL"),
      now,
      openingTransactionId: "tx-open-1",
      openingLedgerEntryId: "le-open-1",
    });

    const walletRec = walletToRecord(wallet);
    expect(walletRec.balance).toBe("150.25");
    expect(walletRec.version).toBe(1);

    const restoredWallet = walletToDomain(walletRec);
    expect(restoredWallet.id).toBe(wallet.id);
    expect(restoredWallet.balance.equals(wallet.balance)).toBe(true);
    expect(restoredWallet.version).toBe(1);

    const ledgerRec = ledgerEntryToRecord(openingLedgerEntry!);
    const restoredLedger = ledgerEntryToDomain(ledgerRec);
    expect(restoredLedger.direction).toBe("CREDIT");
    expect(restoredLedger.amount.toString()).toBe("150.25");
    expect(restoredLedger.balanceBefore.toString()).toBe("0.00");
    expect(restoredLedger.balanceAfter.toString()).toBe("150.25");
  });

  test("round-trips WagerTransaction (PROCESSED and PENDING_REFERENCE) and OutboxRecord", () => {
    const processed = WagerTransaction.createProcessed({
      id: "tx-1",
      providerId: "prov-1",
      idempotencyKey: "idem-1",
      externalTransactionId: "ext-1",
      playerId: "p-1",
      walletId: "w-1",
      roundId: "r-1",
      gameId: "g-1",
      kind: "BET",
      money: Money.fromString("25.00", "BRL"),
      payloadHash: "abc",
      referenceExternalTransactionId: null,
      referenceTransactionId: null,
      resultBalance: Money.fromString("75.00", "BRL"),
      resultWalletVersion: 2,
      now,
    });

    const txRec = wagerTransactionToRecord(processed);
    const restoredTx = wagerTransactionToDomain(txRec);
    expect(restoredTx.status).toBe("PROCESSED");
    expect(restoredTx.resultBalance?.toString()).toBe("75.00");
    expect(restoredTx.processedAt?.toISOString()).toBe(now.toISOString());

    const pending = WagerTransaction.createPendingReference({
      id: "tx-2",
      providerId: "prov-1",
      idempotencyKey: "idem-2",
      externalTransactionId: "ext-2",
      playerId: "p-1",
      walletId: "w-1",
      roundId: "r-1",
      gameId: "g-1",
      kind: "ROLLBACK",
      money: Money.fromString("25.00", "BRL"),
      payloadHash: "def",
      referenceExternalTransactionId: "ext-1",
      nextAttemptAt: new Date(now.getTime() + 1000),
      expiresAt: new Date(now.getTime() + 60_000),
      now,
    });

    const restoredPending = wagerTransactionToDomain(
      wagerTransactionToRecord(pending),
    );
    expect(restoredPending.status).toBe("PENDING_REFERENCE");
    expect(restoredPending.resultBalance).toBeNull();
    expect(restoredPending.expiresAt?.getTime()).toBe(now.getTime() + 60_000);

    const event = buildWagerProcessedEvent("evt-1", processed, now);
    const outboxRec = domainEventToOutboxRecord(event, "corr-1", now);
    expect(outboxRec.eventId).toBe("evt-1");
    expect(outboxRec.aggregateId).toBe("w-1");
    expect(outboxRec.correlationId).toBe("corr-1");
    expect(outboxRec.publishedAt).toBeNull();
  });
});
