import "server-only";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { appendEvent } from "../events";
import { cleanContent } from "./cleaning";
import type { Metadata, SourceType } from "./types";

export type SourceInput = { sourceType: SourceType; sourceKey: string; title: string; content: string; url?: string | null; fetchedAt?: Date; metadata?: Metadata };
export async function saveSource(tx: Prisma.TransactionClient, packageId: string, input: SourceInput) {
  const content = cleanContent(input.content);
  if (!content) return null;
  const contentHash = createHash("sha256").update(content).digest("hex");
  const source = await tx.source.upsert({ where: { packageId_sourceKey: { packageId, sourceKey: input.sourceKey } },
    create: { packageId, sourceKey: input.sourceKey, sourceType: input.sourceType, title: input.title, url: input.url, metadata: JSON.stringify(input.metadata ?? {}) },
    update: { title: input.title, url: input.url, metadata: JSON.stringify(input.metadata ?? {}) } });
  let revision = await tx.sourceRevision.findUnique({ where: { sourceId_contentHash: { sourceId: source.id, contentHash } } });
  if (!revision) {
    const latest = await tx.sourceRevision.aggregate({ where: { packageId, sourceId: source.id }, _max: { revision: true } });
    revision = await tx.sourceRevision.create({ data: { packageId, sourceId: source.id, rawContent: content, contentHash,
      revision: (latest._max.revision ?? 0) + 1, fetchedAt: input.fetchedAt ?? new Date(),
      metadata: JSON.stringify({ ...input.metadata, title: input.title, url: input.url ?? null, sourceType: input.sourceType }) } });
    await appendEvent(tx, packageId, "source_added", `资料已收录：${input.title}`, { sourceId: source.id, revisionId: revision.id, sourceType: input.sourceType });
  }
  if (source.currentRevisionId !== revision.id) {
    await tx.source.update({ where: { id: source.id }, data: { currentRevisionId: revision.id } });
    await tx.researchPackage.update({ where: { id: packageId }, data: { contextVersion: { increment: 1 } } });
  }
  await tx.knowledgeJob.upsert({ where: { jobKey: `initial:${revision.id}` }, update: {}, create: { packageId, sourceRevisionId: revision.id, jobKey: `initial:${revision.id}` } });
  return { sourceId: source.id, revisionId: revision.id };
}
export function addSource(packageId: string, input: SourceInput) { return db.$transaction(tx => saveSource(tx, packageId, input)); }

export function sourceKeyForUrl(value: string) {
  const url = new URL(value); url.hash = "";
  for (const key of [...url.searchParams.keys()]) if (/^utm_|^(fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  return `web:${url.toString().replace(/\/$/, "")}`;
}
