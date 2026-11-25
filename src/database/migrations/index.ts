import type { MigrationObject } from "@mikro-orm/core";
import { Migration20261125000001_CreateCoreSchema } from "./Migration20261125000001_CreateCoreSchema.ts";

/**
 * Registro estático de migrations para evitar import dinâmico do Migrator sob Bun.
 */
export const migrationsList: MigrationObject[] = [
  {
    name: "Migration20261125000001_CreateCoreSchema",
    class: Migration20261125000001_CreateCoreSchema,
  },
];
