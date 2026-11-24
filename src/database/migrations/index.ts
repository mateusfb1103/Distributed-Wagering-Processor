import type { MigrationObject } from "@mikro-orm/core";
import { Migration00000000000000_SpikeHealthcheck } from "./Migration00000000000000_SpikeHealthcheck.ts";

/**
 * Registro estático de migrations para evitar problemas de import dinâmico
 * do Migrator sob Bun (ver risco documentado no PLANO.md — F0).
 */
export const migrationsList: MigrationObject[] = [
  {
    name: "Migration00000000000000_SpikeHealthcheck",
    class: Migration00000000000000_SpikeHealthcheck,
  },
];
