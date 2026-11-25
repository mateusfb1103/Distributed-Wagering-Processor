import type { WalletLedgerEntryRecord } from "../../../database/entities/wallet-ledger-entry.entity.ts";
import type { WalletRecord } from "../../../database/entities/wallet.entity.ts";
import { Money } from "../../../shared/domain/money.ts";
import { Wallet } from "../../domain/wallet.ts";
import {
  type LedgerDirection,
  WalletLedgerEntry,
} from "../../domain/wallet-ledger-entry.ts";

export function walletToDomain(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    currency: record.currency,
    balance: Money.rehydrate(record.balance, record.currency),
    version: record.version,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  });
}

export function walletToRecord(wallet: Wallet): WalletRecord {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toString(),
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

export function ledgerEntryToDomain(
  record: WalletLedgerEntryRecord,
): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.walletId,
    transactionId: record.transactionId,
    direction: record.direction as LedgerDirection,
    amount: Money.rehydrate(record.amount, record.currency),
    balanceBefore: Money.rehydrate(record.balanceBefore, record.currency),
    balanceAfter: Money.rehydrate(record.balanceAfter, record.currency),
    walletVersion: record.walletVersion,
    createdAt: new Date(record.createdAt),
  });
}

export function ledgerEntryToRecord(
  entry: WalletLedgerEntry,
): WalletLedgerEntryRecord {
  return {
    id: entry.id,
    walletId: entry.walletId,
    currency: entry.amount.currency,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: entry.amount.toString(),
    balanceBefore: entry.balanceBefore.toString(),
    balanceAfter: entry.balanceAfter.toString(),
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt,
  };
}
