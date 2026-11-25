import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { type EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { initQueues } from "../../infra/sqs/init-queues.ts";
import { AppModule } from "../../src/app.module.ts";
import { runMigrations } from "../../src/database/migrate.ts";

describe("Fase 3 — API HTTP, Casos de Uso e Reconciliação", () => {
  let app: INestApplication;
  let baseUrl: string;
  let em: EntityManager;

  beforeAll(async () => {
    await runMigrations("up");
    await initQueues();
    app = await NestFactory.create(AppModule, { logger: false });
    await app.init();
    await app.listen(0);
    const address = app.getHttpServer().address();
    if (!address || typeof address === "string") {
      throw new Error("Unexpected HTTP server address");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    em = app.get(MikroORM).em.fork() as EntityManager;
  });

  afterAll(async () => {
    await app?.close();
  });

  async function postJson(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, headers: res.headers, json };
  }

  test("Health (live & ready), X-Correlation-Id e Prometheus /metrics", async () => {
    const live = await fetch(`${baseUrl}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: "ok" });
    expect(live.headers.get("x-correlation-id")).toBeTruthy();

    const ready = await fetch(`${baseUrl}/health/ready`, {
      headers: { "x-correlation-id": "corr-custom-123" },
    });
    expect(ready.status).toBe(200);
    expect(ready.headers.get("x-correlation-id")).toBe("corr-custom-123");
    expect(await ready.json()).toEqual({
      status: "ready",
      checks: { postgres: "up", sqs: "up" },
    });

    const metricsRes = await fetch(`${baseUrl}/metrics`);
    expect(metricsRes.status).toBe(200);
    const metricsText = await metricsRes.text();
    expect(metricsText).toContain("dwp_wager_transactions_total");
    expect(metricsText).toContain("dwp_wallet_lock_contention_total");
  });

  test("Wallets: criação (0.00 e positiva), conflito 409, GET 200/404 e paginação do ledger", async () => {
    const playerId = `player-${Bun.randomUUIDv7()}`;

    const zeroRes = await postJson("/wallets", {
      playerId,
      initialBalance: "0.00",
      currency: "USD",
    });
    expect(zeroRes.status).toBe(201);
    expect(zeroRes.json.balance).toBe("0.00");
    expect(zeroRes.json.version).toBe(1);

    // Duplicada mesmo playerId + currency -> 409 WALLET_ALREADY_EXISTS
    const dupRes = await postJson("/wallets", {
      playerId,
      initialBalance: "10.00",
      currency: "USD",
    });
    expect(dupRes.status).toBe(409);
    expect(dupRes.json.code).toBe("WALLET_ALREADY_EXISTS");

    // Wallet positiva BRL -> gera OPENING + ledger
    const brlRes = await postJson("/wallets", {
      playerId,
      initialBalance: "100.00",
      currency: "BRL",
    });
    expect(brlRes.status).toBe(201);
    const walletId = brlRes.json.walletId as string;

    const getRes = await fetch(`${baseUrl}/wallets/${walletId}`);
    expect(getRes.status).toBe(200);
    expect(((await getRes.json()) as Record<string, unknown>).balance).toBe(
      "100.00",
    );

    const notFoundRes = await fetch(
      `${baseUrl}/wallets/${Bun.randomUUIDv7()}`,
    );
    expect(notFoundRes.status).toBe(404);

    // Executa 2 operações para gerar 3 entradas no ledger e testar paginação limit=2
    await postJson(
      "/wager-transactions",
      {
        providerId: "prov-http",
        externalTransactionId: `ext-b1-${walletId}`,
        playerId,
        walletId,
        roundId: "r-1",
        gameId: "g-1",
        kind: "BET",
        money: { amount: "20.00", currency: "BRL" },
      },
      { "Idempotency-Key": `idem-b1-${walletId}` },
    );

    await postJson(
      "/wager-transactions",
      {
        providerId: "prov-http",
        externalTransactionId: `ext-w1-${walletId}`,
        playerId,
        walletId,
        roundId: "r-1",
        gameId: "g-1",
        kind: "WIN",
        money: { amount: "50.00", currency: "BRL" },
      },
      { "Idempotency-Key": `idem-w1-${walletId}` },
    );

    const page1Res = await fetch(
      `${baseUrl}/wallets/${walletId}/ledger?limit=2&order=desc`,
    );
    expect(page1Res.status).toBe(200);
    const page1 = (await page1Res.json()) as {
      items: Array<{ walletVersion: number; balanceAfter: string }>;
      nextCursor: string | null;
    };
    expect(page1.items).toHaveLength(2);
    expect(page1.items[0]?.walletVersion).toBe(3);
    expect(page1.items[0]?.balanceAfter).toBe("130.00");
    expect(page1.items[1]?.walletVersion).toBe(2);
    expect(page1.nextCursor).toBeTruthy();

    const page2Res = await fetch(
      `${baseUrl}/wallets/${walletId}/ledger?limit=2&order=desc&cursor=${encodeURIComponent(page1.nextCursor!)}`,
    );
    expect(page2Res.status).toBe(200);
    const page2 = (await page2Res.json()) as {
      items: Array<{ walletVersion: number; balanceAfter: string }>;
      nextCursor: string | null;
    };
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]?.walletVersion).toBe(1);
    expect(page2.nextCursor).toBeNull();
  });

  test("POST /wager-transactions: 201->200 replay, 409 conflitos, 400 contrato, 422 negócio, 202 PENDING_REFERENCE, D03 e reconciliação", async () => {
    const playerId = `player-${Bun.randomUUIDv7()}`;
    const wRes = await postJson("/wallets", {
      playerId,
      initialBalance: "100.00",
      currency: "BRL",
    });
    const walletId = wRes.json.walletId as string;

    // 1. BET novo -> 201
    const betPayload = {
      providerId: "prov-a",
      externalTransactionId: `ext-bet-${walletId}`,
      playerId,
      walletId,
      roundId: "r-10",
      gameId: "slot-1",
      kind: "BET",
      money: { amount: "30.00", currency: "BRL" },
    };
    const betCreated = await postJson("/wager-transactions", betPayload, {
      "Idempotency-Key": `idem-bet-${walletId}`,
    });
    expect(betCreated.status).toBe(201);
    expect(betCreated.json.status).toBe("PROCESSED");
    expect(betCreated.json.balance).toBe("70.00");
    expect(betCreated.json.idempotentReplay).toBe(false);
    const betTxId = betCreated.json.transactionId as string;

    // 2. Replay idempotente -> 200 (idempotentReplay: true)
    const betReplay = await postJson("/wager-transactions", betPayload, {
      "Idempotency-Key": `idem-bet-${walletId}`,
    });
    expect(betReplay.status).toBe(200);
    expect(betReplay.json.transactionId).toBe(betTxId);
    expect(betReplay.json.idempotentReplay).toBe(true);
    expect(betReplay.json.balance).toBe("70.00");

    // GET /wager-transactions/:id -> 200 e 404
    const getTx = await fetch(`${baseUrl}/wager-transactions/${betTxId}`);
    expect(getTx.status).toBe(200);
    const getTxMissing = await fetch(
      `${baseUrl}/wager-transactions/${Bun.randomUUIDv7()}`,
    );
    expect(getTxMissing.status).toBe(404);

    // 3. Conflito de idempotencyKey -> 409
    const idemConflict = await postJson(
      "/wager-transactions",
      { ...betPayload, money: { amount: "31.00", currency: "BRL" } },
      { "Idempotency-Key": `idem-bet-${walletId}` },
    );
    expect(idemConflict.status).toBe(409);
    expect(idemConflict.json.code).toBe("IDEMPOTENCY_KEY_CONFLICT");

    // 4. Conflito de externalTransactionId com outra idempotencyKey -> 409
    const extConflict = await postJson("/wager-transactions", betPayload, {
      "Idempotency-Key": `idem-other-${walletId}`,
    });
    expect(extConflict.status).toBe(409);
    expect(extConflict.json.code).toBe("EXTERNAL_TRANSACTION_ID_CONFLICT");

    // 5. Campos desconhecidos / contrato inválido -> 400
    const unknownField = await postJson(
      "/wager-transactions",
      { ...betPayload, extraField: true },
      { "Idempotency-Key": `idem-bad-${walletId}` },
    );
    expect(unknownField.status).toBe(400);
    expect(unknownField.json.code).toBe("INVALID_PAYLOAD");

    const missingKey = await postJson("/wager-transactions", betPayload);
    expect(missingKey.status).toBe(400);
    expect(missingKey.json.code).toBe("IDEMPOTENCY_KEY_REQUIRED");

    // 6. WALLET_NOT_FOUND -> 422 retryable: true
    const walletNotFound = await postJson(
      "/wager-transactions",
      {
        ...betPayload,
        walletId: Bun.randomUUIDv7(),
        externalTransactionId: `ext-wnf-${walletId}`,
      },
      { "Idempotency-Key": `idem-wnf-${walletId}` },
    );
    expect(walletNotFound.status).toBe(422);
    expect(walletNotFound.json.code).toBe("WALLET_NOT_FOUND");
    expect(walletNotFound.json.retryable).toBe(true);

    // 7. INSUFFICIENT_FUNDS -> 422 REJECTED + replay 422
    const insufPayload = {
      ...betPayload,
      externalTransactionId: `ext-insuf-${walletId}`,
      money: { amount: "500.00", currency: "BRL" },
    };
    const insuf = await postJson("/wager-transactions", insufPayload, {
      "Idempotency-Key": `idem-insuf-${walletId}`,
    });
    expect(insuf.status).toBe(422);
    expect(insuf.json.status).toBe("REJECTED");
    expect(insuf.json.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect(insuf.json.idempotentReplay).toBe(false);

    const insufReplay = await postJson("/wager-transactions", insufPayload, {
      "Idempotency-Key": `idem-insuf-${walletId}`,
    });
    expect(insufReplay.status).toBe(422);
    expect(insufReplay.json.idempotentReplay).toBe(true);

    // 8. REFUND válido (201) + tentativa de ROLLBACK duplicado (D03 -> 422 REFERENCE_ALREADY_REVERSED)
    const refund = await postJson(
      "/wager-transactions",
      {
        ...betPayload,
        kind: "REFUND",
        externalTransactionId: `ext-ref-${walletId}`,
        referenceExternalTransactionId: betPayload.externalTransactionId,
      },
      { "Idempotency-Key": `idem-ref-${walletId}` },
    );
    expect(refund.status).toBe(201);
    expect(refund.json.balance).toBe("100.00");

    const dupRollback = await postJson(
      "/wager-transactions",
      {
        ...betPayload,
        kind: "ROLLBACK",
        externalTransactionId: `ext-rb-${walletId}`,
        referenceExternalTransactionId: betPayload.externalTransactionId,
      },
      { "Idempotency-Key": `idem-rb-${walletId}` },
    );
    expect(dupRollback.status).toBe(422);
    expect(dupRollback.json.failureCode).toBe("REFERENCE_ALREADY_REVERSED");

    // 9. ROLLBACK antes da referência -> 202 PENDING_REFERENCE + replay 202
    const pendingPayload = {
      ...betPayload,
      kind: "ROLLBACK",
      externalTransactionId: `ext-pend-${walletId}`,
      referenceExternalTransactionId: `ext-not-arrived-${walletId}`,
    };
    const pendingRes = await postJson("/wager-transactions", pendingPayload, {
      "Idempotency-Key": `idem-pend-${walletId}`,
    });
    expect(pendingRes.status).toBe(202);
    expect(pendingRes.json.status).toBe("PENDING_REFERENCE");
    expect(pendingRes.json.idempotentReplay).toBe(false);

    const pendingReplay = await postJson("/wager-transactions", pendingPayload, {
      "Idempotency-Key": `idem-pend-${walletId}`,
    });
    expect(pendingReplay.status).toBe(202);
    expect(pendingReplay.json.idempotentReplay).toBe(true);

    // 10. Outbox recebeu eventos e Reconciliação passa sem discrepâncias
    const outboxCount = await em.execute<{ count: string }[]>(
      `SELECT count(*)::text AS count FROM outbox_messages WHERE aggregate_id = ?`,
      [walletId],
    );
    expect(Number(outboxCount[0]?.count ?? "0")).toBeGreaterThanOrEqual(4);

    const recWallet = await postJson("/reconciliation/run", { walletId });
    expect(recWallet.status).toBe(200);
    expect(recWallet.json.checkedWallets).toBe(1);
    expect(recWallet.json.consistent).toBe(true);
    expect(recWallet.json.discrepancies).toEqual([]);

    const recAll = await postJson("/reconciliation/run", {});
    expect(recAll.status).toBe(200);
    expect(recAll.json.consistent).toBe(true);
  });

  test("Rotas oficiais do enunciado (§9): POST /wallets com initialBalance objeto, /wagering/transactions, /providers/:p/wagering/transactions/:ext e /wallets/:id/reconciliation", async () => {
    const playerId = `player-spec-${Bun.randomUUIDv7()}`;
    const walletCreated = await postJson("/wallets", {
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    expect(walletCreated.status).toBe(201);
    expect(walletCreated.json.money).toEqual({
      amount: "100.00",
      currency: "BRL",
    });
    const walletId = walletCreated.json.id as string;

    const betExtId = `ext-spec-bet-${walletId}`;
    const betRes = await postJson(
      "/wagering/transactions",
      {
        providerId: "provider-spec",
        externalTransactionId: betExtId,
        playerId,
        walletId,
        roundId: "round-spec",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "25.00", currency: "BRL" },
      },
      { "Idempotency-Key": `provider-spec:${betExtId}` },
    );
    expect(betRes.status).toBe(201);
    const txId = betRes.json.transactionId as string;

    const byId = await fetch(`${baseUrl}/wagering/transactions/${txId}`);
    expect(byId.status).toBe(200);

    const byExt = await fetch(
      `${baseUrl}/providers/provider-spec/wagering/transactions/${betExtId}`,
    );
    expect(byExt.status).toBe(200);
    expect(((await byExt.json()) as { transactionId: string }).transactionId).toBe(
      txId,
    );

    const recSingle = await postJson(`/wallets/${walletId}/reconciliation`, {});
    expect(recSingle.status).toBe(200);
    expect(recSingle.json).toEqual({
      walletId,
      storedBalance: { amount: "75.00", currency: "BRL" },
      calculatedBalance: { amount: "75.00", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 2,
    });
  });
});
