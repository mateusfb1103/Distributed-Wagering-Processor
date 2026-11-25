import { defineEntity, p } from "@mikro-orm/core";

export const WalletLedgerEntrySchema = defineEntity({
  name: "WalletLedgerEntryRecord",
  tableName: "wallet_ledger_entries",
  properties: {
    id: p.string().primary(),
    walletId: p.string().name("wallet_id"),
    currency: p.string().length(3),
    transactionId: p.string().name("transaction_id"),
    direction: p.string(),
    amount: p.decimal().precision(20).scale(2).$type<string>(),
    balanceBefore: p
      .decimal()
      .precision(20)
      .scale(2)
      .$type<string>()
      .name("balance_before"),
    balanceAfter: p
      .decimal()
      .precision(20)
      .scale(2)
      .$type<string>()
      .name("balance_after"),
    walletVersion: p.integer().name("wallet_version"),
    createdAt: p.datetime().name("created_at"),
  },
});

export type WalletLedgerEntryRecord =
  (typeof WalletLedgerEntrySchema)["~entity"];
