import { Migration } from "@mikro-orm/migrations";

export class Migration00000000000000_SpikeHealthcheck extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE IF NOT EXISTS _spike_probe (
        id TEXT PRIMARY KEY,
        note TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS _spike_probe;`);
  }
}
