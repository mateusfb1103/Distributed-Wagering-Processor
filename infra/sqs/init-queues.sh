#!/usr/bin/env bash
set -euo pipefail

# Inicializa de forma idempotente as filas SQS FIFO via @aws-sdk/client-sqs
# (funciona igualmente contra MiniStack e LocalStack via SQS_ENDPOINT).
exec bun run "$(dirname "$0")/init-queues.ts"
