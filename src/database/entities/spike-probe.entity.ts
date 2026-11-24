import { defineEntity, p } from "@mikro-orm/core";

/**
 * Entidade mínima do spike da Fase 0 para validar defineEntity (sem decorators),
 * EntityManager.transactional() e separação de roles sob Bun + MikroORM 7.
 * Será removida na Fase 2 quando o schema real de domínio for criado.
 */
export const SpikeProbeSchema = defineEntity({
  name: "SpikeProbeRecord",
  tableName: "_spike_probe",
  properties: {
    id: p.string().primary(),
    note: p.string(),
    createdAt: p.datetime().name("created_at"),
  },
});

export type SpikeProbeRecord = (typeof SpikeProbeSchema)["~entity"];
