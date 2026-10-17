import "server-only";
import type { Prisma } from "@prisma/client";
import { RagError } from "./config";

export function extractCitations(content: string) {
  const found: { evidenceId: string; section: string }[] = [];
  let fence: string | null = null, section = "";
  for (const line of content.split("\n")) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) { if (!fence) fence = marker[1]; else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null; continue; }
    if (fence) continue;
    if (/^#{1,6}\s/.test(line)) section = line.replace(/^#+\s*/, "").slice(0, 300);
    const text = line.replace(/(`+)[\s\S]*?\1/g, "");
    for (const match of text.matchAll(/\[(EVIDENCE-[1-9]\d*)\]/g)) if (!found.some(item => item.evidenceId === match[1] && item.section === section)) found.push({ evidenceId: match[1], section });
  }
  return found;
}
export async function validateAndSaveCitations(tx: Prisma.TransactionClient, packageId: string, documentName: string, version: number, content: string, allowedIds?: string[], strict = false) {
  const refs = extractCitations(content);
  if (strict && !refs.length && !content.includes("待确认：当前证据不足")) throw new RagError("citation_required", "文档必须引用已检索的证据，或明确标注“待确认：当前证据不足”。", 409);
  const warnings: string[] = [];
  for (const ref of refs) {
    const chunk = await tx.evidenceChunk.findUnique({ where: { packageId_evidenceNumber: { packageId, evidenceNumber: Number(ref.evidenceId.slice(9)) } } });
    if (!chunk || (allowedIds && !allowedIds.includes(ref.evidenceId))) {
      if (strict) throw new RagError("invalid_citation", `引用 ${ref.evidenceId} 不存在于当前项目或本次检索上下文中。`, 409);
      warnings.push(ref.evidenceId); continue;
    }
    await tx.citation.upsert({ where: { packageId_documentName_fileVersion_section_chunkId: { packageId, documentName, fileVersion: version, section: ref.section, chunkId: chunk.id } }, update: {},
      create: { packageId, documentName, fileVersion: version, section: ref.section, chunkId: chunk.id } });
  }
  return warnings;
}
