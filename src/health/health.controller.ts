import {
  Controller,
  Get,
  HttpStatus,
  Inject,
  type OnModuleDestroy,
  Res,
} from "@nestjs/common";
import { GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import { type EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { SkipAuth } from "../shared/infrastructure/auth/auth.guard.ts";
import { loadEnv } from "../shared/infrastructure/config/env.ts";

interface HttpStatusResponse {
  status(code: number): unknown;
}

@Controller("health")
export class HealthController implements OnModuleDestroy {
  private readonly sqs: SQSClient;
  private readonly wagerQueueName: string;

  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {
    const env = loadEnv();
    this.wagerQueueName = env.SQS_WAGER_QUEUE_NAME;
    this.sqs = new SQSClient({
      region: env.AWS_REGION,
      endpoint: env.SQS_ENDPOINT,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }

  onModuleDestroy(): void {
    this.sqs.destroy();
  }

  @Get("live")
  @SkipAuth()
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  @SkipAuth()
  async ready(@Res({ passthrough: true }) res: HttpStatusResponse) {
    let pgOk = false;
    let sqsOk = false;

    try {
      const em = this.orm.em.fork() as EntityManager;
      await em.execute("SELECT 1");
      pgOk = true;
    } catch {
      pgOk = false;
    }

    try {
      await this.sqs.send(
        new GetQueueUrlCommand({ QueueName: this.wagerQueueName }),
        { abortSignal: AbortSignal.timeout(2000) },
      );
      sqsOk = true;
    } catch {
      sqsOk = false;
    }

    const ready = pgOk && sqsOk;
    if (!ready) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }

    return {
      status: ready ? "ready" : "not_ready",
      checks: {
        postgres: pgOk ? "up" : "down",
        sqs: sqsOk ? "up" : "down",
      },
    };
  }
}
