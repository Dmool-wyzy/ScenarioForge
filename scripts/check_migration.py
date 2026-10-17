"""Verify the additive RAG migration on a copy and back up the live database."""
import sqlite3
from datetime import datetime
from pathlib import Path

root = Path(__file__).resolve().parent.parent
live = root / "prisma" / "dev.db"
stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
backup_path = root / ".tmp" / f"before-rag-{stamp}.db"
copy_path = root / ".tmp" / "rag-migration-check.db"
tables = ("ResearchPackage", "Evidence", "WorkspaceFile", "Clarification", "ResearchEvent")
with sqlite3.connect(live) as original:
    counts = {table: original.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0] for table in tables}
    with sqlite3.connect(backup_path) as backup:
        original.backup(backup)
    with sqlite3.connect(copy_path) as copy:
        original.backup(copy)
with sqlite3.connect(copy_path) as copy:
    copy.executescript((root / "prisma/migrations/20261016060000_rag_foundation/migration.sql").read_text(encoding="utf-8"))
    for table, count in counts.items():
        assert copy.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0] == count, table
    assert not copy.execute("PRAGMA foreign_key_check").fetchall()
    assert copy.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
print("PASS: migration preserves existing records, foreign keys and database integrity")
print("Backup:", backup_path)
print("Existing record counts:", counts)
