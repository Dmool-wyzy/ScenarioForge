type SafeFrame = { file: string; line: number; function?: string };
export type WorkspaceFailureDiagnostic = {
  errorTypes: string[];
  codes: string[];
  statuses: number[];
  frames: SafeFrame[];
};

function safeType(value: unknown) {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) ? value : "UnknownError";
}

function safeFrame(value: string): SafeFrame | null {
  const line = value.trim().replace(/^at\s+/, "");
  const wrapped = line.match(/^(.*?)\s+\((.*):(\d+):(\d+)\)$/);
  const plain = wrapped ? null : line.match(/^(.*):(\d+):(\d+)$/);
  const match = wrapped ?? plain;
  if (!match) return null;
  const location = wrapped ? match[2] : match[1];
  const lineNumber = Number(wrapped ? match[3] : match[2]);
  const file = location.split(/[\\/]/).at(-1)?.replace(/[^A-Za-z0-9_.@-]/g, "_").slice(0, 100);
  if (!file || !Number.isSafeInteger(lineNumber) || lineNumber < 1) return null;
  const fn = wrapped?.[1].replace(/^async\s+/, "").replace(/[^A-Za-z0-9_.$<>-]/g, "_").slice(0, 100);
  return { file, line: lineNumber, ...(fn ? { function: fn } : {}) };
}

export function workspaceFailureDiagnostic(error: unknown): WorkspaceFailureDiagnostic {
  const errorTypes: string[] = [], codes: string[] = [], statuses: number[] = [], frames: SafeFrame[] = [];
  const seen = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object" && !seen.has(current); depth++) {
    seen.add(current);
    const item = current as { name?: unknown; code?: unknown; status?: unknown; stack?: unknown; cause?: unknown; error?: unknown };
    const name = safeType(item.name);
    if (!errorTypes.includes(name)) errorTypes.push(name);
    if (typeof item.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(item.code) && !codes.includes(item.code)) codes.push(item.code);
    if (typeof item.status === "number" && Number.isInteger(item.status) && item.status >= 400 && item.status <= 599 && !statuses.includes(item.status)) statuses.push(item.status);
    if (!frames.length && typeof item.stack === "string") {
      for (const raw of item.stack.split("\n").slice(1)) {
        const frame = safeFrame(raw);
        if (frame) frames.push(frame);
        if (frames.length >= 6) break;
      }
    }
    current = item.cause instanceof Error ? item.cause : item.error instanceof Error ? item.error : undefined;
  }
  if (!errorTypes.length) errorTypes.push("NonErrorThrown");
  return { errorTypes, codes, statuses, frames };
}
