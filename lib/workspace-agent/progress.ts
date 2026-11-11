import "server-only";
import { randomUUID } from "node:crypto";
import { agentFilePath } from "./workspace";
import type { ExecutionProgress } from "./types";

export type ReportExecutionProgress = (message: string, progress?: ExecutionProgress) => Promise<void>;
type ProgressDetail = Omit<ExecutionProgress, "operationId" | "phase" | "action" | "durationMs">;

export function progressPaths(paths: string[]) {
  return paths.filter(filename => {
    try { return agentFilePath(filename, true) === filename; } catch { return false; }
  }).slice(0, 300);
}

// The approval card contains the original argv. The timeline only repeats simple
// Node test/check commands, never inline source, credentials or absolute paths.
export function progressCommand(command: string[]) {
  if (command[0] !== "node" || command.length < 2 || command.length > 20) return undefined;
  const flags = new Set(["--test", "--check", "--experimental-strip-types"]);
  if (!command.slice(1).every(arg => flags.has(arg) || (/\.[cm]?[jt]sx?$/.test(arg) && progressPaths([arg]).length === 1))) return undefined;
  return [...command];
}

export function createProgressReporter(report: ReportExecutionProgress) {
  return async function recorded<T>(args: {
    action: string; message: string; detail?: ProgressDetail; waiting?: boolean;
    run: () => Promise<T>;
    completed: (result: T) => { message: string; detail?: ProgressDetail };
  }): Promise<T> {
    const operationId = randomUUID(), startedAt = performance.now();
    await report(args.message, { ...args.detail, operationId, action: args.action, phase: args.waiting ? "waiting" : "started" });
    let result: T;
    try { result = await args.run(); }
    catch (error) {
      // The outer execution error carries its existing safe diagnosis. Never
      // place arbitrary filesystem/SDK error messages or response bodies here.
      await report("本项操作未完成，请查看任务错误信息。", {
        ...args.detail, operationId, action: args.action, phase: "failed", durationMs: Math.round(performance.now() - startedAt),
      });
      throw error;
    }
    const completed = args.completed(result);
    await report(completed.message, {
      ...args.detail, ...completed.detail, operationId, action: args.action, phase: "completed", durationMs: Math.round(performance.now() - startedAt),
    });
    return result;
  };
}
