import { Inject, Injectable } from "@nestjs/common";
import { type EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { WalletLedgerEntrySchema } from "../../database/entities/wallet-ledger-entry.entity.ts";
import { WalletSchema } from "../../database/entities/wallet.entity.ts";
import { ContractViolationError } from "../../shared/domain/domain-error.ts";
import { isPgUnavailableError } from "../../shared/infrastructure/database/pg-errors.ts";
import { TransientServiceException } from "../../shared/infrastructure/http/http-exception.filter.ts";
import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry.ts";
import { ledgerEntryToDomain } from "../infrastructure/persistence/wallet.mapper.ts";

export interface ListWalletLedgerQuery {
  readonly walletId: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly order?: "asc" | "desc";
}

export interface ListWalletLedgerResult {
  readonly items: readonly WalletLedgerEntry[];
  readonly nextCursor: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function encodeCursor(walletVersion: number): string {
  return Buffer.from(JSON.stringify({ v: walletVersion }), "utf8").toString(
    "base64url",
  );
}

function decodeCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { v?: unknown };
    if (
      typeof parsed.v !== "number" ||
      !Number.isInteger(parsed.v) ||
      parsed.v < 1
    ) {
      throw new Error("Invalid cursor version");
    }
    return parsed.v;
  } catch {
    throw new ContractViolationError(
      "INVALID_PAYLOAD",
      "Invalid pagination cursor.",
    );
  }
}

@Injectable()
export class ListWalletLedgerUseCase {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async execute(
    query: ListWalletLedgerQuery,
  ): Promise<ListWalletLedgerResult | null> {
    const limit = Math.min(
      Math.max(1, query.limit ?? DEFAULT_LIMIT),
      MAX_LIMIT,
    );
    const order = query.order ?? "desc";
    const cursorVersion =
      query.cursor !== undefined ? decodeCursor(query.cursor) : null;

    const em = this.orm.em.fork() as EntityManager;

    try {
      const wallet = await em.findOne(WalletSchema, { id: query.walletId });
      if (!wallet) {
        return null;
      }

      const where =
        cursorVersion === null
          ? { walletId: query.walletId }
          : order === "desc"
            ? {
                walletId: query.walletId,
                walletVersion: { $lt: cursorVersion },
              }
            : {
                walletId: query.walletId,
                walletVersion: { $gt: cursorVersion },
              };

      const rows = await em.find(WalletLedgerEntrySchema, where, {
        orderBy: { walletVersion: order },
        limit: limit + 1,
      });

      const hasMore = rows.length > limit;
      const sliced = hasMore ? rows.slice(0, limit) : rows;
      const items = sliced.map(ledgerEntryToDomain);
      const last = items[items.length - 1];
      const nextCursor =
        hasMore && last ? encodeCursor(last.walletVersion) : null;

      return { items, nextCursor };
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
