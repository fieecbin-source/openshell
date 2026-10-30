use rusqlite::Connection;

pub(super) fn apply_sync_v2(conn: &Connection) -> Result<(), rusqlite::Error> {
    add_column_if_missing(
        conn,
        "record",
        "record_type",
        "ALTER TABLE record ADD COLUMN record_type TEXT NOT NULL DEFAULT 'legacy'",
    )?;
    add_column_if_missing(
        conn,
        "record",
        "schema_version",
        "ALTER TABLE record ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1",
    )?;
    add_column_if_missing(
        conn,
        "record",
        "key_version",
        "ALTER TABLE record ADD COLUMN key_version INTEGER NOT NULL DEFAULT 1",
    )?;
    add_column_if_missing(
        conn,
        "record",
        "revision",
        "ALTER TABLE record ADD COLUMN revision INTEGER NOT NULL DEFAULT 0",
    )?;
    add_column_if_missing(
        conn,
        "record",
        "client_updated_at",
        "ALTER TABLE record ADD COLUMN client_updated_at TEXT NOT NULL DEFAULT ''",
    )?;

    add_column_if_missing(
        conn,
        "record_history",
        "record_type",
        "ALTER TABLE record_history ADD COLUMN record_type TEXT NOT NULL DEFAULT 'legacy'",
    )?;
    add_column_if_missing(
        conn,
        "record_history",
        "schema_version",
        "ALTER TABLE record_history ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1",
    )?;
    add_column_if_missing(
        conn,
        "record_history",
        "key_version",
        "ALTER TABLE record_history ADD COLUMN key_version INTEGER NOT NULL DEFAULT 1",
    )?;
    add_column_if_missing(
        conn,
        "record_history",
        "revision",
        "ALTER TABLE record_history ADD COLUMN revision INTEGER NOT NULL DEFAULT 0",
    )?;
    add_column_if_missing(
        conn,
        "record_history",
        "client_updated_at",
        "ALTER TABLE record_history ADD COLUMN client_updated_at TEXT NOT NULL DEFAULT ''",
    )?;

    conn.execute(
        "UPDATE record SET revision = version WHERE revision = 0",
        [],
    )?;
    conn.execute(
        "UPDATE record SET client_updated_at = updated_at WHERE client_updated_at = ''",
        [],
    )?;
    conn.execute(
        "UPDATE record_history SET revision = version WHERE revision = 0",
        [],
    )?;
    conn.execute(
        "UPDATE record_history SET client_updated_at = updated_at WHERE client_updated_at = ''",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_record_vault_type ON record(vault_id, record_type)",
        [],
    )?;
    conn.execute_batch(
        "
        CREATE TRIGGER IF NOT EXISTS trg_record_v1_metadata_insert
        AFTER INSERT ON record
        WHEN NEW.revision = 0 OR NEW.client_updated_at = ''
        BEGIN
          UPDATE record
          SET revision = CASE WHEN NEW.revision = 0 THEN NEW.version ELSE NEW.revision END,
              client_updated_at = CASE WHEN NEW.client_updated_at = '' THEN NEW.updated_at ELSE NEW.client_updated_at END
          WHERE vault_id = NEW.vault_id AND record_id = NEW.record_id;
        END;

        CREATE TRIGGER IF NOT EXISTS trg_record_history_v1_metadata_insert
        AFTER INSERT ON record_history
        WHEN NEW.revision = 0 OR NEW.client_updated_at = ''
        BEGIN
          UPDATE record_history
          SET revision = CASE WHEN NEW.revision = 0 THEN NEW.version ELSE NEW.revision END,
              client_updated_at = CASE WHEN NEW.client_updated_at = '' THEN NEW.updated_at ELSE NEW.client_updated_at END
          WHERE vault_id = NEW.vault_id AND record_id = NEW.record_id AND version = NEW.version;
        END;


        CREATE TRIGGER IF NOT EXISTS trg_record_v1_metadata_update
        AFTER UPDATE OF version ON record
        WHEN NEW.revision != NEW.version
        BEGIN
          UPDATE record
          SET revision = NEW.version,
              client_updated_at = NEW.updated_at
          WHERE vault_id = NEW.vault_id AND record_id = NEW.record_id;
        END;
        ",
    )?;
    Ok(())
}

fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    migration: &str,
) -> Result<(), rusqlite::Error> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for existing in columns {
        if existing? == column {
            return Ok(());
        }
    }
    conn.execute(migration, [])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_preserves_legacy_records_and_backfills_revision() {
        let conn = Connection::open_in_memory().expect("open sqlite");
        conn.execute_batch(
            "
            CREATE TABLE record (
              vault_id TEXT NOT NULL,
              record_id TEXT NOT NULL,
              version INTEGER NOT NULL,
              ciphertext TEXT NOT NULL,
              checksum TEXT NOT NULL,
              size INTEGER NOT NULL,
              deleted INTEGER NOT NULL,
              deleted_at TEXT,
              updated_at TEXT NOT NULL,
              device_id TEXT NOT NULL,
              PRIMARY KEY(vault_id, record_id)
            );
            CREATE TABLE record_history (
              vault_id TEXT NOT NULL,
              record_id TEXT NOT NULL,
              version INTEGER NOT NULL,
              seq INTEGER NOT NULL,
              ciphertext TEXT NOT NULL,
              checksum TEXT NOT NULL,
              size INTEGER NOT NULL,
              deleted INTEGER NOT NULL,
              updated_at TEXT NOT NULL,
              device_id TEXT NOT NULL,
              valid_from_seq INTEGER NOT NULL,
              valid_to_seq INTEGER,
              PRIMARY KEY(vault_id, record_id, version)
            );
            INSERT INTO record VALUES ('vault', 'record', 3, 'cipher', 'sum', 6, 0, NULL, '2026-10-29T00:00:00Z', 'device');
            INSERT INTO record_history VALUES ('vault', 'record', 3, 9, 'cipher', 'sum', 6, 0, '2026-10-29T00:00:00Z', 'device', 9, NULL);
            ",
        )
        .expect("create legacy schema");

        apply_sync_v2(&conn).expect("migrate v2");
        apply_sync_v2(&conn).expect("migration is idempotent");

        let record: (String, u32, u64, u64, String) = conn
            .query_row(
                "SELECT record_type, schema_version, key_version, revision, client_updated_at FROM record WHERE record_id = 'record'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .expect("read migrated record");
        assert_eq!(record.0, "legacy");
        assert_eq!(record.1, 1);
        assert_eq!(record.2, 1);
        assert_eq!(record.3, 3);
        assert_eq!(record.4, "2026-10-29T00:00:00Z");
    }
}
