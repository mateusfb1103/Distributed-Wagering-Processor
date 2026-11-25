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
import { SubmitWagerTransactionUseCase } from "../../src/wagering/application/submit-wager-transaction.use-case.ts";
import { CreateWalletUseCase } from "../../src/wallet/application/create-wallet.use-case.ts";
import { GetWalletUseCase } from "../../src/wallet/application/get-wallet.use-case.ts";

async function drainQueue(
  sqs: SqsClientService,
  queueUrl: string,
): Promise<Message[]> {
  const collected: Message[] = [];
  for (let i = 0; i < 20; i += 1) {
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

describe("Fase 4 — Outbox Publisher, Consumer SQS e PendingReferenceWorker", () => {
  let app: INestApplication;
  let em: EntityManager;
  let sqs: SqsClientService;
  let outboxPublisher: OutboxPublisherService;
  let sqsConsumer: SqsConsumerService;
  let pendingWorker: PendingReferenceWorkerService;
  let createWallet: CreateWalletUseCase;
  let getWallet: GetWalletUseCase;
  let submitWager: SubmitWagerTransactionUseCase;

  beforeAll(async () => {
    await runMigrations("up");
    await initQueues();
    app = await NestFactory.create(AppModule, { logger: false });
    await app.init();

    em = app.get(MikroORM).em.fork() as EntityManager;
    sqs = app.get(SqsClientService);
    outboxPublisher = app.get(OutboxPublisherService);
    sqsConsumer = app.get(SqsConsumerService);
    pendingWorker = app.get(PendingReferenceWorkerService);
    createWallet = app.get(CreateWalletUseCase);
    getWallet = app.get(GetWalletUseCase);
    submitWager = app.get(SubmitWagerTransactionUseCase);

    const urls = await sqs.getQueueUrls();
    await drainQueue(sqs, urls.wagerQueueUrl);
    await drainQueue(sqs, urls.wagerDlqUrl);
    await drainQueue(sqs, urls.eventsQueueUrl);
  });

  afterAll(async () => {
    await app?.close();
  });

  test("Outbox Publisher (D09): publica 1x com SKIP LOCKED sob 2 publishers concorrentes e recupera lease expirado", async () => {
    const urls = await sqs.getQueueUrls();
    await drainQueue(sqs, urls.eventsQueueUrl);

    const playerId = `player-outbox-${Bun.randomUUIDv7()}`;
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: "100.00",
      currency: "BRL",
    });

    const submitted = await submitWager.execute({
      providerId: "prov-outbox",
      idempotencyKey: `idem-${wallet.id}`,
      externalTransactionId: `ext-${wallet.id}`,
      playerId,
      walletId: wallet.id,
      roundId: "r-1",
      gameId: "g-1",
      kind: "BET",
      money: { amount: "10.00", currency: "BRL" },
      source: "http",
    });

    // Marca outros eventos antigos de outros testes como publicados para isolar este teste
    await em.execute(
      `UPDATE outbox_messages SET published_at = now() WHERE aggregate_id <> ? AND published_at IS NULL`,
      [wallet.id],
    );

    const [r1, r2] = await Promise.all([
      outboxPublisher.runOnce({ instanceIdOverride: "pub-1" }),
      outboxPublisher.runOnce({ instanceIdOverride: "pub-2" }),
    ]);

    // BET gera 2 eventos na outbox: WagerTransactionProcessed + WalletBalanceChanged (§11)
    expect(r1.published + r2.published).toBe(2);
    expect(r1.failed + r2.failed).toBe(0);

    const events = await drainQueue(sqs, urls.eventsQueueUrl);
    const matching = events.filter((m) =>
      m.Body?.includes(submitted.transaction.id),
    );
    expect(matching).toHaveLength(2);
    const eventTypes = matching.map(
      (m) => m.MessageAttributes?.eventType?.StringValue,
    );
    expect(eventTypes).toContain("WagerTransactionProcessed");
    expect(eventTypes).toContain("WalletBalanceChanged");

    // Testa recuperação de lease expirado de um publisher morto
    const expiredEventId = Bun.randomUUIDv7();
    await em.execute(
      `INSERT INTO outbox_messages (event_id, aggregate_type, aggregate_id, event_type, payload, correlation_id, occurred_at, created_at, attempt_count, next_attempt_at, locked_by, locked_until)
       VALUES (?, 'WagerTransaction', ?, 'WagerTransactionProcessed', ?::jsonb, 'corr-exp', now(), now(), 0, now() - interval '1 second', 'dead-publisher', now() - interval '1 minute')`,
      [
        expiredEventId,
        wallet.id,
        JSON.stringify({ eventId: expiredEventId, test: "lease-recovery" }),
      ],
    );

    const recovery = await outboxPublisher.runOnce({
      instanceIdOverride: "survivor-pub",
    });
    expect(recovery.published).toBe(1);

    const recoveredMsgs = await drainQueue(sqs, urls.eventsQueueUrl);
    expect(recoveredMsgs.some((m) => m.Body?.includes(expiredEventId))).toBe(
      true,
    );
  });

  test("Consumer SQS (D10): ack em negócio (PROCESSED/REJECTED), DLQ em permanente/hash divergente e dedup inbox", async () => {
    const urls = await sqs.getQueueUrls();
    await drainQueue(sqs, urls.wagerQueueUrl);
    await drainQueue(sqs, urls.wagerDlqUrl);

    const playerId = `player-sqs-${Bun.randomUUIDv7()}`;
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: "50.00",
      currency: "BRL",
    });

    // 1. BET válido via SQS → PROCESSED + ack
    const betMsgId = Bun.randomUUIDv7();
    const betBody = JSON.stringify({
      type: "WagerTransactionRequested",
      messageId: betMsgId,
      occurredAt: new Date().toISOString(),
      providerId: "prov-sqs",
      idempotencyKey: `idem-sqs-1-${wallet.id}`,
      externalTransactionId: `ext-sqs-1-${wallet.id}`,
      playerId,
      walletId: wallet.id,
      roundId: "r-sqs",
      gameId: "g-sqs",
      kind: "BET",
      money: { amount: "20.00", currency: "BRL" },
    });

    await sqs.client.send(
      new SendMessageCommand({
        QueueUrl: urls.wagerQueueUrl,
        MessageBody: betBody,
        MessageGroupId: wallet.id,
        MessageDeduplicationId: betMsgId,
      }),
    );

    const poll1 = await sqsConsumer.pollOnce({ waitTimeSeconds: 1 });
    expect(poll1.acked).toBe(1);
    expect(poll1.dlq).toBe(0);

    const updatedWallet = await getWallet.execute(wallet.id);
    expect(updatedWallet?.balance.toString()).toBe("30.00");

    // 2. Redelivery duplicado com mesmo messageId e mesmo payloadHash → ack idempotente sem debitar novamente
    await sqs.client.send(
      new SendMessageCommand({
        QueueUrl: urls.wagerQueueUrl,
        MessageBody: betBody,
        MessageGroupId: wallet.id,
        MessageDeduplicationId: `${betMsgId}-redeliver`,
      }),
    );
    const pollDup = await sqsConsumer.pollOnce({ waitTimeSeconds: 1 });
    expect(pollDup.acked).toBe(1);
    expect((await getWallet.execute(wallet.id))?.balance.toString()).toBe(
      "30.00",
    );

    // 3. Mesmo messageId com payload diferente → DLQ (INBOX_PAYLOAD_HASH_MISMATCH)
    const tamperedBody = JSON.stringify({
      ...JSON.parse(betBody),
      money: { amount: "99.00", currency: "BRL" },
    });
    await sqs.client.send(
      new SendMessageCommand({
        QueueUrl: urls.wagerQueueUrl,
        MessageBody: tamperedBody,
        MessageGroupId: wallet.id,
        MessageDeduplicationId: `${betMsgId}-tampered`,
      }),
    );
    const pollTampered = await sqsConsumer.pollOnce({ waitTimeSeconds: 1 });
    expect(pollTampered.dlq).toBe(1);

    // 4. Saldo insuficiente (REJECTED) → ACK (NÃO vai para DLQ)
    const insufMsgId = Bun.randomUUIDv7();
    await sqs.client.send(
      new SendMessageCommand({
        QueueUrl: urls.wagerQueueUrl,
        MessageBody: JSON.stringify({
          type: "WagerTransactionRequested",
          messageId: insufMsgId,
          providerId: "prov-sqs",
          idempotencyKey: `idem-insuf-${wallet.id}`,
          externalTransactionId: `ext-insuf-${wallet.id}`,
          playerId,
          walletId: wallet.id,
          roundId: "r-sqs",
          gameId: "g-sqs",
          kind: "BET",
          money: { amount: "999.00", currency: "BRL" },
        }),
        MessageGroupId: wallet.id,
        MessageDeduplicationId: insufMsgId,
      }),
    );
    const pollInsuf = await sqsConsumer.pollOnce({ waitTimeSeconds: 1 });
    expect(pollInsuf.acked).toBe(1);
    expect(pollInsuf.dlq).toBe(0);

    // 5. JSON inválido e campo desconhecido → DLQ
    const badJsonId = Bun.randomUUIDv7();
    await sqs.client.send(
      new SendMessageCommand({
        QueueUrl: urls.wagerQueueUrl,
        MessageBody: "{invalid-json",
        MessageGroupId: wallet.id,
        MessageDeduplicationId: badJsonId,
      }),
    );
    const pollBadJson = await sqsConsumer.pollOnce({ waitTimeSeconds: 1 });
    expect(pollBadJson.dlq).toBe(1);

    const dlqMsgs = await drainQueue(sqs, urls.wagerDlqUrl);
    expect(dlqMsgs).toHaveLength(2);
    const reasons = dlqMsgs.map(
      (m) => m.MessageAttributes?.dlqReason?.StringValue,
    );
    expect(reasons).toContain("INBOX_PAYLOAD_HASH_MISMATCH");
    expect(reasons).toContain("MALFORMED_JSON");
  });

  test("PendingReferenceWorker (D11): wake-up após chegada da BET e expiração por TTL", async () => {
    const urls = await sqs.getQueueUrls();
    await drainQueue(sqs, urls.wagerQueueUrl);

    const playerId = `player-pend-${Bun.randomUUIDv7()}`;
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: "100.00",
      currency: "BRL",
    });

    // Garante isolamento de outras transações PENDING_REFERENCE de testes anteriores
    await em.execute(
      `UPDATE wager_transactions SET next_attempt_at = now() + interval '1 hour' WHERE wallet_id <> ? AND status = 'PENDING_REFERENCE'`,
      [wallet.id],
    );

    const betExtId = `ext-bet-late-${wallet.id}`;
    const rbMsgId = Bun.randomUUIDv7();

    // 1. ROLLBACK chega antes da BET via SQS → PENDING_REFERENCE
    await sqs.client.send(
      new SendMessageCommand({
        QueueUrl: urls.wagerQueueUrl,
        MessageBody: JSON.stringify({
          type: "WagerTransactionRequested",
          messageId: rbMsgId,
          providerId: "prov-pend",
          idempotencyKey: `idem-rb-early-${wallet.id}`,
          externalTransactionId: `ext-rb-early-${wallet.id}`,
          playerId,
          walletId: wallet.id,
          roundId: "r-pend",
          gameId: "g-pend",
          kind: "ROLLBACK",
          money: { amount: "40.00", currency: "BRL" },
          referenceExternalTransactionId: betExtId,
        }),
        MessageGroupId: wallet.id,
        MessageDeduplicationId: rbMsgId,
      }),
    );
    const pollRb = await sqsConsumer.pollOnce({ waitTimeSeconds: 1 });
    expect(pollRb.acked).toBe(1);

    // 2. Força next_attempt_at para agora (sem a BET ainda) e roda worker → reagenda sem novo evento PendingReference
    await em.execute(
      `UPDATE wager_transactions SET next_attempt_at = now() - interval '1 second' WHERE wallet_id = ? AND status = 'PENDING_REFERENCE'`,
      [wallet.id],
    );
    const outboxBefore = await em.execute<{ count: string }[]>(
      `SELECT count(*)::text AS count FROM outbox_messages WHERE aggregate_id = ? AND event_type = 'WagerTransactionPendingReference'`,
      [wallet.id],
    );
    expect(outboxBefore[0]?.count).toBe("1");

    const retryWithoutBet = await pendingWorker.runOnce();
    expect(retryWithoutBet.rescheduled).toBe(1);

    const outboxAfterRetry = await em.execute<{ count: string }[]>(
      `SELECT count(*)::text AS count FROM outbox_messages WHERE aggregate_id = ? AND event_type = 'WagerTransactionPendingReference'`,
      [wallet.id],
    );
    expect(outboxAfterRetry[0]?.count).toBe("1");

    // 3. BET chega → wake-up antecipa next_attempt_at → worker processa ROLLBACK e restaura saldo
    const betRes = await submitWager.execute({
      providerId: "prov-pend",
      idempotencyKey: `idem-bet-late-${wallet.id}`,
      externalTransactionId: betExtId,
      playerId,
      walletId: wallet.id,
      roundId: "r-pend",
      gameId: "g-pend",
      kind: "BET",
      money: { amount: "40.00", currency: "BRL" },
      source: "http",
    });
    expect(betRes.wokeUpPendingCount).toBe(1);
    expect((await getWallet.execute(wallet.id))?.balance.toString()).toBe(
      "60.00",
    );

    const resolved = await pendingWorker.runOnce();
    expect(resolved.processed).toBe(1);
    expect((await getWallet.execute(wallet.id))?.balance.toString()).toBe(
      "100.00",
    );

    // 4. REFUND pendente que expira TTL → REJECTED REFERENCE_NOT_FOUND
    const expRes = await submitWager.execute({
      providerId: "prov-pend",
      idempotencyKey: `idem-ref-exp-${wallet.id}`,
      externalTransactionId: `ext-ref-exp-${wallet.id}`,
      playerId,
      walletId: wallet.id,
      roundId: "r-exp",
      gameId: "g-pend",
      kind: "REFUND",
      money: { amount: "10.00", currency: "BRL" },
      referenceExternalTransactionId: `ext-never-${wallet.id}`,
      source: "http",
    });
    expect(expRes.transaction.status).toBe("PENDING_REFERENCE");

    await em.execute(
      `UPDATE wager_transactions SET next_attempt_at = now() - interval '1 second', expires_at = now() - interval '1 second' WHERE id = ?`,
      [expRes.transaction.id],
    );
    const expiredRun = await pendingWorker.runOnce();
    expect(expiredRun.rejected).toBe(1);

    const rejectedRows = await em.execute<
      { status: string; failure_code: string }[]
    >(
      `SELECT status, failure_code FROM wager_transactions WHERE id = ?`,
      [expRes.transaction.id],
    );
    expect(rejectedRows[0]).toEqual({
      status: "REJECTED",
      failure_code: "REFERENCE_NOT_FOUND",
    });
  });

  test("Consumer SQS aceita envelope oficial da §10 com objeto `data`", async () => {
    const urls = await sqs.getQueueUrls();
    await drainQueue(sqs, urls.wagerQueueUrl);

    const playerId = `player-env-data-${Bun.randomUUIDv7()}`;
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: "80.00",
      currency: "BRL",
    });

    const msgId = Bun.randomUUIDv7();
    await sqs.client.send(
      new SendMessageCommand({
        QueueUrl: urls.wagerQueueUrl,
        MessageBody: JSON.stringify({
          messageId: msgId,
          type: "WagerTransactionRequested",
          occurredAt: new Date().toISOString(),
          data: {
            providerId: "prov-spec-sqs",
            externalTransactionId: `ext-data-${wallet.id}`,
            idempotencyKey: `prov-spec-sqs:ext-data-${wallet.id}`,
            playerId,
            walletId: wallet.id,
            roundId: "r-data",
            gameId: "fortune-chimp",
            kind: "BET",
            money: { amount: "25.00", currency: "BRL" },
          },
        }),
        MessageGroupId: wallet.id,
        MessageDeduplicationId: msgId,
      }),
    );

    const poll = await sqsConsumer.pollOnce({ waitTimeSeconds: 1 });
    expect(poll.acked).toBe(1);
    expect(poll.dlq).toBe(0);
    expect((await getWallet.execute(wallet.id))?.balance.toString()).toBe(
      "55.00",
    );
  });
});
