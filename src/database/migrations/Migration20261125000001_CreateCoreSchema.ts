import { Migration } from "@mikro-orm/migrations";

export class Migration20261125000001_CreateCoreSchema extends Migration {
  override async up(): Promise<void> {
    // 1. Tabela wallets
    this.addSql(`
      CREATE TABLE wallets (
        id TEXT PRIMARY KEY,
        player_id TEXT NOT NULL,
        currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance NUMERIC(20, 2) NOT NULL CHECK (balance >= 0),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
        CONSTRAINT uq_wallets_id_currency UNIQUE (id, currency)
      );
    `);

    // 2. Tabela wager_transactions
    this.addSql(`
      CREATE TABLE wager_transactions (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        external_transaction_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        wallet_id TEXT NOT NULL REFERENCES wallets(id),
        round_id TEXT NOT NULL,
        game_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount NUMERIC(20, 2) NOT NULL CHECK (amount >= 0),
        currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        payload_hash TEXT NOT NULL,
        reference_external_transaction_id TEXT NULL,
        reference_transaction_id TEXT NULL REFERENCES wager_transactions(id),
        status TEXT NOT NULL CHECK (status IN ('PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code TEXT NULL,
        result_balance NUMERIC(20, 2) NULL CHECK (result_balance IS NULL OR result_balance >= 0),
        result_wallet_version INTEGER NULL CHECK (result_wallet_version IS NULL OR result_wallet_version >= 1),
        attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
        next_attempt_at TIMESTAMPTZ NULL,
        expires_at TIMESTAMPTZ NULL,
        processed_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT uq_wager_tx_provider_idempotency UNIQUE (provider_id, idempotency_key),
        CONSTRAINT uq_wager_tx_provider_external UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT chk_wager_tx_ref_ext CHECK (
          (kind IN ('REFUND', 'ROLLBACK') AND reference_external_transaction_id IS NOT NULL)
          OR (kind NOT IN ('REFUND', 'ROLLBACK') AND reference_external_transaction_id IS NULL)
        ),
        CONSTRAINT chk_wager_tx_failure_code CHECK (
          (status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL)
        ),
        CONSTRAINT chk_wager_tx_processed_at CHECK (
          (status = 'PROCESSED') = (processed_at IS NOT NULL)
        ),
        CONSTRAINT chk_wager_tx_opening_system CHECK (
          (kind = 'OPENING') = (provider_id = 'system')
        )
      );
    `);

    // D03: no máximo uma reversão PROCESSED (REFUND ou ROLLBACK) por transação referenciada
    this.addSql(`
      CREATE UNIQUE INDEX uq_wager_tx_single_reversal
        ON wager_transactions (reference_transaction_id)
        WHERE kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED';
    `);

    // D11: índices parciais para polling e wake-up de PENDING_REFERENCE
    this.addSql(`
      CREATE INDEX idx_wager_tx_pending_next_attempt
        ON wager_transactions (next_attempt_at)
        WHERE status = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      CREATE INDEX idx_wager_tx_pending_ref_lookup
        ON wager_transactions (provider_id, reference_external_transaction_id)
        WHERE status = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      CREATE INDEX idx_wager_tx_wallet_created
        ON wager_transactions (wallet_id, created_at DESC);
    `);

    // 3. Tabela wallet_ledger_entries
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id TEXT PRIMARY KEY,
        wallet_id TEXT NOT NULL,
        currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        transaction_id TEXT NOT NULL REFERENCES wager_transactions(id),
        direction TEXT NOT NULL CHECK (direction IN ('CREDIT', 'DEBIT')),
        amount NUMERIC(20, 2) NOT NULL CHECK (amount > 0),
        balance_before NUMERIC(20, 2) NOT NULL CHECK (balance_before >= 0),
        balance_after NUMERIC(20, 2) NOT NULL CHECK (balance_after >= 0),
        wallet_version INTEGER NOT NULL CHECK (wallet_version >= 1),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT fk_ledger_wallet_currency FOREIGN KEY (wallet_id, currency) REFERENCES wallets(id, currency),
        CONSTRAINT uq_ledger_wallet_transaction UNIQUE (wallet_id, transaction_id),
        CONSTRAINT uq_ledger_wallet_version UNIQUE (wallet_id, wallet_version),
        CONSTRAINT chk_ledger_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_before + amount = balance_after)
          OR (direction = 'DEBIT' AND balance_before - amount = balance_after)
        )
      );
    `);

    this.addSql(`
      CREATE INDEX idx_ledger_wallet_version_desc
        ON wallet_ledger_entries (wallet_id, wallet_version DESC);
    `);

    // 4. Tabela inbox_messages
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name TEXT NOT NULL,
        message_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('PROCESSING', 'PROCESSED', 'FAILED')),
        received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        processed_at TIMESTAMPTZ NULL,
        PRIMARY KEY (consumer_name, message_id)
      );
    `);

    // 5. Tabela outbox_messages
    this.addSql(`
      CREATE TABLE outbox_messages (
        event_id TEXT PRIMARY KEY,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload JSONB NOT NULL,
        correlation_id TEXT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        locked_by TEXT NULL,
        locked_until TIMESTAMPTZ NULL,
        published_at TIMESTAMPTZ NULL,
        last_error TEXT NULL
      );
    `);

    this.addSql(`
      CREATE INDEX idx_outbox_unpublished_next_attempt
        ON outbox_messages (next_attempt_at)
        WHERE published_at IS NULL;
    `);

    // D06 R-b: trigger de consistência version <-> balance em wallets
    this.addSql(`
      CREATE OR REPLACE FUNCTION fn_wallets_version_balance_guard()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.id IS DISTINCT FROM OLD.id
           OR NEW.player_id IS DISTINCT FROM OLD.player_id
           OR NEW.currency IS DISTINCT FROM OLD.currency
           OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'Immutable columns on wallets cannot be modified';
        END IF;

        IF NEW.balance IS DISTINCT FROM OLD.balance THEN
          IF NEW.version <> OLD.version + 1 THEN
            RAISE EXCEPTION 'Wallet version must increment by exactly 1 when balance changes (old %, new %)', OLD.version, NEW.version;
          END IF;
        ELSE
          IF NEW.version <> OLD.version THEN
            RAISE EXCEPTION 'Wallet version cannot change when balance is unchanged (old %, new %)', OLD.version, NEW.version;
          END IF;
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trg_wallets_version_balance
        BEFORE UPDATE ON wallets
        FOR EACH ROW
        EXECUTE FUNCTION fn_wallets_version_balance_guard();
    `);

    // D06 R-c: constraint trigger diferida garantindo entrada correspondente no ledger quando o saldo muda
    this.addSql(`
      CREATE OR REPLACE FUNCTION fn_wallets_ledger_consistency_guard()
      RETURNS TRIGGER AS $$
      BEGIN
        IF (TG_OP = 'INSERT' AND NEW.balance > 0)
           OR (TG_OP = 'UPDATE' AND NEW.balance IS DISTINCT FROM OLD.balance) THEN
          IF NOT EXISTS (
            SELECT 1
            FROM wallet_ledger_entries l
            WHERE l.wallet_id = NEW.id
              AND l.wallet_version = NEW.version
              AND l.balance_after = NEW.balance
          ) THEN
            RAISE EXCEPTION 'Wallet % version % balance % missing matching ledger entry (R-c)', NEW.id, NEW.version, NEW.balance;
          END IF;
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;

      CREATE CONSTRAINT TRIGGER trg_wallets_ledger_consistency
        AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION fn_wallets_ledger_consistency_guard();
    `);

    // D06 R-a: trigger bloqueando DELETE e mutações em estados terminais ou colunas imutáveis em wager_transactions
    this.addSql(`
      CREATE OR REPLACE FUNCTION fn_wager_transactions_immutability_guard()
      RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wager_transactions rows cannot be deleted';
        END IF;

        IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
          RAISE EXCEPTION 'Cannot mutate terminal wager_transaction % (status %)', OLD.id, OLD.status;
        END IF;

        IF NEW.id IS DISTINCT FROM OLD.id
           OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
           OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
           OR NEW.external_transaction_id IS DISTINCT FROM OLD.external_transaction_id
           OR NEW.player_id IS DISTINCT FROM OLD.player_id
           OR NEW.wallet_id IS DISTINCT FROM OLD.wallet_id
           OR NEW.round_id IS DISTINCT FROM OLD.round_id
           OR NEW.game_id IS DISTINCT FROM OLD.game_id
           OR NEW.kind IS DISTINCT FROM OLD.kind
           OR NEW.amount IS DISTINCT FROM OLD.amount
           OR NEW.currency IS DISTINCT FROM OLD.currency
           OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
           OR NEW.reference_external_transaction_id IS DISTINCT FROM OLD.reference_external_transaction_id
           OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'Immutable columns on wager_transactions cannot be modified';
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trg_wager_tx_immutability
        BEFORE UPDATE OR DELETE ON wager_transactions
        FOR EACH ROW
        EXECUTE FUNCTION fn_wager_transactions_immutability_guard();
    `);

    // D06: ledger estritamente append-only (sem UPDATE/DELETE/TRUNCATE)
    this.addSql(`
      CREATE OR REPLACE FUNCTION fn_ledger_append_only_guard()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only (% is forbidden)', TG_OP;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trg_ledger_append_only_row
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW
        EXECUTE FUNCTION fn_ledger_append_only_guard();

      CREATE TRIGGER trg_ledger_append_only_truncate
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT
        EXECUTE FUNCTION fn_ledger_append_only_guard();
    `);

    // D06: outbox imutável nos campos do evento
    this.addSql(`
      CREATE OR REPLACE FUNCTION fn_outbox_immutability_guard()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.event_id IS DISTINCT FROM OLD.event_id
           OR NEW.aggregate_type IS DISTINCT FROM OLD.aggregate_type
           OR NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id
           OR NEW.event_type IS DISTINCT FROM OLD.event_type
           OR NEW.payload IS DISTINCT FROM OLD.payload
           OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
           OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'Immutable event fields on outbox_messages cannot be modified';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trg_outbox_immutable_payload
        BEFORE UPDATE ON outbox_messages
        FOR EACH ROW
        EXECUTE FUNCTION fn_outbox_immutability_guard();
    `);

    // D06 R-d: revogar UPDATE/DELETE/TRUNCATE no ledger para dwp_app
    this.addSql(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dwp_app') THEN
          REVOKE UPDATE, DELETE, TRUNCATE ON TABLE wallet_ledger_entries FROM dwp_app;
        END IF;
      END
      $$;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TRIGGER IF EXISTS trg_outbox_immutable_payload ON outbox_messages;`);
    this.addSql(`DROP FUNCTION IF EXISTS fn_outbox_immutability_guard();`);

    this.addSql(`DROP TRIGGER IF EXISTS trg_ledger_append_only_truncate ON wallet_ledger_entries;`);
    this.addSql(`DROP TRIGGER IF EXISTS trg_ledger_append_only_row ON wallet_ledger_entries;`);
    this.addSql(`DROP FUNCTION IF EXISTS fn_ledger_append_only_guard();`);

    this.addSql(`DROP TRIGGER IF EXISTS trg_wager_tx_immutability ON wager_transactions;`);
    this.addSql(`DROP FUNCTION IF EXISTS fn_wager_transactions_immutability_guard();`);

    this.addSql(`DROP TRIGGER IF EXISTS trg_wallets_ledger_consistency ON wallets;`);
    this.addSql(`DROP FUNCTION IF EXISTS fn_wallets_ledger_consistency_guard();`);

    this.addSql(`DROP TRIGGER IF EXISTS trg_wallets_version_balance ON wallets;`);
    this.addSql(`DROP FUNCTION IF EXISTS fn_wallets_version_balance_guard();`);

    this.addSql(`DROP TABLE IF EXISTS outbox_messages;`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages;`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries;`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions;`);
    this.addSql(`DROP TABLE IF EXISTS wallets;`);
  }
}
