import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { MikroORM, type EntityManager } from "@mikro-orm/postgresql";
import { AppModule } from "../../src/app.module.ts";
import { runMigrations } from "../../src/database/migrate.ts";
import { buildMikroOrmConfig } from "../../src/database/mikro-orm.config.ts";
import { OutboxMessageSchema } from "../../src/database/entities/outbox-message.entity.ts";
import { WagerTransactionSchema } from "../../src/database/entities/wager-transaction.entity.ts";
import { WalletLedgerEntrySchema } from "../../src/database/entities/wallet-ledger-entry.entity.ts";
import { WalletSchema } from "../../src/database/entities/wallet.entity.ts";

describe("Fase 2 — Schema PostgreSQL (D03, D05, D06 R-a/R-b/R-c/R-d)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let migratorOrm: MikroORM;

  beforeAll(async () => {
    await runMigrations("up");
    migratorOrm = await MikroORM.init(buildMikroOrmConfig("migrator"));
    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0);
    const address = app.getHttpServer().address();
    if (!address || typeof address === "string") {
      throw new Error("Unexpected HTTP server address");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await migratorOrm?.close(true);
    await app?.close();
  });

  test("NestJS inicializa com todas as entidades MikroORM 7 e responde GET /health/live", async () => {
    const res = await fetch(`${baseUrl}/health/live`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("Migrations executam down → up de forma completamente reversível", async () => {
    const appOrm = app.get(MikroORM);
    const em = appOrm.em.fork() as EntityManager;

    const downExecuted = await runMigrations("down");
    expect(downExecuted).toContain("Migration20261125000001_CreateCoreSchema");

    const tablesAfterDown = await em.execute<{ count: string }[]>(
      `SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('wallets','wager_transactions','wallet_ledger_entries','inbox_messages','outbox_messages')`,
    );
    expect(tablesAfterDown[0]?.count).toBe("0");

    const upExecuted = await runMigrations("up");
    expect(upExecuted).toContain("Migration20261125000001_CreateCoreSchema");

    const tablesAfterUp = await em.execute<{ count: string }[]>(
      `SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('wallets','wager_transactions','wallet_ledger_entries','inbox_messages','outbox_messages')`,
    );
    expect(tablesAfterUp[0]?.count).toBe("5");
  });

  test("R-d: role dwp_app não executa DDL nem UPDATE/DELETE/TRUNCATE em wallet_ledger_entries", async () => {
    const appOrm = app.get(MikroORM);
    const em = appOrm.em.fork() as EntityManager;

    await expect(
      em.execute("CREATE TABLE _forbidden_ddl (id INT)"),
    ).rejects.toThrow();

    await expect(
      em.execute("UPDATE wallet_ledger_entries SET amount = '1.00'"),
    ).rejects.toThrow();

    await expect(
      em.execute("DELETE FROM wallet_ledger_entries"),
    ).rejects.toThrow();

    await expect(
      em.execute("TRUNCATE TABLE wallet_ledger_entries"),
    ).rejects.toThrow();
  });

  test("R-b e R-c: wallets exige incremento exato de version com balance e lançamento correspondente no ledger", async () => {
    const appOrm = app.get(MikroORM);
    const em = appOrm.em.fork() as EntityManager;
    const now = new Date();
    const walletId = Bun.randomUUIDv7();
    const playerId = `player-${Bun.randomUUIDv7()}`;
    const openTxId = Bun.randomUUIDv7();
    const openLedgerId = Bun.randomUUIDv7();

    // R-c: inserir wallet com balance > 0 sem ledger falha no COMMIT
    await expect(
      em.transactional(async (tx) => {
        tx.create(WalletSchema, {
          id: Bun.randomUUIDv7(),
          playerId: `player-no-ledger-${Bun.randomUUIDv7()}`,
          currency: "BRL",
          balance: "50.00",
          version: 1,
          createdAt: now,
          updatedAt: now,
        });
        await tx.flush();
      }),
    ).rejects.toThrow();

    // Fluxo válido: wallet + OPENING transaction + ledger entry na mesma transação (R-c verifica no COMMIT)
    await em.transactional(async (tx) => {
      tx.create(WalletSchema, {
        id: walletId,
        playerId,
        currency: "BRL",
        balance: "100.00",
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      await tx.flush();

      tx.create(WagerTransactionSchema, {
        id: openTxId,
        providerId: "system",
        idempotencyKey: `opening:${walletId}`,
        externalTransactionId: `opening:${walletId}`,
        playerId,
        walletId,
        roundId: `opening:${walletId}`,
        gameId: "system",
        kind: "OPENING",
        amount: "100.00",
        currency: "BRL",
        payloadHash: "open-hash",
        referenceExternalTransactionId: null,
        referenceTransactionId: null,
        status: "PROCESSED",
        failureCode: null,
        resultBalance: "100.00",
        resultWalletVersion: 1,
        attemptCount: 1,
        nextAttemptAt: null,
        expiresAt: null,
        processedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await tx.flush();

      tx.create(WalletLedgerEntrySchema, {
        id: openLedgerId,
        walletId,
        currency: "BRL",
        transactionId: openTxId,
        direction: "CREDIT",
        amount: "100.00",
        balanceBefore: "0.00",
        balanceAfter: "100.00",
        walletVersion: 1,
        createdAt: now,
      });
      await tx.flush();
    });

    // R-b: atualizar balance sem incrementar version falha no trigger BEFORE UPDATE
    await expect(
      em.execute(
        `UPDATE wallets SET balance = '90.00' WHERE id = ?`,
        [walletId],
      ),
    ).rejects.toThrow();

    // R-b: incrementar version sem mudar balance falha
    await expect(
      em.execute(
        `UPDATE wallets SET version = 2 WHERE id = ?`,
        [walletId],
      ),
    ).rejects.toThrow();

    // R-c: atualizar balance e version corretamente mas sem inserir ledger falha no COMMIT
    await expect(
      em.transactional(async (tx) => {
        await tx.execute(
          `UPDATE wallets SET balance = '90.00', version = 2 WHERE id = ?`,
          [walletId],
        );
      }),
    ).rejects.toThrow();

    // FK composta de moeda: ledger com currency USD em wallet BRL falha especificamente em fk_ledger_wallet_currency
    const badCurrencyTxId = Bun.randomUUIDv7();
    await expect(
      em.transactional(async (tx) => {
        tx.create(WagerTransactionSchema, {
          id: badCurrencyTxId,
          providerId: "prov-1",
          idempotencyKey: `idem-${badCurrencyTxId}`,
          externalTransactionId: `ext-${badCurrencyTxId}`,
          playerId,
          walletId,
          roundId: "r-1",
          gameId: "g-1",
          kind: "BET",
          amount: "10.00",
          currency: "USD",
          payloadHash: "h",
          referenceExternalTransactionId: null,
          referenceTransactionId: null,
          status: "PROCESSED",
          failureCode: null,
          resultBalance: "90.00",
          resultWalletVersion: 2,
          attemptCount: 1,
          nextAttemptAt: null,
          expiresAt: null,
          processedAt: now,
          createdAt: now,
          updatedAt: now,
        });
        await tx.flush();

        await tx.execute(
          `UPDATE wallets SET balance = '90.00', version = 2 WHERE id = ?`,
          [walletId],
        );
        tx.create(WalletLedgerEntrySchema, {
          id: Bun.randomUUIDv7(),
          walletId,
          currency: "USD",
          transactionId: badCurrencyTxId,
          direction: "DEBIT",
          amount: "10.00",
          balanceBefore: "100.00",
          balanceAfter: "90.00",
          walletVersion: 2,
          createdAt: now,
        });
        await tx.flush();
      }),
    ).rejects.toThrow(/fk_ledger_wallet_currency/);
  });

  test("R-a, D03 e imutabilidade da outbox no PostgreSQL", async () => {
    const appOrm = app.get(MikroORM);
    const em = appOrm.em.fork() as EntityManager;
    const now = new Date();
    const walletId = Bun.randomUUIDv7();
    const playerId = `player-${Bun.randomUUIDv7()}`;
    const betTxId = Bun.randomUUIDv7();
    const refundTxId = Bun.randomUUIDv7();
    const pendingTxId = Bun.randomUUIDv7();
    const eventId = Bun.randomUUIDv7();

    await em.transactional(async (tx) => {
      tx.create(WalletSchema, {
        id: walletId,
        playerId,
        currency: "BRL",
        balance: "0.00",
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      await tx.flush();

      // BET processada (simulada diretamente para teste de schema)
      tx.create(WagerTransactionSchema, {
        id: betTxId,
        providerId: "prov-1",
        idempotencyKey: `idem-bet-${betTxId}`,
        externalTransactionId: `ext-bet-${betTxId}`,
        playerId,
        walletId,
        roundId: "r-1",
        gameId: "g-1",
        kind: "BET",
        amount: "10.00",
        currency: "BRL",
        payloadHash: "h-bet",
        referenceExternalTransactionId: null,
        referenceTransactionId: null,
        status: "PROCESSED",
        failureCode: null,
        resultBalance: "0.00",
        resultWalletVersion: 1,
        attemptCount: 1,
        nextAttemptAt: null,
        expiresAt: null,
        processedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      // REFUND PROCESSED referenciando betTxId
      tx.create(WagerTransactionSchema, {
        id: refundTxId,
        providerId: "prov-1",
        idempotencyKey: `idem-ref-${refundTxId}`,
        externalTransactionId: `ext-ref-${refundTxId}`,
        playerId,
        walletId,
        roundId: "r-1",
        gameId: "g-1",
        kind: "REFUND",
        amount: "10.00",
        currency: "BRL",
        payloadHash: "h-ref",
        referenceExternalTransactionId: `ext-bet-${betTxId}`,
        referenceTransactionId: betTxId,
        status: "PROCESSED",
        failureCode: null,
        resultBalance: "10.00",
        resultWalletVersion: 1,
        attemptCount: 1,
        nextAttemptAt: null,
        expiresAt: null,
        processedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      // Transação PENDING_REFERENCE para testar bloqueio de colunas imutáveis
      tx.create(WagerTransactionSchema, {
        id: pendingTxId,
        providerId: "prov-1",
        idempotencyKey: `idem-pend-${pendingTxId}`,
        externalTransactionId: `ext-pend-${pendingTxId}`,
        playerId,
        walletId,
        roundId: "r-2",
        gameId: "g-1",
        kind: "ROLLBACK",
        amount: "10.00",
        currency: "BRL",
        payloadHash: "h-pend",
        referenceExternalTransactionId: "ext-missing",
        referenceTransactionId: null,
        status: "PENDING_REFERENCE",
        failureCode: null,
        resultBalance: null,
        resultWalletVersion: null,
        attemptCount: 1,
        nextAttemptAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
        processedAt: null,
        createdAt: now,
        updatedAt: now,
      });

      // Outbox message
      tx.create(OutboxMessageSchema, {
        eventId,
        aggregateType: "WagerTransaction",
        aggregateId: walletId,
        eventType: "WagerTransactionProcessed",
        payload: { transactionId: betTxId },
        correlationId: "corr-1",
        occurredAt: now,
        createdAt: now,
        attemptCount: 0,
        nextAttemptAt: now,
        lockedBy: null,
        lockedUntil: null,
        publishedAt: null,
        lastError: null,
      });

      await tx.flush();
    });

    // R-a: alterar status terminal ou deletar wager_transactions falha
    await expect(
      em.execute(
        `UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'INSUFFICIENT_FUNDS', processed_at = NULL WHERE id = ?`,
        [betTxId],
      ),
    ).rejects.toThrow();

    await expect(
      em.execute(`DELETE FROM wager_transactions WHERE id = ?`, [betTxId]),
    ).rejects.toThrow();

    // R-a: alterar coluna imutável em PENDING_REFERENCE falha
    await expect(
      em.execute(
        `UPDATE wager_transactions SET amount = '99.00' WHERE id = ?`,
        [pendingTxId],
      ),
    ).rejects.toThrow();

    // D03: segunda reversão PROCESSED (ROLLBACK) sobre mesma betTxId falha por índice único parcial
    await expect(
      em.transactional(async (tx) => {
        tx.create(WagerTransactionSchema, {
          id: Bun.randomUUIDv7(),
          providerId: "prov-1",
          idempotencyKey: `idem-rb-dup-${Bun.randomUUIDv7()}`,
          externalTransactionId: `ext-rb-dup-${Bun.randomUUIDv7()}`,
          playerId,
          walletId,
          roundId: "r-1",
          gameId: "g-1",
          kind: "ROLLBACK",
          amount: "10.00",
          currency: "BRL",
          payloadHash: "h-rb",
          referenceExternalTransactionId: `ext-bet-${betTxId}`,
          referenceTransactionId: betTxId,
          status: "PROCESSED",
          failureCode: null,
          resultBalance: "20.00",
          resultWalletVersion: 1,
          attemptCount: 1,
          nextAttemptAt: null,
          expiresAt: null,
          processedAt: now,
          createdAt: now,
          updatedAt: now,
        });
        await tx.flush();
      }),
    ).rejects.toThrow();

    // Outbox: alterar payload falha, mas marcar published_at funciona
    await expect(
      em.execute(
        `UPDATE outbox_messages SET payload = '{"tampered":true}'::jsonb WHERE event_id = ?`,
        [eventId],
      ),
    ).rejects.toThrow();

    await em.execute(
      `UPDATE outbox_messages SET published_at = now() WHERE event_id = ?`,
      [eventId],
    );
  });
});
