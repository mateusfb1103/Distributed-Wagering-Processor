import { Module } from "@nestjs/common";
import { WageringModule } from "../wagering/wagering.module.ts";
import { OutboxPublisherService } from "./application/outbox-publisher.service.ts";
import { SqsConsumerService } from "./application/sqs-consumer.service.ts";
import { SqsClientService } from "./infrastructure/sqs-client.service.ts";

@Module({
  imports: [WageringModule],
  providers: [SqsClientService, OutboxPublisherService, SqsConsumerService],
  exports: [SqsClientService, OutboxPublisherService, SqsConsumerService],
})
export class MessagingModule {}
