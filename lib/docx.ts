import "server-only";
import { Readable } from "node:stream";
import JSZip from "jszip";
import { ApiError } from "./errors";

export async function validateDocxArchive(buffer: Buffer) {
  const archive = await JSZip.loadAsync(buffer, { checkCRC32: false });
  const entries = Object.values(archive.files);
  if (entries.length > 1000) throw new ApiError(400, "DOCX 文件包含过多压缩条目。");
  let bytes = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    const source = entry.nodeStream("nodebuffer") as Readable;
    // JSZip uses a legacy Node stream without an async iterator.
    const stream = new Readable().wrap(source);
    try {
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes > 20 * 1024 * 1024) throw new ApiError(400, "DOCX 解压后总大小超过 20 MiB。");
      }
    } finally { stream.destroy(); source.destroy(); }
  }
}
