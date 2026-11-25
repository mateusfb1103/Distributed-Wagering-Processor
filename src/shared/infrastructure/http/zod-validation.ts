import type { z } from "zod";
import { ContractViolationError } from "../../domain/domain-error.ts";

export function parseWithZod<T extends z.ZodTypeAny>(
  schema: T,
  raw: unknown,
): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) {
    return parsed.data;
  }

  const issues = parsed.error.issues.map((issue) => ({
    path: issue.path.join("."),
    code: issue.code,
    message: issue.message,
  }));

  throw new ContractViolationError(
    "INVALID_PAYLOAD",
    "Request payload validation failed.",
    { issues },
  );
}
