# Database schema and migrations

The active schema uses MySQL 8.4. `migrations/` contains its initial schema,
including user sessions, projects, membership and the existing research tables.
Long text and serialized JSON keep their string representation. Their expression
defaults are emitted as `DEFAULT ('[]')` or `DEFAULT ('{}')` for MySQL.

Run `npm run db:generate` and `npm run db:deploy` with a MySQL `DATABASE_URL`.
The latter creates tables in the selected database; it does not import an old
SQLite file or assign existing research packages to users.

`sqlite-migrations/` preserves the original SQLite migration history. These SQL
files must not be applied to MySQL. `scripts/check_migration.py` remains a check
for that historical SQLite RAG migration, using a copy of an existing SQLite
database.

No SQLite database is included in this repository. If one is supplied later,
back it up before importing. Preserve research, source, chunk and citation IDs;
retain anonymous research with a null `projectId` until an owner explicitly
claims it. Public APIs must reject access to such unassigned research.

Web source keys now hash the normalized URL, so long addresses fit the complete
unique index and case-sensitive URL paths remain distinct under MySQL collation.
When importing historical sources, normalize their keys with `sourceKeyForUrl`
while retaining source IDs and their existing revisions and citations. Do not
delete historical sources to resolve a conflicting key.
