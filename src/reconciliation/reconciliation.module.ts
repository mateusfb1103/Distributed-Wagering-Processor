import { Module } from "@nestjs/common";
import { RunReconciliationUseCase } from "./application/run-reconciliation.use-case.ts";
import { ReconciliationController } from "./interface/reconciliation.controller.ts";

@Module({
  controllers: [ReconciliationController],
  providers: [RunReconciliationUseCase],
  exports: [RunReconciliationUseCase],
})
export class ReconciliationModule {}
