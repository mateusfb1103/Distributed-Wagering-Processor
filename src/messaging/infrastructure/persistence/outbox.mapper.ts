import type { OutboxMessageRecord } from "../../../database/entities/outbox-message.entity.ts";
import type { DomainEvent } from "../../../shared/domain/domain-event.ts";

export function domainEventToOutboxRecord(
  event: DomainEvent<string, object>,
  correlationId: string | null,
  now: Date,
): OutboxMessageRecord {
  return {
    eventId: event.eventId,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    eventType: event.eventType,
    payload: {
      eventId: event.eventId,
      eventType: event.eventType,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      occurredAt: event.occurredAt.toISOString(),
      payload: event.payload,
    },
    correlationId,
    occurredAt: event.occurredAt,
    createdAt: now,
    attemptCount: 0,
    nextAttemptAt: now,
    lockedBy: null,
    lockedUntil: null,
    publishedAt: null,
    lastError: null,
  };
}
