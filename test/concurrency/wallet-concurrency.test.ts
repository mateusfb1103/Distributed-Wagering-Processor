import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import {
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { type EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { initQueues } from "../../infra/sqs/init-queues.ts";
import { AppModule } from "../../src/app.module.ts";
import { runMigrations } from "../../src/database/migrate.ts";
import { OutboxPublisherService } from "../../src/messaging/application/outbox-publisher.service.ts";
import { SqsConsumerService } from "../../src/messaging/application/sqs-consumer.service.ts";
import { SqsClientService } from "../../src/messaging/infrastructure/sqs-client.service.ts";
import { PendingReferenceWorkerService } from "../../src/wagering/application/pending-reference-worker.service.ts";

async function drainQueue(
  sqs: SqsClientService,
  queueUrl: string,
): Promise<Message[]> {
  const collected: Message[] = [];
  for (let i = 0; i < 30; i += 1) {
    const res = await sqs.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 0,
        MessageAttributeNames: ["All"],
      }),
    );
    const batch = res.Messages ?? [];
    if (batch.length === 0) {
      break;
    }
    for (const msg of batch) {
      collected.push(msg);
      if (msg.ReceiptHandle) {
        await sqs.client.send(
          new DeleteMessageCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: msg.ReceiptHandle,
          }),
        );
      }
    }
  }
  return collected;
}

describe("Fase 5 — Concorrência, Resiliência e Regressão End-to-End", () => {
  let app: INestApplication;
  let baseUrl: string;
  let em: EntityManager;
  let sqs: SqsClientService;
  let outboxPublisher: OutboxPublisherService;
  let sqsConsumer: SqsConsumerService;
  let pendingWorker: PendingReferenceWorkerService;

  beforeAll(async () => {
    await runMigrations("up");
    await initQueues();
    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0);
    const address = app.getHttpServer().address();
    if (!address || typeof address === "string") {
      throw new Error("Unexpected HTTP server address");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;

    em = app.get(MikroORM).em.fork() as EntityManager;
    sqs = app.get(SqsClientService);
    outboxPublisher = app.get(OutboxPublisherService);
    sqsConsumer = app.get(SqsConsumerService);
    pendingWorker = app.get(PendingReferenceWorkerService);

    const urls = await sqs.getQueueUrls();
    await Promise.all([
      drainQueue(sqs, urls.wagerQueueUrl),
      drainQueue(sqs, urls.wagerDlqUrl),
      drainQueue(sqs, urls.eventsQueueUrl),
    ]);
  }, 60_000);

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
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      json: (await res.json()) as Record<string, unknown>,
    };
  }

  test("1. Alta contenção na mesma wallet (D01): 20 BETs concorrentes de 10.00 sobre 100.00", async () => {
    const playerId = `player-conc-1-${Bun.randomUUIDv7()}`;
    const created = await postJson("/wallets", {
      playerId,
      initialBalance: "100.00",
      currency: "BRL",
    });
    expect(created.status).toBe(201);
    const walletId = created.json.walletId as string;

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        postJson(
          "/wager-transactions",
          {
            providerId: "prov-conc",
            externalTransactionId: `ext-conc-${walletId}-${i}`,
            playerId,
            walletId,
            roundId: `r-${i}`,
            gameId: "slot-conc",
            kind: "BET",
            money: { amount: "10.00", currency: "BRL" },
          },
          { "Idempotency-Key": `idem-conc-${walletId}-${i}` },
        ),
      ),
    );

    const created201 = results.filter((r) => r.status === 201);
    const rejected422 = results.filter((r) => r.status === 422);
    expect(created201).toHaveLength(10);
    expect(rejected422).toHaveLength(10);
    for (const rej of rejected422) {
      expect(rej.json.failureCode).toBe("INSUFFICIENT_FUNDS");
    }

    const walletRes = await fetch(`${baseUrl}/wallets/${walletId}`);
    const walletJson = (await walletRes.json()) as {
      balance: string;
      version: number;
    };
    expect(walletJson.balance).toBe("0.00");
    expect(walletJson.version).toBe(11);

    const metricsRes = await fetch(`${baseUrl}/metrics`);
    const metricsText = await metricsRes.text();
    expect(metricsText).toMatch(/dwp_wallet_lock_contention_total [1-9]\d*/);

    const rec = await postJson("/reconciliation/run", { walletId });
    expect(rec.status).toBe(200);
    expect(rec.json.consistent).toBe(true);
    expect(rec.json.discrepancies).toEqual([]);
  });

  test("2. Corrida de idempotência (§13.1): mesma aposta enviada 50 vezes em paralelo", async () => {
    const playerId = `player-conc-2-${Bun.randomUUIDv7()}`;
    const created = await postJson("/wallets", {
      playerId,
      initialBalance: "100.00",
      currency: "BRL",
    });
    const walletId = created.json.walletId as string;

    const payload = {
      providerId: "prov-idem-race",
      externalTransactionId: `ext-idem-race-${walletId}`,
      playerId,
      walletId,
      roundId: "r-race",
      gameId: "g-race",
      kind: "BET",
      money: { amount: "35.00", currency: "BRL" },
    };
    const idemKey = `idem-race-${walletId}`;

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        postJson("/wagering/transactions", payload, {
          "Idempotency-Key": idemKey,
        }),
      ),
    );

    const statuses201 = results.filter((r) => r.status === 201);
    const statuses200 = results.filter((r) => r.status === 200);
    expect(statuses201).toHaveLength(1);
    expect(statuses200).toHaveLength(49);

    const txIds = new Set(results.map((r) => r.json.transactionId as string));
    expect(txIds.size).toBe(1);

    const walletRes = await fetch(`${baseUrl}/wallets/${walletId}`);
    const walletJson = (await walletRes.json()) as {
      balance: string;
      version: number;
    };
    expect(walletJson.balance).toBe("65.00");
    expect(walletJson.version).toBe(2);
  });

  test("3. Corrida de reversão dupla (D03): REFUND e ROLLBACK simultâneos sobre mesma BET", async () => {
    const playerId = `player-conc-3-${Bun.randomUUIDv7()}`;
    const created = await postJson("/wallets", {
      playerId,
      initialBalance: "100.00",
      currency: "BRL",
    });
    const walletId = created.json.walletId as string;
    const betExtId = `ext-bet-rev-${walletId}`;

    const betRes = await postJson(
      "/wager-transactions",
      {
        providerId: "prov-rev-race",
        externalTransactionId: betExtId,
        playerId,
        walletId,
        roundId: "r-rev",
        gameId: "g-rev",
        kind: "BET",
        money: { amount: "40.00", currency: "BRL" },
      },
      { "Idempotency-Key": `idem-bet-rev-${walletId}` },
    );
    expect(betRes.status).toBe(201);

    const [refundRes, rollbackRes] = await Promise.all([
      postJson(
        "/wager-transactions",
        {
          providerId: "prov-rev-race",
          externalTransactionId: `ext-refund-${walletId}`,
          playerId,
          walletId,
          roundId: "r-rev",
          gameId: "g-rev",
          kind: "REFUND",
          money: { amount: "40.00", currency: "BRL" },
          referenceExternalTransactionId: betExtId,
        },
        { "Idempotency-Key": `idem-refund-${walletId}` },
      ),
      postJson(
        "/wager-transactions",
        {
          providerId: "prov-rev-race",
          externalTransactionId: `ext-rollback-${walletId}`,
          playerId,
          walletId,
          roundId: "r-rev",
          gameId: "g-rev",
          kind: "ROLLBACK",
          money: { amount: "40.00", currency: "BRL" },
          referenceExternalTransactionId: betExtId,
        },
        { "Idempotency-Key": `idem-rollback-${walletId}` },
      ),
    ]);

    const outcomes = [refundRes, rollbackRes];
    expect(outcomes.filter((r) => r.status === 201)).toHaveLength(1);
    const rejected = outcomes.filter((r) => r.status === 422);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.json.failureCode).toBe("REFERENCE_ALREADY_REVERSED");

    const walletRes = await fetch(`${baseUrl}/wallets/${walletId}`);
    const walletJson = (await walletRes.json()) as {
      balance: string;
      version: number;
    };
    expect(walletJson.balance).toBe("100.00");
    expect(walletJson.version).toBe(3);
  });

  test("4. Wallets distintas em paralelo via HTTP e SQS + reconciliação global consistente", async () => {
    const urls = await sqs.getQueueUrls();
    await drainQueue(sqs, urls.wagerQueueUrl);

    const wallets = await Promise.all(
      Array.from({ length: 4 }, async (_, idx) => {
        const playerId = `player-multi-${idx}-${Bun.randomUUIDv7()}`;
        const res = await postJson("/wallets", {
          playerId,
          initialBalance: "200.00",
          currency: "BRL",
        });
        return { walletId: res.json.walletId as string, playerId };
      }),
    );

    // Envia BET + WIN + LOSS em paralelo por HTTP e um BET por SQS para cada wallet
    await Promise.all(
      wallets.flatMap(({ walletId, playerId }) => [
        postJson(
          "/wager-transactions",
          {
            providerId: "prov-multi",
            externalTransactionId: `ext-m-bet-${walletId}`,
            playerId,
            walletId,
            roundId: "r-m",
            gameId: "g-m",
            kind: "BET",
            money: { amount: "50.00", currency: "BRL" },
          },
          { "Idempotency-Key": `idem-m-bet-${walletId}` },
        ),
        postJson(
          "/wager-transactions",
          {
            providerId: "prov-multi",
            externalTransactionId: `ext-m-win-${walletId}`,
            playerId,
            walletId,
            roundId: "r-m",
            gameId: "g-m",
            kind: "WIN",
            money: { amount: "25.00", currency: "BRL" },
          },
          { "Idempotency-Key": `idem-m-win-${walletId}` },
        ),
        postJson(
          "/wager-transactions",
          {
            providerId: "prov-multi",
            externalTransactionId: `ext-m-loss-${walletId}`,
            playerId,
            walletId,
            roundId: "r-m",
            gameId: "g-m",
            kind: "LOSS",
            money: { amount: "0.00", currency: "BRL" },
          },
          { "Idempotency-Key": `idem-m-loss-${walletId}` },
        ),
        sqs.client.send(
          new SendMessageCommand({
            QueueUrl: urls.wagerQueueUrl,
            MessageBody: JSON.stringify({
              type: "WagerTransactionRequested",
              messageId: Bun.randomUUIDv7(),
              providerId: "prov-multi",
              idempotencyKey: `idem-m-sqs-${walletId}`,
              externalTransactionId: `ext-m-sqs-${walletId}`,
              playerId,
              walletId,
              roundId: "r-m",
              gameId: "g-m",
              kind: "BET",
              money: { amount: "15.00", currency: "BRL" },
            }),
            MessageGroupId: walletId,
            MessageDeduplicationId: `dedup-m-${walletId}`,
          }),
        ),
      ]),
    );

    const polled = await sqsConsumer.pollOnce({
      waitTimeSeconds: 1,
      maxMessages: 10,
    });
    expect(polled.acked).toBe(4);

    for (const { walletId } of wallets) {
      const wRes = await fetch(`${baseUrl}/wallets/${walletId}`);
      const wJson = (await wRes.json()) as { balance: string };
      expect(wJson.balance).toBe("160.00");
    }

    const recAll = await postJson("/reconciliation/run", {});
    expect(recAll.status).toBe(200);
    expect(recAll.json.consistent).toBe(true);
    expect(recAll.json.discrepancies).toEqual([]);
  });

  test("5. Crash pós-commit antes do ack SQS (D10) + redelivery idempotente + outbox", async () => {
    const urls = await sqs.getQueueUrls();
    await drainQueue(sqs, urls.wagerQueueUrl);
    await drainQueue(sqs, urls.eventsQueueUrl);

    const playerId = `player-crash-${Bun.randomUUIDv7()}`;
    const created = await postJson("/wallets", {
      playerId,
      initialBalance: "100.00",
      currency: "BRL",
    });
    const walletId = created.json.walletId as string;

    const msgId = Bun.randomUUIDv7();
    await sqs.client.send(
      new SendMessageCommand({
        QueueUrl: urls.wagerQueueUrl,
        MessageBody: JSON.stringify({
          type: "WagerTransactionRequested",
          messageId: msgId,
          providerId: "prov-crash",
          idempotencyKey: `idem-crash-${walletId}`,
          externalTransactionId: `ext-crash-${walletId}`,
          playerId,
          walletId,
          roundId: "r-crash",
          gameId: "g-crash",
          kind: "BET",
          money: { amount: "30.00", currency: "BRL" },
        }),
        MessageGroupId: walletId,
        MessageDeduplicationId: msgId,
      }),
    );

    // 1ª entrega com falha sintética após o commit no PostgreSQL e antes do DeleteMessage
    const firstPoll = await sqsConsumer.pollOnce({
      waitTimeSeconds: 1,
      faultInjectionOverride: "AFTER_COMMIT_BEFORE_SQS_ACK",
    });
    expect(firstPoll.received).toBe(1);
    expect(firstPoll.retried).toBe(1);
    expect(firstPoll.acked).toBe(0);

    // Saldo já foi debitado uma única vez no commit
    const wAfterCrash = await fetch(`${baseUrl}/wallets/${walletId}`);
    expect(
      ((await wAfterCrash.json()) as { balance: string }).balance,
    ).toBe("70.00");

    // Aguarda visibility timeout (1s no backoff da 1ª tentativa) e reprocessa sem fault injection
    await Bun.sleep(1300);

    const secondPoll = await sqsConsumer.pollOnce({
      waitTimeSeconds: 2,
      faultInjectionOverride: null,
    });
    expect(secondPoll.received).toBe(1);
    expect(secondPoll.acked).toBe(1);

    // Saldo permanece 70.00 (sem débito duplicado)
    const wAfterRedelivery = await fetch(`${baseUrl}/wallets/${walletId}`);
    expect(
      ((await wAfterRedelivery.json()) as { balance: string }).balance,
    ).toBe("70.00");

    // Outbox publica eventos da transação (WagerTransactionProcessed + WalletBalanceChanged)
    await em.execute(
      `UPDATE outbox_messages SET published_at = now() WHERE aggregate_id <> ? AND published_at IS NULL`,
      [walletId],
    );
    const outboxRes = await outboxPublisher.runOnce();
    expect(outboxRes.published).toBe(2);

    const events = await drainQueue(sqs, urls.eventsQueueUrl);
    expect(events.some((m) => m.Body?.includes(walletId))).toBe(true);
  });

  test("6. Start e graceful shutdown dos loops em background executam sem erro", async () => {
    outboxPublisher.start(100);
    pendingWorker.start(100);
    sqsConsumer.start();

    await Bun.sleep(200);

    await sqsConsumer.stop();
    await pendingWorker.stop();
    await outboxPublisher.stop();
  });

  test("7. Múltiplas instâncias (3 instâncias NestJS simultâneas) e reinício mantendo consistência (§13.4 e §13.8)", async () => {
    const instances = await Promise.all(
      [0, 1, 2].map(async () => {
        const inst = await NestFactory.create(AppModule, { logger: false });
        await inst.listen(0);
        const addr = inst.getHttpServer().address();
        if (!addr || typeof addr === "string") {
          throw new Error("Invalid port");
        }
        return { inst, url: `http://127.0.0.1:${addr.port}` };
      }),
    );

    try {
      const playerId = `player-3inst-${Bun.randomUUIDv7()}`;
      const createRes = await fetch(`${instances[0]!.url}/wallets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          playerId,
          initialBalance: { amount: "100.00", currency: "BRL" },
        }),
      });
      expect(createRes.status).toBe(201);
      const walletId = ((await createRes.json()) as { id: string }).id;

      // Cenário §8 distribuído entre 3 instâncias simultâneas: 2 BETs de 80.00 + 1 BET de 80.00
      const responses = await Promise.all(
        instances.map((target, idx) =>
          fetch(`${target.url}/wagering/transactions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "Idempotency-Key": `idem-3inst-${walletId}-${idx}`,
            },
            body: JSON.stringify({
              providerId: "prov-3inst",
              externalTransactionId: `ext-3inst-${walletId}-${idx}`,
              playerId,
              walletId,
              roundId: `r-3inst-${idx}`,
              gameId: "slot-3inst",
              kind: "BET",
              money: { amount: "80.00", currency: "BRL" },
            }),
          }),
        ),
      );

      const statuses = responses.map((r) => r.status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 422)).toHaveLength(2);
    } finally {
      await Promise.all(instances.map((i) => i.inst.close()));
    }

    // Reinício simulado: nova instância consulta reconciliação global
    const restarted = await NestFactory.create(AppModule, { logger: false });
    try {
      await restarted.listen(0);
      const addr = restarted.getHttpServer().address();
      if (!addr || typeof addr === "string") {
        throw new Error("Invalid port");
      }
      const recRes = await fetch(`http://127.0.0.1:${addr.port}/reconciliation/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(recRes.status).toBe(200);
      const recJson = (await recRes.json()) as { consistent: boolean };
      expect(recJson.consistent).toBe(true);
    } finally {
      await restarted.close();
    }
  });
});
