import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
} from "@nestjs/common";
import { DomainError } from "../../domain/domain-error.ts";
import {
  type FailureCode,
  getFailureCodeMeta,
} from "../../domain/failure-codes.ts";
import { AppLogger } from "../observability/logger.service.ts";

interface HttpFilterResponse {
  setHeader(name: string, value: string): unknown;
  status(code: number): { json(body: unknown): unknown };
}

export interface HttpErrorBody {
  readonly code: FailureCode | "INTERNAL_ERROR" | "NOT_FOUND";
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
}

export class ResourceNotFoundException extends HttpException {
  constructor(message: string, details?: Record<string, unknown>) {
    super(
      {
        code: "NOT_FOUND",
        message,
        retryable: false,
        ...(details !== undefined ? { details } : {}),
      },
      HttpStatus.NOT_FOUND,
    );
  }
}

export class TransientServiceException extends DomainError {
  constructor(
    code: "DATABASE_UNAVAILABLE" | "WALLET_BUSY" | "SERVICE_UNAVAILABLE",
    message: string,
    readonly retryAfterSeconds = 1,
    details?: Record<string, unknown>,
  ) {
    super(code, message, details);
  }
}

export function mapDomainErrorToHttp(error: DomainError): {
  status: number;
  body: HttpErrorBody;
  retryAfterSeconds?: number;
} {
  const meta = getFailureCodeMeta(error.code);
  const status = meta.httpStatus ?? HttpStatus.INTERNAL_SERVER_ERROR;

  const body: HttpErrorBody = {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(error.details !== undefined ? { details: error.details } : {}),
  };

  if (error instanceof TransientServiceException) {
    return { status, body, retryAfterSeconds: error.retryAfterSeconds };
  }

  return status === HttpStatus.SERVICE_UNAVAILABLE
    ? { status, body, retryAfterSeconds: 1 }
    : { status, body };
}

@Catch()
export class GlobalHttpExceptionFilter implements ExceptionFilter {
  constructor(@Inject(AppLogger) private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<HttpFilterResponse>();

    if (exception instanceof DomainError) {
      const mapped = mapDomainErrorToHttp(exception);
      if (mapped.retryAfterSeconds !== undefined) {
        res.setHeader("Retry-After", String(mapped.retryAfterSeconds));
      }
      res.status(mapped.status).json(mapped.body);
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      if (
        typeof raw === "object" &&
        raw !== null &&
        "code" in raw &&
        "message" in raw
      ) {
        res.status(status).json(raw);
        return;
      }

      const code =
        status === HttpStatus.NOT_FOUND ? "NOT_FOUND" : "INVALID_PAYLOAD";
      res.status(status).json({
        code,
        message: exception.message,
        retryable: false,
      });
      return;
    }

    const message =
      exception instanceof Error ? exception.message : "Unexpected error";
    this.logger.error("Unhandled HTTP exception", { errorMessage: message });
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      code: "INTERNAL_ERROR",
      message: "Internal server error.",
      retryable: false,
    });
  }
}
