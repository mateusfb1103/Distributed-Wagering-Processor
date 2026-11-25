import { Inject, Injectable } from "@nestjs/common";
import { type EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { Money } from "../../shared/domain/money.ts";
import { isPgUnavailableError } from "../../shared/infrastructure/database/pg-errors.ts";
import { TransientServiceException } from "../../shared/infrastructure/http/http-exception.filter.ts";
import { AppLogger } from "../../shared/infrastructure/observability/logger.service.ts";
import { MetricsService } from "../../shared/infrastructure/observability/metrics.service.ts";

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

export interface SingleWalletReconciliationReport {
  readonly walletId: string;
  readonly storedBalance: { readonly amount: string; readonly currency: string };
  readonly calculatedBalance: {
    readonly amount: string;
    readonly currency: string;
  };
  readonly difference: { readonly amount: string; readonly currency: string };
  readonly consistent: boolean;
  readonly checkedEntries: number;
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

function formatSignedDifference(
  stored: Money,
  calculated: Money,
): string {
  const diffMinor = stored.minorUnits - calculated.minorUnits;
  const sign = diffMinor < 0n ? "-" : "";
  const abs = diffMinor < 0n ? -diffMinor : diffMinor;
  const intPart = abs / 100n;
  const fracPart = (abs % 100n).toString().padStart(2, "0");
  return `${sign}${intPart.toString()}.${fracPart}`;
}

@Injectable()
export class RunReconciliationUseCase {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(MetricsService) private readonly metrics: MetricsService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async execute(walletId?: string): Promise<ReconciliationReport> {
    const rows = await this.fetchRows(walletId);
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

    if (discrepancies.length > 0) {
      this.metrics.reconciliationDiscrepanciesTotal.inc(discrepancies.length);
      this.logger.warn("Reconciliation discrepancies detected", {
        checkedWallets: rows.length,
        discrepancyCount: discrepancies.length,
      });
    }

    return {
      checkedWallets: rows.length,
      consistent: discrepancies.length === 0,
      discrepancies,
    };
  }

  async reconcileWallet(
    walletId: string,
  ): Promise<SingleWalletReconciliationReport | null> {
    const rows = await this.fetchRows(walletId);
    const row = rows[0];
    if (!row) {
      return null;
    }

    const stored = Money.rehydrate(row.wallet_balance, row.currency);
    const calculated = Money.rehydrate(row.ledger_balance, row.currency);
    const walletVersion = Number(row.wallet_version);
    const ledgerMaxVersion = Number(row.ledger_max_version);
    const consistent =
      row.wallet_balance === row.ledger_balance &&
      walletVersion === ledgerMaxVersion;

    if (!consistent) {
      this.metrics.reconciliationDiscrepanciesTotal.inc();
      this.logger.warn("Wallet reconciliation discrepancy detected", {
        walletId: row.wallet_id,
        walletVersion,
        ledgerMaxVersion,
      });
    }

    return {
      walletId: row.wallet_id,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: {
        amount: formatSignedDifference(stored, calculated),
        currency: row.currency,
      },
      consistent,
      checkedEntries: Number(row.ledger_entry_count),
    };
  }

  private async fetchRows(walletId?: string): Promise<ReconciliationRow[]> {
    const em = this.orm.em.fork() as EntityManager;
    try {
      const params: unknown[] = [];
      const whereClause = walletId ? "WHERE w.id = ?" : "";
      if (walletId) {
        params.push(walletId);
      }

      return await em.execute<ReconciliationRow[]>(
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
