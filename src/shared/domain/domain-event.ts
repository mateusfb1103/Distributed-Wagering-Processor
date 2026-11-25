export type AggregateType = "Wallet" | "WagerTransaction";

export interface DomainEvent<
  TType extends string = string,
  TPayload extends object = Record<string, unknown>,
> {
  readonly eventId: string;
  readonly eventType: TType;
  readonly aggregateType: AggregateType;
  readonly aggregateId: string;
  readonly occurredAt: Date;
  readonly payload: TPayload;
}
