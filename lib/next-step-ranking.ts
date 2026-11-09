// Shared deterministic ranking. Project importance is always the user's decision.
export type NextAction = {
  id: string; projectId: string; projectName: string; stars: number;
  title: string; detail: string; label: string; href: string;
  state: "ready" | "waiting"; kind: "task" | "clarification" | "research" | "delivery" | "repository";
  dueAt: string | null; waitingSince: string; blocksOthers: boolean; inProgress: boolean;
  deadlineSource?: "task" | "personal" | null;
  deadlinePrecision?: "date" | "time" | null;
  deadlineRelative?: boolean;
};
export type NextStepsSnapshot = { actions: NextAction[]; warnings: string[]; generatedAt: string };
export function urgency(action: Pick<NextAction, "dueAt">, now: number) {
  const due = action.dueAt ? Date.parse(action.dueAt) : NaN;
  if (!Number.isFinite(due)) return 3;
  const remaining = due - now;
  return remaining <= 0 ? 0 : remaining <= 86400000 ? 1 : remaining <= 3 * 86400000 ? 2 : 3;
}
export function compareActions(a: NextAction, b: NextAction, now: number) {
  const dueA = a.dueAt ? Date.parse(a.dueAt) : Infinity;
  const dueB = b.dueAt ? Date.parse(b.dueAt) : Infinity;
  return b.stars - a.stars || urgency(a, now) - urgency(b, now)
    || Number(b.blocksOthers) - Number(a.blocksOthers)
    || (dueA === dueB ? 0 : dueA - dueB)
    || Number(b.inProgress) - Number(a.inProgress)
    || Date.parse(a.waitingSince) - Date.parse(b.waitingSince)
    || a.id.localeCompare(b.id) || a.projectId.localeCompare(b.projectId);
}
export function rankActions(actions: NextAction[], now = Date.now()) {
  return [...actions].sort((a, b) => compareActions(a, b, now));
}
export function actionReason(action: NextAction, now = Date.now()) {
  const level = urgency(action, now);
  return `${action.stars} 星项目 · ${level === 0 ? "已超过截止时间" : level === 1 ? "将在 24 小时内截止" : level === 2 ? "将在 3 天内截止" : action.blocksOthers ? "处理后可解除当前流程阻塞" : action.inProgress ? "继续推进你已承担的事项" : "当前有需要你处理的事项"}`;
}
