import { Injectable, type NestMiddleware } from "@nestjs/common";
import { requestContext } from "../observability/request-context.ts";

export const CORRELATION_ID_HEADER = "x-correlation-id";

interface HttpHeaderRequest {
  header(name: string): string | undefined;
}

interface HttpHeaderResponse {
  setHeader(name: string, value: string): unknown;
}

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: HttpHeaderRequest, res: HttpHeaderResponse, next: () => void): void {
    const incoming = req.header(CORRELATION_ID_HEADER)?.trim();
    const correlationId =
      incoming && incoming.length > 0 ? incoming : Bun.randomUUIDv7();

    res.setHeader("X-Correlation-Id", correlationId);
    requestContext.run({ correlationId }, () => next());
  }
}
