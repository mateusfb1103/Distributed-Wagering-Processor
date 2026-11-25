import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Inject,
  Param,
  Post,
  Res,
} from "@nestjs/common";
import { z } from "zod";
import { ContractViolationError } from "../../shared/domain/domain-error.ts";
import { ResourceNotFoundException } from "../../shared/infrastructure/http/http-exception.filter.ts";
import { parseWithZod } from "../../shared/infrastructure/http/zod-validation.ts";
import { GetWagerTransactionUseCase } from "../application/get-wager-transaction.use-case.ts";
import { SubmitWagerTransactionUseCase } from "../application/submit-wager-transaction.use-case.ts";
import type { WagerTransaction } from "../domain/wager-transaction.ts";

interface HttpStatusResponse {
  status(code: number): unknown;
}

const submitWagerBodySchema = z
  .object({
    providerId: z.string().min(1),
    idempotencyKey: z.string().optional(),
    externalTransactionId: z.string().min(1),
    playerId: z.string().min(1),
    walletId: z.string().min(1),
    roundId: z.string().min(1),
    gameId: z.string().min(1),
    kind: z.string().min(1),
    money: z
      .object({
        amount: z.string(),
        currency: z.string(),
      })
      .strict(),
    referenceExternalTransactionId: z.string().nullable().optional(),
  })
  .strict();

function serializeTransaction(
  tx: WagerTransaction,
  idempotentReplay?: boolean,
) {
  const base = {
    transactionId: tx.id,
    providerId: tx.providerId,
    idempotencyKey: tx.idempotencyKey,
    externalTransactionId: tx.externalTransactionId,
    playerId: tx.playerId,
    walletId: tx.walletId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    status: tx.status,
    money: tx.money.toJSON(),
    referenceTransactionId: tx.referenceTransactionId,
    referenceExternalTransactionId: tx.referenceExternalTransactionId,
    failureCode: tx.failureCode,
    balance: tx.resultBalance?.toString() ?? null,
    walletVersion: tx.resultWalletVersion,
    nextAttemptAt: tx.nextAttemptAt?.toISOString() ?? null,
    expiresAt: tx.expiresAt?.toISOString() ?? null,
    processedAt: tx.processedAt?.toISOString() ?? null,
    createdAt: tx.createdAt.toISOString(),
    updatedAt: tx.updatedAt.toISOString(),
  };

  if (idempotentReplay === undefined) {
    return base;
  }

  if (tx.status === "REJECTED") {
    return {
      code: tx.failureCode,
      message: `Transaction rejected with business code ${tx.failureCode}.`,
      retryable: false,
      ...base,
      idempotentReplay,
    };
  }

  return {
    ...base,
    idempotentReplay,
  };
}

@Controller(["wager-transactions", "wagering/transactions"])
export class WagerTransactionController {
  constructor(
    @Inject(SubmitWagerTransactionUseCase)
    private readonly submitWager: SubmitWagerTransactionUseCase,
    @Inject(GetWagerTransactionUseCase)
    private readonly getWager: GetWagerTransactionUseCase,
  ) {}

  @Post()
  async submit(
    @Body() rawBody: unknown,
    @Headers("idempotency-key") headerIdempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: HttpStatusResponse,
  ) {
    const body = parseWithZod(submitWagerBodySchema, rawBody);
    const headerKey = headerIdempotencyKey?.trim();
    const bodyKey = body.idempotencyKey?.trim();

    if (headerKey && bodyKey && headerKey !== bodyKey) {
      throw new ContractViolationError(
        "INVALID_PAYLOAD",
        "Idempotency-Key header and body idempotencyKey must match when both are provided.",
      );
    }

    const idempotencyKey = headerKey || bodyKey || "";
    if (idempotencyKey.length === 0) {
      throw new ContractViolationError(
        "IDEMPOTENCY_KEY_REQUIRED",
        "Idempotency-Key header or idempotencyKey field is required.",
      );
    }

    const result = await this.submitWager.execute({
      providerId: body.providerId,
      idempotencyKey,
      externalTransactionId: body.externalTransactionId,
      playerId: body.playerId,
      walletId: body.walletId,
      roundId: body.roundId,
      gameId: body.gameId,
      kind: body.kind,
      money: body.money,
      referenceExternalTransactionId: body.referenceExternalTransactionId,
      source: "http",
    });

    const { transaction, idempotentReplay } = result;

    if (transaction.status === "PROCESSED") {
      res.status(idempotentReplay ? HttpStatus.OK : HttpStatus.CREATED);
    } else if (transaction.status === "PENDING_REFERENCE") {
      res.status(HttpStatus.ACCEPTED);
    } else if (transaction.status === "REJECTED") {
      res.status(HttpStatus.UNPROCESSABLE_ENTITY);
    } else {
      res.status(HttpStatus.INTERNAL_SERVER_ERROR);
    }

    return serializeTransaction(transaction, idempotentReplay);
  }

  @Get(":transactionId")
  async findOne(@Param("transactionId") transactionId: string) {
    const tx = await this.getWager.execute(transactionId);
    if (!tx) {
      throw new ResourceNotFoundException(
        `WagerTransaction ${transactionId} not found.`,
        { transactionId },
      );
    }
    return serializeTransaction(tx);
  }
}

@Controller("providers")
export class ProviderWagerTransactionController {
  constructor(
    @Inject(GetWagerTransactionUseCase)
    private readonly getWager: GetWagerTransactionUseCase,
  ) {}

  @Get(":providerId/wagering/transactions/:externalTransactionId")
  async findByExternal(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    const tx = await this.getWager.findByExternalId(
      providerId,
      externalTransactionId,
    );
    if (!tx) {
      throw new ResourceNotFoundException(
        `WagerTransaction ${externalTransactionId} for provider ${providerId} not found.`,
        { providerId, externalTransactionId },
      );
    }
    return serializeTransaction(tx);
  }
}
