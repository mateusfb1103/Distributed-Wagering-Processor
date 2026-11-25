import { Module } from "@nestjs/common";
import { GetWagerTransactionUseCase } from "./application/get-wager-transaction.use-case.ts";
import { SubmitWagerTransactionUseCase } from "./application/submit-wager-transaction.use-case.ts";
import { WagerTransactionController } from "./interface/wager-transaction.controller.ts";

@Module({
  controllers: [WagerTransactionController],
  providers: [SubmitWagerTransactionUseCase, GetWagerTransactionUseCase],
  exports: [SubmitWagerTransactionUseCase, GetWagerTransactionUseCase],
})
export class WageringModule {}
