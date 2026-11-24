-- D06 (R-d): separação de roles entre migrator (dono do schema) e app (runtime sem DDL).
-- Executado uma única vez na inicialização do volume do PostgreSQL.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dwp_migrator') THEN
    CREATE ROLE dwp_migrator LOGIN PASSWORD 'dwp_migrator_dev';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dwp_app') THEN
    CREATE ROLE dwp_app LOGIN PASSWORD 'dwp_app_dev';
  END IF;
END
$$;

ALTER DATABASE wagering OWNER TO dwp_migrator;
ALTER SCHEMA public OWNER TO dwp_migrator;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

GRANT CONNECT ON DATABASE wagering TO dwp_app;
GRANT USAGE ON SCHEMA public TO dwp_app;

-- Privilégios padrão para tabelas/sequências criadas por dwp_migrator.
-- Nota: TRUNCATE nunca é concedido a dwp_app; UPDATE/DELETE em wallet_ledger_entries
-- serão revogados explicitamente na migration da tabela de ledger (F2).
ALTER DEFAULT PRIVILEGES FOR ROLE dwp_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dwp_app;

ALTER DEFAULT PRIVILEGES FOR ROLE dwp_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO dwp_app;
