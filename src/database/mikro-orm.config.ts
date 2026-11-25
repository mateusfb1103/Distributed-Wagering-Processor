import { defineConfig, type Options } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { InboxMessageSchema } from "./entities/inbox-message.entity.ts";
import { OutboxMessageSchema } from "./entities/outbox-message.entity.ts";
import { WagerTransactionSchema } from "./entities/wager-transaction.entity.ts";
import { WalletLedgerEntrySchema } from "./entities/wallet-ledger-entry.entity.ts";
import { WalletSchema } from "./entities/wallet.entity.ts";
import { migrationsList } from "./migrations/index.ts";
import { loadEnv } from "../shared/infrastructure/config/env.ts";

export function buildMikroOrmConfig(
  mode: "app" | "migrator" = "app",
  clientUrlOverride?: string,
): Options {
  const env = loadEnv();
  const clientUrl =
    clientUrlOverride ??
    (mode === "migrator" ? env.DATABASE_MIGRATOR_URL : env.DATABASE_URL);

  return defineConfig({
    clientUrl,
    entities: [
      WalletSchema,
      WagerTransactionSchema,
      WalletLedgerEntrySchema,
      InboxMessageSchema,
      OutboxMessageSchema,
    ],
    extensions: [Migrator],
    migrations: {
      tableName: "mikro_orm_migrations",
      migrationsList,
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
    debug: false,
  });
}

export default buildMikroOrmConfig("migrator");
