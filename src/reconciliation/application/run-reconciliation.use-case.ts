import { Inject, Injectable } from "@nestjs/common";
import { type EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { isPgUnavailableError } from "../../shared/infrastructure/database/pg-errors.ts";
import { TransientServiceException } from "../../shared/infrastructure/http/http-exception.filter.ts";

export interface WalletReconciliationDiscrepancy {
  readonly walletId: string;
  readonly currency: string;
  readonly walletBalance: string;
  readonly ledgerBalance: string;
  readonly walletVersion: number;
  readonly ledgerMaxVersion: number;
  readonly ledgerEntryCount: number;
}

export interface ReconciliationReport {
  readonly checkedWallets: number;
  readonly consistent: boolean;
  readonly discrepancies: readonly WalletReconciliationDiscrepancy[];
}

interface ReconciliationRow {
  readonly wallet_id: string;
  readonly currency: string;
  readonly wallet_balance: string;
  readonly ledger_balance: string;
  readonly wallet_version: number;
  readonly ledger_max_version: number;
  readonly ledger_entry_count: number;
}

@Injectable()
export class RunReconciliationUseCase {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async execute(walletId?: string): Promise<ReconciliationReport> {
    const em = this.orm.em.fork() as EntityManager;

    try {
      const params: unknown[] = [];
      const whereClause = walletId ? "WHERE w.id = ?" : "";
      if (walletId) {
        params.push(walletId);
      }

      const rows = await em.execute<ReconciliationRow[]>(
        `SELECT
           w.id AS wallet_id,
           w.currency AS currency,
           w.balance::text AS wallet_balance,
           COALESCE(
             SUM(
               CASE
                 WHEN l.direction = 'CREDIT' THEN l.amount
                 WHEN l.direction = 'DEBIT' THEN -l.amount
                 ELSE 0
               END
             ),
             0
           )::NUMERIC(20, 2)::text AS ledger_balance,
           w.version AS wallet_version,
           COALESCE(MAX(l.wallet_version), 1) AS ledger_max_version,
           COUNT(l.id)::int AS ledger_entry_count
         FROM wallets w
         LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
         ${whereClause}
         GROUP BY w.id, w.currency, w.balance, w.version
         ORDER BY w.created_at ASC`,
        params,
      );

      const discrepancies: WalletReconciliationDiscrepancy[] = [];
      for (const row of rows) {
        const walletVersion = Number(row.wallet_version);
        const ledgerMaxVersion = Number(row.ledger_max_version);
        const ledgerEntryCount = Number(row.ledger_entry_count);

        if (
          row.wallet_balance !== row.ledger_balance ||
          walletVersion !== ledgerMaxVersion
        ) {
          discrepancies.push({
            walletId: row.wallet_id,
            currency: row.currency,
            walletBalance: row.wallet_balance,
            ledgerBalance: row.ledger_balance,
            walletVersion,
            ledgerMaxVersion,
            ledgerEntryCount,
          });
        }
      }

      return {
        checkedWallets: rows.length,
        consistent: discrepancies.length === 0,
        discrepancies,
      };
    } catch (error) {
      if (isPgUnavailableError(error)) {
        throw new TransientServiceException(
          "DATABASE_UNAVAILABLE",
          "Database is temporarily unavailable.",
        );
      }
      throw error;
    }
  }
}
