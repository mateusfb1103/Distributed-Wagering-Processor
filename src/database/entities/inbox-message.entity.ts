import { defineEntity, p } from "@mikro-orm/core";

export const InboxMessageSchema = defineEntity({
  name: "InboxMessageRecord",
  tableName: "inbox_messages",
  properties: {
    consumerName: p.string().primary().name("consumer_name"),
    messageId: p.string().primary().name("message_id"),
    payloadHash: p.string().name("payload_hash"),
    status: p.string(),
    receivedAt: p.datetime().name("received_at"),
    processedAt: p.datetime().strictNullable().name("processed_at"),
  },
});

export type InboxMessageRecord = (typeof InboxMessageSchema)["~entity"];
