import { Module } from "@nestjs/common";
import { GetWagerTransactionUseCase } from "./application/get-wager-transaction.use-case.ts";
import { PendingReferenceWorkerService } from "./application/pending-reference-worker.service.ts";
import { PendingWakeUpRegistry } from "./application/pending-wakeup.registry.ts";
import { SubmitWagerTransactionUseCase } from "./application/submit-wager-transaction.use-case.ts";
import {
  ProviderWagerTransactionController,
  WagerTransactionController,
} from "./interface/wager-transaction.controller.ts";

@Module({
  controllers: [WagerTransactionController, ProviderWagerTransactionController],
  providers: [
    PendingWakeUpRegistry,
    SubmitWagerTransactionUseCase,
    GetWagerTransactionUseCase,
    PendingReferenceWorkerService,
  ],
  exports: [
    SubmitWagerTransactionUseCase,
    GetWagerTransactionUseCase,
    PendingReferenceWorkerService,
  ],
})
export class WageringModule {}
