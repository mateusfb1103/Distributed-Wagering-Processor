import { describe, expect, test } from "bun:test";
import {
  ContractViolationError,
  InvalidStateTransitionError,
} from "../../../src/shared/domain/domain-error.ts";
import type { FailureCode } from "../../../src/shared/domain/failure-codes.ts";
import type { IdGenerator } from "../../../src/shared/domain/id-generator.ts";
import { Money } from "../../../src/shared/domain/money.ts";
import { hashWagerPayload } from "../../../src/shared/domain/payload-hasher.ts";
import {
  computePendingBackoffMs,
  processNewWagerTransaction,
  retryPendingWagerTransaction,
} from "../../../src/wagering/domain/wager-processor.service.ts";
import { WagerTransaction } from "../../../src/wagering/domain/wager-transaction.ts";
import { Wallet } from "../../../src/wallet/domain/wallet.ts";

class SequenceIdGenerator implements IdGenerator {
  private counter = 0;
  nextId(): string {
    this.counter += 1;
    return `id-${this.counter}`;
  }
}

function makeWallet(balance = "100.00", currency = "BRL"): Wallet {
  return Wallet.rehydrate({
    id: "wallet-1",
    playerId: "player-1",
    currency,
    balance: Money.fromString(balance, currency),
    version: 1,
    createdAt: new Date("2026-11-25T10:00:00.000Z"),
    updatedAt: new Date("2026-11-25T10:00:00.000Z"),
  });
}

function makeCommand(
  overrides: Partial<{
    providerId: string;
    idempotencyKey: string;
    externalTransactionId: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: string;
    amount: string;
    currency: string;
    referenceExternalTransactionId: string | null;
  }> = {},
) {
  const amount = overrides.amount ?? "25.00";
  const currency = overrides.currency ?? "BRL";
  const base = {
    providerId: overrides.providerId ?? "provider-a",
    idempotencyKey: overrides.idempotencyKey ?? "idem-1",
    externalTransactionId: overrides.externalTransactionId ?? "ext-1",
    playerId: overrides.playerId ?? "player-1",
    walletId: overrides.walletId ?? "wallet-1",
    roundId: overrides.roundId ?? "round-1",
    gameId: overrides.gameId ?? "game-1",
    kind: overrides.kind ?? "BET",
    money: Money.fromString(amount, currency),
    referenceExternalTransactionId: overrides.referenceExternalTransactionId,
  };
  return {
    ...base,
    payloadHash: hashWagerPayload({
      ...base,
      money: base.money.toJSON(),
    }),
  };
}

describe("WagerProcessor & WagerTransaction rules", () => {
  const now = new Date("2026-11-25T12:00:00.000Z");
  const ttlMs = 900_000;

  test("validates external contract violations (OPENING, empty key, zero BET, non-zero LOSS, missing/disallowed ref)", () => {
    const idGen = new SequenceIdGenerator();
    const wallet = makeWallet();

    const invalidCases: Array<{
      cmd: ReturnType<typeof makeCommand>;
      code: FailureCode;
    }> = [
      { cmd: makeCommand({ kind: "OPENING" }), code: "UNSUPPORTED_KIND" },
      { cmd: makeCommand({ kind: "CASH_OUT" }), code: "UNSUPPORTED_KIND" },
      { cmd: makeCommand({ idempotencyKey: "  " }), code: "IDEMPOTENCY_KEY_REQUIRED" },
      { cmd: makeCommand({ providerId: "system" }), code: "INVALID_PAYLOAD" },
      { cmd: makeCommand({ kind: "BET", amount: "0.00" }), code: "INVALID_MONEY" },
      { cmd: makeCommand({ kind: "WIN", amount: "0.00" }), code: "INVALID_MONEY" },
      { cmd: makeCommand({ kind: "LOSS", amount: "1.00" }), code: "INVALID_MONEY" },
      { cmd: makeCommand({ kind: "REFUND" }), code: "REFERENCE_REQUIRED" },
      {
        cmd: makeCommand({ kind: "BET", referenceExternalTransactionId: "ext-0" }),
        code: "REFERENCE_NOT_ALLOWED",
      },
    ];

    for (const item of invalidCases) {
      try {
        processNewWagerTransaction({
          command: item.cmd,
          wallet,
          referenceTransaction: null,
          isReferenceAlreadyReversed: false,
          pendingReferenceTtlMs: ttlMs,
          now,
          idGenerator: idGen,
        });
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(ContractViolationError);
        expect((err as ContractViolationError).code).toBe(item.code);
      }
    }
  });

  test("processes BET, WIN and LOSS accurately and rejects INSUFFICIENT_FUNDS", () => {
    const idGen = new SequenceIdGenerator();
    const wallet = makeWallet("100.00");

    const betOutcome = processNewWagerTransaction({
      command: makeCommand({ kind: "BET", amount: "40.00", externalTransactionId: "ext-bet" }),
      wallet,
      referenceTransaction: null,
      isReferenceAlreadyReversed: false,
      pendingReferenceTtlMs: ttlMs,
      now,
      idGenerator: idGen,
    });
    expect(betOutcome.transaction.status).toBe("PROCESSED");
    expect(wallet.balance.toString()).toBe("60.00");
    expect(wallet.version).toBe(2);
    expect(betOutcome.ledgerEntry?.direction).toBe("DEBIT");
    expect(betOutcome.events[0]?.eventType).toBe("WagerTransactionProcessed");

    const winOutcome = processNewWagerTransaction({
      command: makeCommand({ kind: "WIN", amount: "15.00", externalTransactionId: "ext-win", idempotencyKey: "idem-2" }),
      wallet,
      referenceTransaction: null,
      isReferenceAlreadyReversed: false,
      pendingReferenceTtlMs: ttlMs,
      now,
      idGenerator: idGen,
    });
    expect(winOutcome.transaction.status).toBe("PROCESSED");
    expect(wallet.balance.toString()).toBe("75.00");
    expect(wallet.version).toBe(3);
    expect(winOutcome.ledgerEntry?.direction).toBe("CREDIT");

    const lossOutcome = processNewWagerTransaction({
      command: makeCommand({ kind: "LOSS", amount: "0.00", externalTransactionId: "ext-loss", idempotencyKey: "idem-3" }),
      wallet,
      referenceTransaction: null,
      isReferenceAlreadyReversed: false,
      pendingReferenceTtlMs: ttlMs,
      now,
      idGenerator: idGen,
    });
    expect(lossOutcome.transaction.status).toBe("PROCESSED");
    expect(lossOutcome.ledgerEntry).toBeNull();
    expect(wallet.balance.toString()).toBe("75.00");
    expect(wallet.version).toBe(3);

    const rejectedBet = processNewWagerTransaction({
      command: makeCommand({ kind: "BET", amount: "75.01", externalTransactionId: "ext-bet-fail", idempotencyKey: "idem-4" }),
      wallet,
      referenceTransaction: null,
      isReferenceAlreadyReversed: false,
      pendingReferenceTtlMs: ttlMs,
      now,
      idGenerator: idGen,
    });
    expect(rejectedBet.transaction.status).toBe("REJECTED");
    expect(rejectedBet.transaction.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect(rejectedBet.ledgerEntry).toBeNull();
    expect(rejectedBet.events[0]?.eventType).toBe("WagerTransactionRejected");
    expect(wallet.balance.toString()).toBe("75.00");
  });

  test("rejects WALLET_PLAYER_MISMATCH and CURRENCY_MISMATCH as persisted REJECTED", () => {
    const idGen = new SequenceIdGenerator();
    const wallet = makeWallet("100.00", "BRL");

    const playerMismatch = processNewWagerTransaction({
      command: makeCommand({ playerId: "other-player" }),
      wallet,
      referenceTransaction: null,
      isReferenceAlreadyReversed: false,
      pendingReferenceTtlMs: ttlMs,
      now,
      idGenerator: idGen,
    });
    expect(playerMismatch.transaction.status).toBe("REJECTED");
    expect(playerMismatch.transaction.failureCode).toBe("WALLET_PLAYER_MISMATCH");

    const currencyMismatch = processNewWagerTransaction({
      command: makeCommand({ currency: "USD" }),
      wallet,
      referenceTransaction: null,
      isReferenceAlreadyReversed: false,
      pendingReferenceTtlMs: ttlMs,
      now,
      idGenerator: idGen,
    });
    expect(currencyMismatch.transaction.status).toBe("REJECTED");
    expect(currencyMismatch.transaction.failureCode).toBe("CURRENCY_MISMATCH");
  });

  test("REFUND and ROLLBACK enforce reference rules, D03 single reversal, and REVERSAL_INSUFFICIENT_FUNDS", () => {
    const idGen = new SequenceIdGenerator();
    const wallet = makeWallet("100.00");

    const betOutcome = processNewWagerTransaction({
      command: makeCommand({ kind: "BET", amount: "30.00", externalTransactionId: "ext-bet-1" }),
      wallet,
      referenceTransaction: null,
      isReferenceAlreadyReversed: false,
      pendingReferenceTtlMs: ttlMs,
      now,
      idGenerator: idGen,
    });
    const betTx = betOutcome.transaction;

    // REFUND válido da BET
    const refundOutcome = processNewWagerTransaction({
      command: makeCommand({
        kind: "REFUND",
        amount: "30.00",
        externalTransactionId: "ext-refund-1",
        idempotencyKey: "idem-refund-1",
        referenceExternalTransactionId: "ext-bet-1",
      }),
      wallet,
      referenceTransaction: betTx,
      isReferenceAlreadyReversed: false,
      pendingReferenceTtlMs: ttlMs,
      now,
      idGenerator: idGen,
    });
    expect(refundOutcome.transaction.status).toBe("PROCESSED");
    expect(refundOutcome.transaction.referenceTransactionId).toBe(betTx.id);
    expect(wallet.balance.toString()).toBe("100.00");

    // D03: ROLLBACK após REFUND da mesma BET → REFERENCE_ALREADY_REVERSED
    const dupReversal = processNewWagerTransaction({
      command: makeCommand({
        kind: "ROLLBACK",
        amount: "30.00",
        externalTransactionId: "ext-rb-1",
        idempotencyKey: "idem-rb-1",
        referenceExternalTransactionId: "ext-bet-1",
      }),
      wallet,
      referenceTransaction: betTx,
      isReferenceAlreadyReversed: true,
      pendingReferenceTtlMs: ttlMs,
      now,
      idGenerator: idGen,
    });
    expect(dupReversal.transaction.status).toBe("REJECTED");
    expect(dupReversal.transaction.failureCode).toBe("REFERENCE_ALREADY_REVERSED");

    // WIN de 50.00 seguido de gasto de 130.00 → saldo 20.00; ROLLBACK da WIN falha com REVERSAL_INSUFFICIENT_FUNDS
    const winOutcome = processNewWagerTransaction({
      command: makeCommand({
        kind: "WIN",
        amount: "50.00",
        externalTransactionId: "ext-win-1",
        idempotencyKey: "idem-win-1",
      }),
      wallet,
      referenceTransaction: null,
      isReferenceAlreadyReversed: false,
      pendingReferenceTtlMs: ttlMs,
      now,
      idGenerator: idGen,
    });
    const winTx = winOutcome.transaction;

    // REFUND sobre WIN não é permitido
    const refundOnWin = processNewWagerTransaction({
      command: makeCommand({
        kind: "REFUND",
        amount: "50.00",
        externalTransactionId: "ext-refund-win",
        idempotencyKey: "idem-refund-win",
        referenceExternalTransactionId: "ext-win-1",
      }),
      wallet,
      referenceTransaction: winTx,
      isReferenceAlreadyReversed: false,
      pendingReferenceTtlMs: ttlMs,
      now,
      idGenerator: idGen,
    });
    expect(refundOnWin.transaction.failureCode).toBe("REFERENCE_KIND_NOT_ALLOWED");

    // Gasta 130.00 deixando 20.00
    processNewWagerTransaction({
      command: makeCommand({
        kind: "BET",
        amount: "130.00",
        externalTransactionId: "ext-bet-2",
        idempotencyKey: "idem-bet-2",
      }),
      wallet,
      referenceTransaction: null,
      isReferenceAlreadyReversed: false,
      pendingReferenceTtlMs: ttlMs,
      now,
      idGenerator: idGen,
    });
    expect(wallet.balance.toString()).toBe("20.00");

    const rollbackWinInsufficient = processNewWagerTransaction({
      command: makeCommand({
        kind: "ROLLBACK",
        amount: "50.00",
        externalTransactionId: "ext-rb-win",
        idempotencyKey: "idem-rb-win",
        referenceExternalTransactionId: "ext-win-1",
      }),
      wallet,
      referenceTransaction: winTx,
      isReferenceAlreadyReversed: false,
      pendingReferenceTtlMs: ttlMs,
      now,
      idGenerator: idGen,
    });
    expect(rollbackWinInsufficient.transaction.status).toBe("REJECTED");
    expect(rollbackWinInsufficient.transaction.failureCode).toBe(
      "REVERSAL_INSUFFICIENT_FUNDS",
    );
    expect(wallet.balance.toString()).toBe("20.00");
  });

  test("validates AMOUNT_MISMATCH, REFERENCE_MISMATCH and REFERENCE_NOT_PROCESSED", () => {
    const idGen = new SequenceIdGenerator();
    const wallet = makeWallet("100.00");

    const rejectedBet = processNewWagerTransaction({
      command: makeCommand({ kind: "BET", amount: "500.00", externalTransactionId: "ext-bet-rej" }),
      wallet,
      referenceTransaction: null,
      isReferenceAlreadyReversed: false,
      pendingReferenceTtlMs: ttlMs,
      now,
      idGenerator: idGen,
    }).transaction;

    const refNotProcessed = processNewWagerTransaction({
      command: makeCommand({
        kind: "REFUND",
        amount: "500.00",
        externalTransactionId: "ext-ref-1",
        idempotencyKey: "idem-ref-1",
        referenceExternalTransactionId: "ext-bet-rej",
      }),
      wallet,
      referenceTransaction: rejectedBet,
      isReferenceAlreadyReversed: false,
      pendingReferenceTtlMs: ttlMs,
      now,
      idGenerator: idGen,
    });
    expect(refNotProcessed.transaction.failureCode).toBe("REFERENCE_NOT_PROCESSED");

    const okBet = processNewWagerTransaction({
      command: makeCommand({
        kind: "BET",
        amount: "20.00",
        externalTransactionId: "ext-bet-ok",
        idempotencyKey: "idem-bet-ok",
      }),
      wallet,
      referenceTransaction: null,
      isReferenceAlreadyReversed: false,
      pendingReferenceTtlMs: ttlMs,
      now,
      idGenerator: idGen,
    }).transaction;

    const amountMismatch = processNewWagerTransaction({
      command: makeCommand({
        kind: "REFUND",
        amount: "10.00",
        externalTransactionId: "ext-ref-2",
        idempotencyKey: "idem-ref-2",
        referenceExternalTransactionId: "ext-bet-ok",
      }),
      wallet,
      referenceTransaction: okBet,
      isReferenceAlreadyReversed: false,
      pendingReferenceTtlMs: ttlMs,
      now,
      idGenerator: idGen,
    });
    expect(amountMismatch.transaction.failureCode).toBe("AMOUNT_MISMATCH");

    const roundMismatch = processNewWagerTransaction({
      command: makeCommand({
        kind: "REFUND",
        amount: "20.00",
        roundId: "other-round",
        externalTransactionId: "ext-ref-3",
        idempotencyKey: "idem-ref-3",
        referenceExternalTransactionId: "ext-bet-ok",
      }),
      wallet,
      referenceTransaction: okBet,
      isReferenceAlreadyReversed: false,
      pendingReferenceTtlMs: ttlMs,
      now,
      idGenerator: idGen,
    });
    expect(roundMismatch.transaction.failureCode).toBe("REFERENCE_MISMATCH");
  });

  test("PENDING_REFERENCE lifecycle: backoff, no duplicate pending event, resolution on wake-up, and TTL expiration (D11)", () => {
    expect(computePendingBackoffMs(1)).toBe(1000);
    expect(computePendingBackoffMs(2)).toBe(2000);
    expect(computePendingBackoffMs(3)).toBe(4000);
    expect(computePendingBackoffMs(7)).toBe(60000);

    const idGen = new SequenceIdGenerator();
    const wallet = makeWallet("100.00");

    // 1. ROLLBACK chega antes da BET → PENDING_REFERENCE
    const pendingOutcome = processNewWagerTransaction({
      command: makeCommand({
        kind: "ROLLBACK",
        amount: "25.00",
        externalTransactionId: "ext-rb-early",
        idempotencyKey: "idem-rb-early",
        referenceExternalTransactionId: "ext-bet-late",
      }),
      wallet,
      referenceTransaction: null,
      isReferenceAlreadyReversed: false,
      pendingReferenceTtlMs: 10_000,
      now,
      idGenerator: idGen,
    });
    const pendingTx = pendingOutcome.transaction;
    expect(pendingTx.status).toBe("PENDING_REFERENCE");
    expect(pendingTx.attemptCount).toBe(1);
    expect(pendingOutcome.events[0]?.eventType).toBe(
      "WagerTransactionPendingReference",
    );

    // 2. Retry intermediário sem referência antes do TTL → reagenda sem republicar evento
    const retry1 = retryPendingWagerTransaction({
      existingTransaction: pendingTx,
      wallet,
      referenceTransaction: null,
      isReferenceAlreadyReversed: false,
      now: new Date(now.getTime() + 1_000),
      idGenerator: idGen,
    });
    expect(retry1.transaction.status).toBe("PENDING_REFERENCE");
    expect(retry1.transaction.attemptCount).toBe(2);
    expect(retry1.events).toHaveLength(0);

    // 3. BET chega e depois o wake-up processa o ROLLBACK pendente
    const lateBet = processNewWagerTransaction({
      command: makeCommand({
        kind: "BET",
        amount: "25.00",
        externalTransactionId: "ext-bet-late",
        idempotencyKey: "idem-bet-late",
      }),
      wallet,
      referenceTransaction: null,
      isReferenceAlreadyReversed: false,
      pendingReferenceTtlMs: 10_000,
      now: new Date(now.getTime() + 2_000),
      idGenerator: idGen,
    }).transaction;
    expect(wallet.balance.toString()).toBe("75.00");

    const resolved = retryPendingWagerTransaction({
      existingTransaction: pendingTx,
      wallet,
      referenceTransaction: lateBet,
      isReferenceAlreadyReversed: false,
      now: new Date(now.getTime() + 2_000),
      idGenerator: idGen,
    });
    expect(resolved.transaction.status).toBe("PROCESSED");
    expect(resolved.transaction.referenceTransactionId).toBe(lateBet.id);
    expect(wallet.balance.toString()).toBe("100.00");
    expect(resolved.events[0]?.eventType).toBe("WagerTransactionProcessed");

    // 4. Transação terminal não aceita novas transições
    expect(() =>
      pendingTx.markRejected({
        failureCode: "REFERENCE_NOT_FOUND",
        resultBalance: wallet.balance,
        resultWalletVersion: wallet.version,
        now,
      }),
    ).toThrow(InvalidStateTransitionError);

    // 5. Expiração do TTL sem referência → REJECTED REFERENCE_NOT_FOUND
    const expiringTx = processNewWagerTransaction({
      command: makeCommand({
        kind: "REFUND",
        amount: "10.00",
        externalTransactionId: "ext-ref-exp",
        idempotencyKey: "idem-ref-exp",
        referenceExternalTransactionId: "ext-missing",
      }),
      wallet,
      referenceTransaction: null,
      isReferenceAlreadyReversed: false,
      pendingReferenceTtlMs: 5_000,
      now,
      idGenerator: idGen,
    }).transaction;

    const expiredOutcome = retryPendingWagerTransaction({
      existingTransaction: expiringTx,
      wallet,
      referenceTransaction: null,
      isReferenceAlreadyReversed: false,
      now: new Date(now.getTime() + 5_000),
      idGenerator: idGen,
    });
    expect(expiredOutcome.transaction.status).toBe("REJECTED");
    expect(expiredOutcome.transaction.failureCode).toBe("REFERENCE_NOT_FOUND");
    expect(expiredOutcome.events[0]?.eventType).toBe("WagerTransactionRejected");
  });

  test("WagerTransaction.createOpening initializes OPENING transaction in PROCESSED state", () => {
    const opening = WagerTransaction.createOpening({
      id: "tx-open",
      walletId: "wallet-1",
      playerId: "player-1",
      money: Money.fromString("50.00", "BRL"),
      payloadHash: "hash",
      now,
    });
    expect(opening.kind).toBe("OPENING");
    expect(opening.providerId).toBe("system");
    expect(opening.status).toBe("PROCESSED");
    expect(opening.resultBalance?.toString()).toBe("50.00");
  });

  test("ROLLBACK over REFUND debits credited amount (§7 rule 3) and WalletBalanceChanged is emitted only when balance changes (§11)", () => {
    const idGen = new SequenceIdGenerator();
    const wallet = makeWallet("100.00");

    const betOutcome = processNewWagerTransaction({
      command: makeCommand({
        kind: "BET",
        amount: "30.00",
        externalTransactionId: "ext-b-1",
      }),
      wallet,
      referenceTransaction: null,
      isReferenceAlreadyReversed: false,
      pendingReferenceTtlMs: ttlMs,
      now,
      idGenerator: idGen,
    });
    expect(betOutcome.events.map((e) => e.eventType)).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);

    const lossOutcome = processNewWagerTransaction({
      command: makeCommand({
        kind: "LOSS",
        amount: "0.00",
        externalTransactionId: "ext-l-1",
        idempotencyKey: "idem-l-1",
      }),
      wallet,
      referenceTransaction: null,
      isReferenceAlreadyReversed: false,
      pendingReferenceTtlMs: ttlMs,
      now,
      idGenerator: idGen,
    });
    expect(lossOutcome.events.map((e) => e.eventType)).toEqual([
      "WagerTransactionProcessed",
    ]);

    const refundOutcome = processNewWagerTransaction({
      command: makeCommand({
        kind: "REFUND",
        amount: "30.00",
        externalTransactionId: "ext-r-1",
        idempotencyKey: "idem-r-1",
        referenceExternalTransactionId: "ext-b-1",
      }),
      wallet,
      referenceTransaction: betOutcome.transaction,
      isReferenceAlreadyReversed: false,
      pendingReferenceTtlMs: ttlMs,
      now,
      idGenerator: idGen,
    });
    expect(refundOutcome.transaction.status).toBe("PROCESSED");
    expect(wallet.balance.toString()).toBe("100.00");

    const rollbackRefund = processNewWagerTransaction({
      command: makeCommand({
        kind: "ROLLBACK",
        amount: "30.00",
        externalTransactionId: "ext-rb-r-1",
        idempotencyKey: "idem-rb-r-1",
        referenceExternalTransactionId: "ext-r-1",
      }),
      wallet,
      referenceTransaction: refundOutcome.transaction,
      isReferenceAlreadyReversed: false,
      pendingReferenceTtlMs: ttlMs,
      now,
      idGenerator: idGen,
    });
    expect(rollbackRefund.transaction.status).toBe("PROCESSED");
    expect(rollbackRefund.ledgerEntry?.direction).toBe("DEBIT");
    expect(wallet.balance.toString()).toBe("70.00");
    expect(rollbackRefund.events.map((e) => e.eventType)).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
  });
});
