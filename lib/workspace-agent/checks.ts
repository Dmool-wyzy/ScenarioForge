import type { Verification } from "./types";

/** A recorded check is evidence only for the exact Git commit it examined. */
export function checksAtHead(serialized: string | null, head: string): Verification[] {
  return serialized ? (JSON.parse(serialized) as Verification[]).filter(check => check.head === head) : [];
}

export function recordCheck(serialized: string | null, head: string, check?: Verification): Verification[] {
  if (!check) return [];
  if (check.head !== head) throw new Error("验证结果不属于当前提交。");
  return [...checksAtHead(serialized, head).filter(item => item.kind !== check.kind || JSON.stringify(item.command) !== JSON.stringify(check.command)), check];
}
