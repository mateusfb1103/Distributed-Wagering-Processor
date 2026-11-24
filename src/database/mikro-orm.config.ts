import { defineConfig, type Options } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { SpikeProbeSchema } from "./entities/spike-probe.entity.ts";
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
    entities: [SpikeProbeSchema],
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
