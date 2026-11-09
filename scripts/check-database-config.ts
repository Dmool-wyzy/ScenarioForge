import assert from "node:assert/strict";
import { test } from "node:test";
import { getDatabaseConfig } from "../lib/env";
import { sourceKeyForUrl } from "../lib/rag/sources";

test("database config accepts MySQL addresses and rejects missing database names and other schemes", () => {
  const original = process.env.DATABASE_URL;
  try {
    process.env.DATABASE_URL = "mysql://fixture:fixture@127.0.0.1:3307/fixture";
    assert.equal(getDatabaseConfig().DATABASE_URL, process.env.DATABASE_URL);
    for (const invalid of ["", "invalid", "file:dev.db", "https://example.com/database", "mysql://localhost", "mysql://localhost/"]) {
      process.env.DATABASE_URL = invalid;
      assert.throws(getDatabaseConfig, /DATABASE_URL/);
    }
  } finally {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  }
});

test("source keys normalize tracking parameters without conflating case-sensitive paths or long URLs", () => {
  assert.equal(sourceKeyForUrl("https://example.com/document?b=2&utm_source=fixture&a=1#section"), sourceKeyForUrl("https://example.com/document?a=1&b=2"));
  assert.notEqual(sourceKeyForUrl("https://example.com/Document"), sourceKeyForUrl("https://example.com/document"));
  const prefix = "https://example.com/document?content=" + "x".repeat(1000);
  const first = sourceKeyForUrl(prefix + "a");
  assert.match(first, /^web:[a-f0-9]{64}$/);
  assert.notEqual(first, sourceKeyForUrl(prefix + "b"));
  assert.equal(first, sourceKeyForUrl(prefix + "a&utm_source=fixture#section"));
});
