export interface PgErrorDetails {
  readonly code?: string;
  readonly constraint?: string;
  readonly message: string;
}

export function extractPgError(error: unknown): PgErrorDetails | null {
  let current: unknown = error;
  const visited = new Set<unknown>();

  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const record = current as Record<string, unknown>;
    const code = typeof record.code === "string" ? record.code : undefined;
    const constraint =
      typeof record.constraint === "string" ? record.constraint : undefined;

    if (code || constraint) {
      return {
        code,
        constraint,
        message: error instanceof Error ? error.message : String(error),
      };
    }

    current = record.cause ?? record.driverException ?? record.originalError;
  }

  return null;
}

export function isPgUniqueViolation(
  error: unknown,
  constraintName?: string,
): boolean {
  const pg = extractPgError(error);
  if (!pg || pg.code !== "23505") {
    return false;
  }
  return constraintName ? pg.constraint === constraintName : true;
}

export function isPgLockNotAvailableOrTimeout(error: unknown): boolean {
  const pg = extractPgError(error);
  return pg?.code === "55P03";
}

export function isPgDeadlockOrSerialization(error: unknown): boolean {
  const pg = extractPgError(error);
  return pg?.code === "40P01" || pg?.code === "40001";
}

export function isPgUnavailableError(error: unknown): boolean {
  const pg = extractPgError(error);
  if (pg?.code) {
    if (
      pg.code.startsWith("08") ||
      pg.code.startsWith("57P") ||
      pg.code === "53300"
    ) {
      return true;
    }
  }

  const msg = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    msg.includes("econnrefused") ||
    msg.includes("connection terminated") ||
    msg.includes("timeout exceeded when trying to connect") ||
    msg.includes("the database system is starting up")
  );
}
