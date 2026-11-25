import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { z } from "zod";
import { ResourceNotFoundException } from "../../shared/infrastructure/http/http-exception.filter.ts";
import { parseWithZod } from "../../shared/infrastructure/http/zod-validation.ts";
import { CreateWalletUseCase } from "../application/create-wallet.use-case.ts";
import { GetWalletUseCase } from "../application/get-wallet.use-case.ts";
import { ListWalletLedgerUseCase } from "../application/list-wallet-ledger.use-case.ts";
import type { Wallet } from "../domain/wallet.ts";

const createWalletSchema = z
  .object({
    playerId: z.string().min(1),
    initialBalance: z.string().default("0.00"),
    currency: z.string(),
  })
  .strict();

const listLedgerQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).optional(),
    order: z.enum(["asc", "desc"]).optional(),
  })
  .strict();

function serializeWallet(wallet: Wallet) {
  return {
    walletId: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toString(),
    version: wallet.version,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

@Controller("wallets")
export class WalletController {
  constructor(
    @Inject(CreateWalletUseCase)
    private readonly createWallet: CreateWalletUseCase,
    @Inject(GetWalletUseCase) private readonly getWallet: GetWalletUseCase,
    @Inject(ListWalletLedgerUseCase)
    private readonly listLedger: ListWalletLedgerUseCase,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() rawBody: unknown) {
    const body = parseWithZod(createWalletSchema, rawBody);
    const wallet = await this.createWallet.execute(body);
    return serializeWallet(wallet);
  }

  @Get(":walletId")
  async findOne(@Param("walletId") walletId: string) {
    const wallet = await this.getWallet.execute(walletId);
    if (!wallet) {
      throw new ResourceNotFoundException(`Wallet ${walletId} not found.`, {
        walletId,
      });
    }
    return serializeWallet(wallet);
  }

  @Get(":walletId/ledger")
  async getLedger(
    @Param("walletId") walletId: string,
    @Query() rawQuery: unknown,
  ) {
    const query = parseWithZod(listLedgerQuerySchema, rawQuery ?? {});
    const result = await this.listLedger.execute({
      walletId,
      limit: query.limit,
      cursor: query.cursor,
      order: query.order,
    });
    if (!result) {
      throw new ResourceNotFoundException(`Wallet ${walletId} not found.`, {
        walletId,
      });
    }

    return {
      walletId,
      items: result.items.map((entry) => ({
        entryId: entry.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        amount: entry.amount.toString(),
        currency: entry.amount.currency,
        balanceBefore: entry.balanceBefore.toString(),
        balanceAfter: entry.balanceAfter.toString(),
        walletVersion: entry.walletVersion,
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: result.nextCursor,
    };
  }
}
