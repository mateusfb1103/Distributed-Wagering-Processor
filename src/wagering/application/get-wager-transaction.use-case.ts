import { Inject, Injectable } from "@nestjs/common";
import { type EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { WagerTransactionSchema } from "../../database/entities/wager-transaction.entity.ts";
import { isPgUnavailableError } from "../../shared/infrastructure/database/pg-errors.ts";
import { TransientServiceException } from "../../shared/infrastructure/http/http-exception.filter.ts";
import type { WagerTransaction } from "../domain/wager-transaction.ts";
import { wagerTransactionToDomain } from "../infrastructure/persistence/wager-transaction.mapper.ts";

@Injectable()
export class GetWagerTransactionUseCase {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async execute(transactionId: string): Promise<WagerTransaction | null> {
    const em = this.orm.em.fork() as EntityManager;
    try {
      const record = await em.findOne(WagerTransactionSchema, {
        id: transactionId,
      });
      return record ? wagerTransactionToDomain(record) : null;
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
