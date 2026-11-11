import type { RepositoryChange } from "../repository-workspace";
import type { Verification } from "./types";

export interface WorkspacePort {
  readonly branch: string;
  readonly local?: boolean;
  list(query?: string): Promise<{ head: string; files: { path: string; mode: string; size: number }[]; total: number }>;
  read(filename: string): Promise<{ path: string; head: string; content: string }>;
  readMany?(filenames: string[]): Promise<{ head: string; files: { path: string; content: string }[] }>;
  runCommand?(head: string, command: string[]): Promise<Verification>;
  write(head: string, changes: RepositoryChange[], reason: string): Promise<{ commit: string }>;
  diff(base: string): Promise<{ head: string; changedPaths: string[]; diff: string }>;
}
