import { defineEntity, p } from "@mikro-orm/core";

export const OutboxMessageSchema = defineEntity({
  name: "OutboxMessageRecord",
  tableName: "outbox_messages",
  properties: {
    eventId: p.string().primary().name("event_id"),
    aggregateType: p.string().name("aggregate_type"),
    aggregateId: p.string().name("aggregate_id"),
    eventType: p.string().name("event_type"),
    payload: p.json<Record<string, unknown>>(),
    correlationId: p.string().strictNullable().name("correlation_id"),
    occurredAt: p.datetime().name("occurred_at"),
    createdAt: p.datetime().name("created_at"),
    attemptCount: p.integer().name("attempt_count"),
    nextAttemptAt: p.datetime().name("next_attempt_at"),
    lockedBy: p.string().strictNullable().name("locked_by"),
    lockedUntil: p.datetime().strictNullable().name("locked_until"),
    publishedAt: p.datetime().strictNullable().name("published_at"),
    lastError: p.string().strictNullable().name("last_error"),
  },
});

export type OutboxMessageRecord = (typeof OutboxMessageSchema)["~entity"];
