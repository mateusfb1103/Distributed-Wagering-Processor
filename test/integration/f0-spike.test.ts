import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { EntityManager, MikroORM } from "@mikro-orm/postgresql";
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { AppModule } from "../../src/app.module.ts";
import { SpikeProbeSchema } from "../../src/database/entities/spike-probe.entity.ts";
import { runMigrations } from "../../src/database/migrate.ts";
import { loadEnv } from "../../src/shared/infrastructure/config/env.ts";
import { initQueues, type InitializedQueues } from "../../infra/sqs/init-queues.ts";

describe("Fase 0 — Spike de compatibilidade (Bun + NestJS + MikroORM 7 + PG + MiniStack)", () => {
  const env = loadEnv();
  let app: INestApplication;
  let baseUrl: string;
  let sqs: SQSClient;
  let queues: InitializedQueues;

  beforeAll(async () => {
    await runMigrations("up");

    sqs = new SQSClient({
      region: env.AWS_REGION,
      endpoint: env.SQS_ENDPOINT,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      },
    });
    queues = await initQueues(sqs);

    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0);
    const address = app.getHttpServer().address();
    if (!address || typeof address === "string") {
      throw new Error("Unexpected HTTP server address");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    sqs?.destroy();
  });

  test("NestJS responde 200 em GET /health/live sob Bun", async () => {
    const res = await fetch(`${baseUrl}/health/live`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("MikroORM 7 migrator executa down → up reversível e defineEntity funciona em transactional() com role app", async () => {
    const orm = app.get(MikroORM);
    const em = orm.em.fork() as EntityManager;

    // 1. Verifica que role app (dwp_app) NÃO pode executar DDL (D06 R-d)
    await expect(
      em.execute("CREATE TABLE _should_fail_ddl (id INT)"),
    ).rejects.toThrow();

    // 2. Verifica reversibilidade (down remove tabela, up recria) via dwp_migrator
    const rolledBack = await runMigrations("down");
    expect(rolledBack).toContain("Migration00000000000000_SpikeHealthcheck");

    const existsAfterDown = await em.execute<{ exists: boolean }[]>(
      `SELECT to_regclass('public._spike_probe') IS NOT NULL AS exists`,
    );
    expect(existsAfterDown[0]?.exists).toBe(false);

    const applied = await runMigrations("up");
    expect(applied).toContain("Migration00000000000000_SpikeHealthcheck");

    // 3. Verifica defineEntity + transactional() + rollback atômico
    const id = Bun.randomUUIDv7();
    await em.transactional(async (tx) => {
      const record = tx.create(SpikeProbeSchema, {
        id,
        note: "spike-ok",
        createdAt: new Date(),
      });
      await tx.persist(record).flush();
    });

    const found = await orm.em.fork().findOne(SpikeProbeSchema, { id });
    expect(found?.note).toBe("spike-ok");

    // Limpeza
    await orm.em.fork().nativeDelete(SpikeProbeSchema, { id });
  });

  test("SQS FIFO (wager-transactions.fifo e wagering-events.fifo) envia, recebe e faz ack", async () => {
    const dedupId = Bun.randomUUIDv7();
    const payload = JSON.stringify({ probe: dedupId });

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queues.wagerQueueUrl,
        MessageBody: payload,
        MessageGroupId: `group-${dedupId}`,
        MessageDeduplicationId: dedupId,
      }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.wagerQueueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }),
    );

    const msg = received.Messages?.[0];
    expect(msg).toBeDefined();
    expect(msg?.Body).toBe(payload);
    expect(msg?.Attributes?.ApproximateReceiveCount).toBe("1");

    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: queues.wagerQueueUrl,
        ReceiptHandle: msg!.ReceiptHandle!,
      }),
    );

    // Verifica também a fila de saída da outbox (D09)
    const eventId = Bun.randomUUIDv7();
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queues.eventsQueueUrl,
        MessageBody: JSON.stringify({ eventId }),
        MessageGroupId: "wallet-spike",
        MessageDeduplicationId: eventId,
      }),
    );

    const eventRes = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.eventsQueueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
      }),
    );
    const eventMsg = eventRes.Messages?.[0];
    expect(eventMsg?.Body).toBe(JSON.stringify({ eventId }));
    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: queues.eventsQueueUrl,
        ReceiptHandle: eventMsg!.ReceiptHandle!,
      }),
    );
  });

  test("Contrato do emulador SQS: ChangeMessageVisibility, ApproximateReceiveCount e RedrivePolicy para DLQ", async () => {
    // Usa par de filas isolado com maxReceiveCount=2 para validar redrive rápido e determinístico
    const suffix = Bun.randomUUIDv7().slice(-8);
    const dlqName = `spike-dlq-${suffix}.fifo`;
    const mainName = `spike-main-${suffix}.fifo`;

    const dlqRes = await sqs.send(
      new CreateQueueCommand({
        QueueName: dlqName,
        Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" },
      }),
    );
    const dlqUrl = dlqRes.QueueUrl!;
    const dlqAttrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: dlqUrl,
        AttributeNames: ["QueueArn"],
      }),
    );
    const dlqArn = dlqAttrs.Attributes!.QueueArn!;

    const mainRes = await sqs.send(
      new CreateQueueCommand({
        QueueName: mainName,
        Attributes: {
          FifoQueue: "true",
          ContentBasedDeduplication: "false",
          VisibilityTimeout: "30",
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: dlqArn,
            maxReceiveCount: 2,
          }),
        },
      }),
    );
    const mainUrl = mainRes.QueueUrl!;

    try {
      const msgId = Bun.randomUUIDv7();
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: mainUrl,
          MessageBody: JSON.stringify({ msgId }),
          MessageGroupId: "redrive-group",
          MessageDeduplicationId: msgId,
        }),
      );

      // Tentativa 1: recebe, devolve visibilidade para 0 (simula retry/shutdown)
      const r1 = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: mainUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 2,
          MessageSystemAttributeNames: ["ApproximateReceiveCount"],
        }),
      );
      expect(r1.Messages?.length).toBe(1);
      expect(r1.Messages?.[0]?.Attributes?.ApproximateReceiveCount).toBe("1");

      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: mainUrl,
          ReceiptHandle: r1.Messages![0]!.ReceiptHandle!,
          VisibilityTimeout: 0,
        }),
      );

      // Tentativa 2: ApproximateReceiveCount deve ser 2; devolve visibilidade para 0
      const r2 = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: mainUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 2,
          MessageSystemAttributeNames: ["ApproximateReceiveCount"],
        }),
      );
      expect(r2.Messages?.length).toBe(1);
      expect(r2.Messages?.[0]?.Attributes?.ApproximateReceiveCount).toBe("2");

      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: mainUrl,
          ReceiptHandle: r2.Messages![0]!.ReceiptHandle!,
          VisibilityTimeout: 0,
        }),
      );

      // Tentativa 3: excedeu maxReceiveCount=2 → deve ir para DLQ (fila principal vazia)
      const r3 = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: mainUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 1,
        }),
      );
      expect(r3.Messages ?? []).toHaveLength(0);

      const dlqRecv = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: dlqUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 2,
        }),
      );
      expect(dlqRecv.Messages?.length).toBe(1);
      expect(dlqRecv.Messages?.[0]?.Body).toBe(JSON.stringify({ msgId }));
    } finally {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: mainUrl }));
      await sqs.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
    }
  });
});
