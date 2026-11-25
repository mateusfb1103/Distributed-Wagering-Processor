import { Inject, Injectable } from "@nestjs/common";
import { type EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { WalletSchema } from "../../database/entities/wallet.entity.ts";
import { isPgUnavailableError } from "../../shared/infrastructure/database/pg-errors.ts";
import { TransientServiceException } from "../../shared/infrastructure/http/http-exception.filter.ts";
import type { Wallet } from "../domain/wallet.ts";
import { walletToDomain } from "../infrastructure/persistence/wallet.mapper.ts";

@Injectable()
export class GetWalletUseCase {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async execute(walletId: string): Promise<Wallet | null> {
    const em = this.orm.em.fork() as EntityManager;
    try {
      const record = await em.findOne(WalletSchema, { id: walletId });
      return record ? walletToDomain(record) : null;
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
