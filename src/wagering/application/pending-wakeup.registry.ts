import { Injectable } from "@nestjs/common";

/**
 * Ponto desacoplado para o SubmitWagerTransactionUseCase sinalizar ao worker
 * `PENDING_REFERENCE` que uma possível transação de referência foi confirmada (D11).
 */
@Injectable()
export class PendingWakeUpRegistry {
  private handler: (() => void) | null = null;

  register(handler: () => void): void {
    this.handler = handler;
  }

  trigger(): void {
    if (this.handler) {
      this.handler();
    }
  }
}
