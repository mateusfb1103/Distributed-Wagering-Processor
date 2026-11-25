import type { OutboxMessageRecord } from "../../../database/entities/outbox-message.entity.ts";
import type { DomainEvent } from "../../../shared/domain/domain-event.ts";
import { IntegrationEvent } from "../../../shared/domain/integration-event.ts";

export function domainEventToOutboxRecord(
  event: DomainEvent<string, object>,
  correlationId: string | null,
  now: Date,
): OutboxMessageRecord {
  const payload =
    event instanceof IntegrationEvent
      ? {
          ...event.toJSON(),
          correlationId:
            event.correlationId || correlationId || event.eventId,
        }
      : {
          eventId: event.eventId,
          eventType: event.eventType,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          correlationId: correlationId ?? event.eventId,
          occurredAt: event.occurredAt.toISOString(),
          version: 1,
          data: event.payload,
        };

  return {
    eventId: event.eventId,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    eventType: event.eventType,
    payload,
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
