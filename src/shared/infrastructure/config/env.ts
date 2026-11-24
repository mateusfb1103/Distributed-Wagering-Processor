import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  APP_ROLES: z
    .string()
    .default("api,consumer,outbox,pending-worker")
    .transform((raw) =>
      raw
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean),
    ),
  DATABASE_URL: z
    .string()
    .url()
    .default("postgresql://dwp_app:dwp_app_dev@localhost:5432/wagering"),
  DATABASE_MIGRATOR_URL: z
    .string()
    .url()
    .default(
      "postgresql://dwp_migrator:dwp_migrator_dev@localhost:5432/wagering",
    ),
  AWS_REGION: z.string().min(1).default("us-east-1"),
  AWS_ACCESS_KEY_ID: z.string().min(1).default("000000000000"),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).default("test"),
  SQS_ENDPOINT: z.string().url().default("http://localhost:4566"),
  SQS_WAGER_QUEUE_NAME: z.string().min(1).default("wager-transactions.fifo"),
  SQS_WAGER_DLQ_NAME: z.string().min(1).default("wager-transactions-dlq.fifo"),
  SQS_EVENTS_QUEUE_NAME: z.string().min(1).default("wagering-events.fifo"),
  LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  PENDING_REFERENCE_TTL_MS: z.coerce.number().int().positive().default(900000),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
});

export type AppEnv = z.infer<typeof envSchema>;

export function loadEnv(
  source: Record<string, string | undefined> = process.env,
): AppEnv {
  return envSchema.parse(source);
}
