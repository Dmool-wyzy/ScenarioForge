export type SkillFile = {
  id: string; packageId: string; packageTitle: string; filename: string;
  version: number; purpose: string; kind: "reference" | "workflow";
  hash: string; path: string; content: string;
};
export type SkillDescription = Omit<SkillFile, "content">;
export type Verification = {
  head: string; status: "passed" | "failed" | "unavailable";
  kind: "syntax" | "command"; command?: string[]; output: string;
};
export type LocalCommandApproval = {
  id: string; head: string; command: string[]; expiresAt: string;
};
export type ExecutionProgress = {
  operationId: string;
  phase: "started" | "completed" | "failed" | "waiting";
  action: string;
  paths?: string[];
  command?: string[];
  durationMs?: number;
  fileCount?: number;
  status?: "passed" | "failed" | "unavailable";
  skill?: { filename: string; version: number };
};
export type ExecutionView = {
  target?: "github" | "local"; runnerId?: string | null; workspaceDirectory?: string | null;
  id: string; createdBy: string; request: string; status: string; branch: string | null;
  head: string | null; summary: string | null; error: string | null; attempts: number;
  skills: SkillDescription[]; verification: Verification[]; createdAt: string;
  commandApprovals?: LocalCommandApproval[];
};
