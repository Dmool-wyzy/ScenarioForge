import "server-only";
import JSZip from "jszip";
import { db } from "./db";
import { filenameSchema } from "./validation";
import { ApiError } from "./errors";

export async function exportWorkspace(packageId: string) {
  const files = await db.workspaceFile.findMany({ where: { packageId }, orderBy: { filename: "asc" } });
  if (!files.length) throw new ApiError(404, "工作区尚未生成文件。");
  const zip = new JSZip();
  for (const file of files) zip.file(filenameSchema.parse(file.filename), file.content);
  const chunks = await db.evidenceChunk.findMany({ where: { packageId }, orderBy: { evidenceNumber: "asc" }, include: { revision: { include: { source: true } }, citations: { where: { packageId } } } });
  if (chunks.length) {
    zip.file("evidence-index.json", JSON.stringify({ packageId, exportedAt: new Date().toISOString(), evidence: chunks.map(chunk => ({ evidenceId: `EVIDENCE-${chunk.evidenceNumber}`, content: chunk.content, chunkIndex: chunk.chunkIndex,
      source: { type: chunk.revision.source.sourceType, ...JSON.parse(chunk.revision.metadata), fetchedAt: chunk.revision.fetchedAt, revision: chunk.revision.revision, current: chunk.revision.source.currentRevisionId === chunk.revision.id },
      citations: chunk.citations.map(({ documentName, fileVersion, section }) => ({ documentName, fileVersion, section })) })) }, null, 2));
  }
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
