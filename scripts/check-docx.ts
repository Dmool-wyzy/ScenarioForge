import assert from "node:assert/strict";
import { test } from "node:test";
import type { Readable } from "node:stream";
import JSZip from "jszip";
import { ApiError } from "../lib/errors";
import { validateDocxArchive } from "../lib/docx";

test("DOCX checks actual streamed bytes, stops a compressed bomb, and accepts a normal archive", async () => {
  const load = JSZip.loadAsync;
  const observed: { name: string; bytes: number; destroyed: boolean }[] = [];
  JSZip.loadAsync = async (...args: Parameters<typeof load>) => {
    assert.equal(args[1]?.checkCRC32, false, "Metadata loading must not decompress the archive for CRC checks.");
    const archive = await load(...args);
    for (const entry of Object.values(archive.files)) {
      const open = entry.nodeStream.bind(entry);
      entry.nodeStream = (...options: Parameters<typeof open>) => {
        const stream = open(...options) as Readable;
        const record = { name: entry.name, bytes: 0, destroyed: false };
        observed.push(record);
        const push = stream.push.bind(stream), destroy = stream.destroy.bind(stream);
        stream.push = (...chunks: Parameters<typeof stream.push>) => {
          if (Buffer.isBuffer(chunks[0])) record.bytes += chunks[0].length;
          return push(...chunks);
        };
        stream.destroy = (...errors: Parameters<typeof stream.destroy>) => { record.destroyed = true; return destroy(...errors); };
        return stream;
      };
    }
    return archive;
  };
  try {
    const normal = new JSZip();
    normal.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
    normal.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>正常文档</w:t></w:r></w:p></w:body></w:document>');
    await validateDocxArchive(await normal.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
    assert.equal(observed.length, 2);
    assert.ok(observed.every(stream => stream.bytes > 0 && stream.destroyed));
    observed.length = 0;

    const size = 48 * 1024 * 1024;
    const bomb = new JSZip();
    bomb.file("word/document.xml", "<document>" + "x".repeat(size) + "</document>");
    bomb.file("later.xml", "must not be opened");
    const compressed = await bomb.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    assert.ok(compressed.length < 5 * 1024 * 1024, "Fixture must fit the compressed upload limit.");
    await assert.rejects(validateDocxArchive(compressed), error => error instanceof ApiError && error.status === 400 && /20 MiB/.test(error.message));
    assert.equal(observed.length, 1, "The validator continued opening files after exceeding the budget.");
    assert.ok(observed[0].destroyed, "The oversized entry stream was not destroyed.");
    assert.ok(observed[0].bytes > 20 * 1024 * 1024 && observed[0].bytes < size, "The oversized XML was fully decompressed before rejection.");
    observed.length = 0;

    const split = new JSZip();
    split.file("first.xml", "a".repeat(12 * 1024 * 1024));
    split.file("second.xml", "b".repeat(12 * 1024 * 1024));
    await assert.rejects(validateDocxArchive(await split.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })), error => error instanceof ApiError && error.status === 400 && /20 MiB/.test(error.message));
    assert.equal(observed.length, 2, "The total budget must cover multiple entries together.");
    assert.ok(observed.every(stream => stream.destroyed));
    observed.length = 0;

    const crowded = new JSZip();
    for (let index = 0; index < 1001; index++) crowded.file(`entry-${index}.xml`, "");
    await assert.rejects(validateDocxArchive(await crowded.generateAsync({ type: "nodebuffer" })), error => error instanceof ApiError && error.status === 400);
    assert.equal(observed.length, 0, "Too many entries should be rejected before opening their streams.");
  } finally { JSZip.loadAsync = load; }
});
