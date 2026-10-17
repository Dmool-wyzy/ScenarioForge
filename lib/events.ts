import "server-only";
import type { Prisma } from "@prisma/client";
import { db } from "./db";

export async function appendEvent(tx: Prisma.TransactionClient, packageId: string, type: string, message: string, payload?: unknown) {
  const pkg = await tx.researchPackage.update({ where: { id: packageId }, data: { eventSequence: { increment: 1 } }, select: { eventSequence: true } });
  return tx.researchEvent.create({ data: { packageId, sequence: pkg.eventSequence, type, message, payload: payload === undefined ? null : JSON.stringify(payload) } });
}

export function emitEvent(packageId: string, type: string, message: string, payload?: unknown) {
  return db.$transaction((tx) => appendEvent(tx, packageId, type, message, payload));
}
