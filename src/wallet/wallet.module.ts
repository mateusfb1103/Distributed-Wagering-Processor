import { Module } from "@nestjs/common";
import { ReconciliationModule } from "../reconciliation/reconciliation.module.ts";
import { CreateWalletUseCase } from "./application/create-wallet.use-case.ts";
import { GetWalletUseCase } from "./application/get-wallet.use-case.ts";
import { ListWalletLedgerUseCase } from "./application/list-wallet-ledger.use-case.ts";
import { WalletController } from "./interface/wallet.controller.ts";

@Module({
  imports: [ReconciliationModule],
  controllers: [WalletController],
  providers: [CreateWalletUseCase, GetWalletUseCase, ListWalletLedgerUseCase],
  exports: [CreateWalletUseCase, GetWalletUseCase, ListWalletLedgerUseCase],
})
export class WalletModule {}
