import { Body, Controller, HttpCode, HttpStatus, Inject, Post } from "@nestjs/common";
import { z } from "zod";
import { parseWithZod } from "../../shared/infrastructure/http/zod-validation.ts";
import { RunReconciliationUseCase } from "../application/run-reconciliation.use-case.ts";

const runReconciliationSchema = z
  .object({
    walletId: z.string().min(1).optional(),
  })
  .strict();

@Controller("reconciliation")
export class ReconciliationController {
  constructor(
    @Inject(RunReconciliationUseCase)
    private readonly runReconciliation: RunReconciliationUseCase,
  ) {}

  @Post("run")
  @HttpCode(HttpStatus.OK)
  async run(@Body() rawBody: unknown) {
    const body =
      rawBody === undefined || rawBody === null || rawBody === ""
        ? {}
        : parseWithZod(runReconciliationSchema, rawBody);
    return this.runReconciliation.execute(body.walletId);
  }
}
