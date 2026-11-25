import { Inject, Injectable } from "@nestjs/common";
import { type EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { WagerTransactionSchema } from "../../database/entities/wager-transaction.entity.ts";
import { WalletLedgerEntrySchema } from "../../database/entities/wallet-ledger-entry.entity.ts";
import { WalletSchema } from "../../database/entities/wallet.entity.ts";
import { ConflictError } from "../../shared/domain/domain-error.ts";
import type { IdGenerator } from "../../shared/domain/id-generator.ts";
import { Money } from "../../shared/domain/money.ts";
import { hashWagerPayload } from "../../shared/domain/payload-hasher.ts";
import {
  isPgUnavailableError,
  isPgUniqueViolation,
} from "../../shared/infrastructure/database/pg-errors.ts";
import { TransientServiceException } from "../../shared/infrastructure/http/http-exception.filter.ts";
import { requestContext } from "../../shared/infrastructure/observability/request-context.ts";
import { ID_GENERATOR } from "../../shared/infrastructure/shared-infra.module.ts";
import { WagerTransaction } from "../../wagering/domain/wager-transaction.ts";
import { wagerTransactionToRecord } from "../../wagering/infrastructure/persistence/wager-transaction.mapper.ts";
import { Wallet } from "../domain/wallet.ts";
import {
  ledgerEntryToRecord,
  walletToRecord,
} from "../infrastructure/persistence/wallet.mapper.ts";

export interface CreateWalletCommand {
  readonly playerId: string;
  readonly initialBalance: string;
  readonly currency: string;
}

@Injectable()
export class CreateWalletUseCase {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
  ) {}

  async execute(command: CreateWalletCommand): Promise<Wallet> {
    const initialMoney = Money.fromString(
      command.initialBalance,
      command.currency,
    );
    const now = new Date();
    const walletId = this.idGenerator.nextId();
    const openingTxId = initialMoney.isPositive()
      ? this.idGenerator.nextId()
      : undefined;
    const openingLedgerId = initialMoney.isPositive()
      ? this.idGenerator.nextId()
      : undefined;

    const { wallet, openingLedgerEntry } = Wallet.create({
      id: walletId,
      playerId: command.playerId,
      initialBalance: initialMoney,
      now,
      openingTransactionId: openingTxId,
      openingLedgerEntryId: openingLedgerId,
    });

    requestContext.set({ walletId: wallet.id });

    const openingTx =
      openingLedgerEntry && openingTxId
        ? WagerTransaction.createOpening({
            id: openingTxId,
            walletId: wallet.id,
            playerId: wallet.playerId,
            money: initialMoney,
            payloadHash: hashWagerPayload({
              providerId: "system",
              externalTransactionId: `opening:${wallet.id}`,
              playerId: wallet.playerId,
              walletId: wallet.id,
              roundId: `opening:${wallet.id}`,
              gameId: "system",
              kind: "OPENING",
              money: initialMoney.toJSON(),
            }),
            now,
          })
        : null;

    const em = this.orm.em.fork() as EntityManager;

    try {
      await em.transactional(async (tx) => {
        tx.create(WalletSchema, walletToRecord(wallet));
        await tx.flush();

        if (openingTx && openingLedgerEntry) {
          tx.create(WagerTransactionSchema, wagerTransactionToRecord(openingTx));
          await tx.flush();

          tx.create(
            WalletLedgerEntrySchema,
            ledgerEntryToRecord(openingLedgerEntry),
          );
          await tx.flush();
        }
      });
    } catch (error) {
      if (isPgUniqueViolation(error, "uq_wallets_player_currency")) {
        throw new ConflictError(
          "WALLET_ALREADY_EXISTS",
          "Wallet already exists for this playerId and currency.",
          { currency: wallet.currency },
        );
      }
      if (isPgUnavailableError(error)) {
        throw new TransientServiceException(
          "DATABASE_UNAVAILABLE",
          "Database is temporarily unavailable.",
        );
      }
      throw error;
    }

    return wallet;
  }
}
