import { MikroORM } from "@mikro-orm/postgresql";
import { buildMikroOrmConfig } from "./mikro-orm.config.ts";

export async function runMigrations(
  direction: "up" | "down",
  clientUrlOverride?: string,
): Promise<string[]> {
  const orm = await MikroORM.init(
    buildMikroOrmConfig("migrator", clientUrlOverride),
  );
  try {
    const executed =
      direction === "up"
        ? await orm.migrator.up()
        : await orm.migrator.down({ to: 0 });
    return executed.map((m) => m.name);
  } finally {
    await orm.close(true);
  }
}

if (import.meta.main) {
  const cmd = process.argv[2];
  if (cmd !== "up" && cmd !== "down") {
    console.error("Usage: bun run src/database/migrate.ts <up|down>");
    process.exit(1);
  }
  const executed = await runMigrations(cmd);
  console.log(JSON.stringify({ msg: `migrations ${cmd}`, executed }));
}
