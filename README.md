# Distributed Wagering Processor

Serviço financeiro distribuído para processamento de transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) recebidas de múltiplos provedores via HTTP e AWS SQS, construído com **Bun**, **TypeScript** (estrito), **NestJS**, **MikroORM** e **PostgreSQL**.

> **Status do projeto:** Fase 3 (observabilidade, casos de uso D01/D02/D11, API HTTP D07/D13 e reconciliação) concluída na branch `fase-3/api-casos-de-uso`.

## Endpoints HTTP

| Método | Caminho | Descrição |
|---|---|---|
| `GET` | `/health/live` | Liveness probe (`200`) |
| `GET` | `/health/ready` | Readiness probe verificando PostgreSQL e SQS (`200` / `503`) |
| `GET` | `/metrics` | Métricas Prometheus (`prom-client`) |
| `POST` | `/wallets` | Cria carteira (`initialBalance` opcional, padrão `"0.00"`) |
| `GET` | `/wallets/:walletId` | Consulta saldo e versão da carteira |
| `GET` | `/wallets/:walletId/ledger` | Pagina histórico do razão (`limit` 1..200, `order`, `cursor`) |
| `POST` | `/wager-transactions` | Submete `BET`/`WIN`/`LOSS`/`REFUND`/`ROLLBACK` (`201` novo, `200` replay, `202` `PENDING_REFERENCE`, `422` rejeição/ausência de carteira, `400`/`409`/`503`) |
| `GET` | `/wager-transactions/:transactionId` | Consulta transação persistida |
| `POST` | `/reconciliation/run` | Verifica invariante `wallet.balance == Σ ledger` (global ou `{ walletId }`) |

## Setup local e comandos

Pré-requisitos: **Bun 1.x** e **Docker** (com Docker Compose).

```bash
# 1. Instalar dependências
bun install

# 2. Subir PostgreSQL 17 (com roles dwp_migrator / dwp_app) e MiniStack (SQS)
docker compose up -d --wait

# 3. Inicializar filas SQS FIFO (principal com RedrivePolicy, DLQ e wagering-events.fifo)
bun run sqs:init

# 4. Rodar migrations (up / down reversível)
bun run db:migrate
bun run db:rollback
bun run db:migrate

# 5. Verificações e testes
bun run typecheck
bun run lint
bun run test:integration
```

---

## Decisões técnicas

Resumo consolidado de todas as decisões arquiteturais (aprovadas) e convencionais do projeto. O detalhamento completo, alternativas descartadas e trade-offs estão em [ARCHITECTURE.md](./ARCHITECTURE.md).

| Decisão | Motivo | Referência |
|---|---|---|
| **D01 — Concorrência por wallet:** lock pessimista (`SELECT … FOR UPDATE` em `READ COMMITTED` + `lock_timeout`), checagem de `version` no `UPDATE` e `CHECK (balance >= 0)` como backstops; tentativa inicial `NOWAIT` só para contabilizar contenção | Garante determinismo sem retry storm (especialmente sob alta contenção na mesma wallet), impede lost update e saldo negativo em múltiplas instâncias e mantém wallets distintas em paralelo | [ARCHITECTURE.md — D01](./ARCHITECTURE.md#d01--estratégia-de-concorrência-por-wallet) |
| **D02 — Idempotência:** chave persistida em `wager_transactions` com `UNIQUE (provider_id, idempotency_key)`, lookup sob lock da wallet, snapshot de resultado na própria linha e replay devolvendo o estado atual | Elimina cache em memória e tabela duplicada de respostas, isola chaves entre provedores e mantém consistência atômica mesmo sob corridas e restarts | [ARCHITECTURE.md — D02](./ARCHITECTURE.md#d02--mecânica-e-escopo-da-idempotência) |
| **D03 — Unicidade de reversões:** no máximo uma reversão `PROCESSED` por transação referenciada (seja `REFUND` ou `ROLLBACK`), garantida por índice único parcial | Evita a brecha da leitura literal da regra 4 (§7), que permitiria `REFUND` + `ROLLBACK` sobre a mesma `BET` causando crédito duplicado | [ARCHITECTURE.md — D03](./ARCHITECTURE.md#d03--unicidade-de-reversões) |
| **D04 — Representação de `Money`:** `bigint` interno em centavos (escala fixa 2), `NUMERIC(20,2)` no PostgreSQL, contrato estrito `^(0\|[1-9]\d{0,17})\.\d{2}$`, zero proibido em `BET`/`WIN`/`REFUND`/`ROLLBACK` e sem arredondamento silencioso | Cumpre a proibição de `number`/ponto flutuante sem dependência externa, garante aritmética exata e legibilidade/agregação exata (`SUM`) no banco | [ARCHITECTURE.md — D04](./ARCHITECTURE.md#d04--representação-de-money) |
| **D05 — ORM e mapeamento:** MikroORM 7 com entidades de persistência separadas (`defineEntity`, sem decorators) e mappers explícitos via `rehydrate`; SQL cru pontual (`SKIP LOCKED`, reconciliação, `NOWAIT`) | Atende à preferência pelo MikroORM (`EntityManager.transactional()`, `LockMode`) mantendo o domínio 100% puro e respeitando `rehydrate` sem revalidação (§6.0/§6.1) | [ARCHITECTURE.md — D05](./ARCHITECTURE.md#d05--orm-e-mapeamento-domínio--persistência) |
| **D06 — Garantias no schema:** constraints base (`UNIQUE`, `CHECK`, FK composta de moeda, trigger de imutabilidade do ledger) + 4 reforços: trigger de transições terminais/imutabilidade (R-a), trigger `version` ↔ `balance` (R-b), constraint trigger diferida saldo ↔ ledger no commit (R-c) e roles separadas `migrator`/`app` com `REVOKE` no ledger (R-d) | Garante invariantes críticas diretamente no PostgreSQL (§5.9), impedindo corrupção mesmo diante de bugs na aplicação ou bypass de `rehydrate` | [ARCHITECTURE.md — D06](./ARCHITECTURE.md#d06--garantias-no-schema) |
| **D07 — Status HTTP e corpo de erro:** `201` para `PROCESSED` novo e `200` no replay, `202` `PENDING_REFERENCE`, `422` `REJECTED`/`WALLET_NOT_FOUND`, `400` inválido, `409` conflito, `503` + `Retry-After` transitório, `404` GET inexistente; corpo único `{ code, message, retryable, … }` | Permite ao provedor distinguir criação, replay, pendência, erro de negócio, conflito e falha transitória pelo status code sem interpretar texto | [ARCHITECTURE.md — D07](./ARCHITECTURE.md#d07--mapeamento-de-status-http-e-corpo-de-erro) |
| **D08 — Emulador SQS:** MiniStack como padrão + `SQS_ENDPOINT` configurável (fallback para `localstack/localstack:4.4.0` se o spike F0 detectar limitação FIFO/redrive) | Evita bloqueio por `LOCALSTACK_AUTH_TOKEN` obrigatório no `localstack:latest`, mantendo `docker compose up` sem conta/credenciais | [ARCHITECTURE.md — D08](./ARCHITECTURE.md#d08--emulador-sqs) |
| **D09 — Outbox com múltiplos publishers:** claim curto via `FOR UPDATE SKIP LOCKED` + lease (`locked_by`, `locked_until` de 30s), publicação fora da transação na nova fila `wagering-events.fifo` (`MessageGroupId = aggregateId`, `MessageDeduplicationId = eventId`) | Impede publicação antes do commit, não prende conexões do pool durante I/O de rede, escala com múltiplos publishers e recupera automaticamente após crashes | [ARCHITECTURE.md — D09](./ARCHITECTURE.md#d09--outbox-com-múltiplos-publishers) |
| **D10 — Consumer SQS:** classificação híbrida (negócio → ack; transitório → backoff via `ChangeMessageVisibility` + redrive após 5 tentativas; permanente → DLQ imediata + delete), graceful shutdown em `SIGTERM`, `APP_ROLES` e `FAULT_INJECTION_POINT` (só teste) | Evita poison pills travando o grupo FIFO, exercita a `RedrivePolicy` real para falhas transitórias, protege mensagens em voo no shutdown e viabiliza o teste de crash pós-commit | [ARCHITECTURE.md — D10](./ARCHITECTURE.md#d10--consumer-sqs-classificação-de-erros-retry-e-dlq) |
| **D11 — Política de `PENDING_REFERENCE`:** backoff exponencial (1s..60s) + TTL de 15 min configurável por env + wake-up imediato no commit da referência | Dá previsibilidade de SLA no tempo de relógio, elimina espera desnecessária quando a referência chega e evita republicação duplicada de `WagerTransactionPendingReference` | [ARCHITECTURE.md — D11](./ARCHITECTURE.md#d11--política-de-pending_reference) |
| **D12 — Algoritmo do `payloadHash`:** `SHA-256` (hex) sobre JSON canônico (RFC 8785) do subconjunto de negócio compartilhado entre HTTP e SQS, rejeitando campos desconhecidos; inbox usa `SHA-256` do corpo bruto | Torna a detecção de conflito determinística independente da ordem de chaves/espaços e consistente entre HTTP e SQS, sem zona cinzenta para campos extras | [ARCHITECTURE.md — D12](./ARCHITECTURE.md#d12--algoritmo-do-payloadhash) |
| **D13 — Autenticação:** não implementar agora; manter `AuthGuard` no-op + `ProviderIdentityPort` e desenho alvo OIDC com Keycloak documentado (implementação opcional na F9) | Autenticação não pontua (§2/§14); preserva o foco nos 70 pontos centrais de correção, concorrência, idempotência e mensageria, deixando ponto de extensão explícito | [ARCHITECTURE.md — D13](./ARCHITECTURE.md#d13--autenticação) |
| **D14 — Taxonomia de `failureCode`:** códigos estáveis separados por categoria (contrato, conflito, negócio, transitório e permanente), distinguindo `REVERSAL_INSUFFICIENT_FUNDS` de `INSUFFICIENT_FUNDS` e expondo `retryable` | Permite ao provedor decidir programaticamente entre reenviar, corrigir o payload ou desistir (§7.2 e §7 regra 9) | [ARCHITECTURE.md — D14](./ARCHITECTURE.md#d14--taxonomia-de-failurecode) |
| **IDs UUIDv7 na aplicação (`Bun.randomUUIDv7()`)** | Mesmo formato dos exemplos do enunciado, boa localidade de índice B-Tree e geração sem round-trip ao banco | [ARCHITECTURE.md — §3](./ARCHITECTURE.md#3-decisões-convencionais-tomadas-sem-aprovação-contestáveis) |
| **Datas em `timestamptz` (UTC)** | Elimina ambiguidade de fuso horário entre instâncias e banco | [ARCHITECTURE.md — §3](./ARCHITECTURE.md#3-decisões-convencionais-tomadas-sem-aprovação-contestáveis) |
| **`snake_case` no banco e `camelCase` no TypeScript** | Segue a convenção idiomática de cada camada | [ARCHITECTURE.md — §3](./ARCHITECTURE.md#3-decisões-convencionais-tomadas-sem-aprovação-contestáveis) |
| **Logs JSON com `pino` + `AsyncLocalStorage`** | Baixo overhead, compatível com Bun e propaga `correlationId`/`messageId`/`walletId`/`transactionId`/`providerId` automaticamente | [ARCHITECTURE.md — §3](./ARCHITECTURE.md#3-decisões-convencionais-tomadas-sem-aprovação-contestáveis) |
| **Logs sem valores monetários, saldos, `playerId` ou payloads completos** | Cumpre a restrição de privacidade e segurança de observabilidade (§12) | [ARCHITECTURE.md — §3](./ARCHITECTURE.md#3-decisões-convencionais-tomadas-sem-aprovação-contestáveis) |
| **Métricas Prometheus via `prom-client` em `GET /metrics` (sem auth)** | Padrão de mercado para expor contadores, histogramas e gauges exigidos pela §12 | [ARCHITECTURE.md — §3](./ARCHITECTURE.md#3-decisões-convencionais-tomadas-sem-aprovação-contestáveis) |
| **Cliente SQS `@aws-sdk/client-sqs` v3** | SDK oficial da AWS, compatível com MiniStack e LocalStack | [ARCHITECTURE.md — §3](./ARCHITECTURE.md#3-decisões-convencionais-tomadas-sem-aprovação-contestáveis) |
| **Validação de borda com `zod` (`.strict()`)** | Rejeita campos desconhecidos (D12) com inferência de tipos e sem acoplar decorators ao domínio | [ARCHITECTURE.md — §3](./ARCHITECTURE.md#3-decisões-convencionais-tomadas-sem-aprovação-contestáveis) |
| **Infra de testes via Docker Compose (sem Testcontainers)** | Reaproveita o Compose obrigatório e evita risco de incompatibilidade do Testcontainers com Bun | [ARCHITECTURE.md — §3](./ARCHITECTURE.md#3-decisões-convencionais-tomadas-sem-aprovação-contestáveis) |
| **Correlação via `X-Correlation-Id` (HTTP) e atributo/messageId (SQS)** | Garante rastreabilidade ponta a ponta entre entrada, logs e eventos de integração | [ARCHITECTURE.md — §3](./ARCHITECTURE.md#3-decisões-convencionais-tomadas-sem-aprovação-contestáveis) |
| **Paginação do ledger com `limit` padrão 50 e máximo 200 (cursor por `wallet_version`)** | Protege o banco contra leituras ilimitadas e garante cursor estável e opaco independente de clock skew | [ARCHITECTURE.md — §3](./ARCHITECTURE.md#3-decisões-convencionais-tomadas-sem-aprovação-contestáveis) |
| **ESLint (`typescript-eslint`) proibindo `parseFloat`/`Number()`/`number` em `Money`** | Verificação automatizada contra regressão na restrição inviolável R1 (§5.1) | [ARCHITECTURE.md — §3](./ARCHITECTURE.md#3-decisões-convencionais-tomadas-sem-aprovação-contestáveis) |
