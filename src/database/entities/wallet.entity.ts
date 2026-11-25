import { defineEntity, p } from "@mikro-orm/core";

export const WalletSchema = defineEntity({
  name: "WalletRecord",
  tableName: "wallets",
  properties: {
    id: p.string().primary(),
    playerId: p.string().name("player_id"),
    currency: p.string().length(3),
    balance: p.decimal().precision(20).scale(2).$type<string>(),
    version: p.integer(),
    createdAt: p.datetime().name("created_at"),
    updatedAt: p.datetime().name("updated_at"),
  },
});

export type WalletRecord = (typeof WalletSchema)["~entity"];
