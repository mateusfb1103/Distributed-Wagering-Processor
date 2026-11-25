import { Injectable } from "@nestjs/common";
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";

@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly wagerTransactionsTotal: Counter<
    "kind" | "status" | "source" | "failure_code"
  >;
  readonly wagerProcessingDurationSeconds: Histogram<
    "kind" | "status" | "source"
  >;
  readonly walletLockContentionTotal: Counter<string>;
  readonly outboxPublishedTotal: Counter<"event_type">;
  readonly outboxFailuresTotal: Counter<"event_type">;
  readonly outboxPendingGauge: Gauge<string>;
  readonly sqsMessagesTotal: Counter<"outcome">;
  readonly pendingReferenceResolutionsTotal: Counter<"outcome">;

  constructor() {
    collectDefaultMetrics({ register: this.registry });

    this.wagerTransactionsTotal = new Counter({
      name: "dwp_wager_transactions_total",
      help: "Total wager transactions processed by kind, status, source and failure code",
      labelNames: ["kind", "status", "source", "failure_code"],
      registers: [this.registry],
    });

    this.wagerProcessingDurationSeconds = new Histogram({
      name: "dwp_wager_processing_duration_seconds",
      help: "Latency of wager transaction processing in seconds",
      labelNames: ["kind", "status", "source"],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers: [this.registry],
    });

    this.walletLockContentionTotal = new Counter({
      name: "dwp_wallet_lock_contention_total",
      help: "Count of wallet row lock contentions detected via NOWAIT probe (D01)",
      registers: [this.registry],
    });

    this.outboxPublishedTotal = new Counter({
      name: "dwp_outbox_published_total",
      help: "Total outbox events published to SQS",
      labelNames: ["event_type"],
      registers: [this.registry],
    });

    this.outboxFailuresTotal = new Counter({
      name: "dwp_outbox_failures_total",
      help: "Total outbox publish failures",
      labelNames: ["event_type"],
      registers: [this.registry],
    });

    this.outboxPendingGauge = new Gauge({
      name: "dwp_outbox_pending_gauge",
      help: "Current number of unpublished outbox messages",
      registers: [this.registry],
    });

    this.sqsMessagesTotal = new Counter({
      name: "dwp_sqs_messages_total",
      help: "Total SQS consumer messages handled by outcome",
      labelNames: ["outcome"],
      registers: [this.registry],
    });

    this.pendingReferenceResolutionsTotal = new Counter({
      name: "dwp_pending_reference_resolutions_total",
      help: "Total PENDING_REFERENCE resolution attempts by outcome",
      labelNames: ["outcome"],
      registers: [this.registry],
    });
  }

  recordTransaction(params: {
    readonly kind: string;
    readonly status: string;
    readonly source: "http" | "sqs" | "pending-worker";
    readonly failureCode: string | null;
    readonly durationSeconds: number;
  }): void {
    this.wagerTransactionsTotal.inc({
      kind: params.kind,
      status: params.status,
      source: params.source,
      failure_code: params.failureCode ?? "none",
    });
    this.wagerProcessingDurationSeconds.observe(
      {
        kind: params.kind,
        status: params.status,
        source: params.source,
      },
      params.durationSeconds,
    );
  }

  incrementLockContention(): void {
    this.walletLockContentionTotal.inc();
  }

  async renderPrometheus(): Promise<string> {
    return this.registry.metrics();
  }
}
