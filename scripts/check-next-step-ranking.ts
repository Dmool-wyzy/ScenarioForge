import assert from "node:assert/strict";
import { test } from "node:test";
import { rankActions, urgency, type NextAction } from "../lib/next-step-ranking";
const now = Date.parse("2026-11-09T00:00:00Z");
const action = (id: string, values: Partial<NextAction> = {}): NextAction => ({ id, projectId: id, projectName: id, stars: 3, title: id, detail: "", href: "/", label: "打开", state: "ready", kind: "task", dueAt: null, waitingSince: "2026-11-08T00:00:00Z", blocksOthers: false, inProgress: false, ...values });
test("personal project stars outrank low-star urgent tasks", () => {
  const a = action("high", { stars: 5 }), b = action("low", { stars: 2, dueAt: "2026-11-08T00:00:00Z" });
  assert.deepEqual(rankActions([b,a],now).map(a=>a.id), ["high","low"]);
  assert.equal(urgency(b,now),0);
});
test("same stars use urgency buckets before blockers and exact deadlines", () => {
  const items = [action("ordinary"), action("blocker", { blocksOthers:true }), action("three-days", { dueAt:"2026-11-11T00:00:00Z" }), action("today", { dueAt:"2026-11-09T06:00:00Z" }), action("overdue", { dueAt:"2026-11-08T00:00:00Z" })];
  assert.deepEqual(rankActions(items,now).map(a=>a.id),["overdue","today","three-days","blocker","ordinary"]);
});
test("same urgency: explicit blockers, closer deadline, ongoing work, then stable waiting age", () => {
  const items = [action("old",{waitingSince:"2026-11-01T00:00:00Z"}),action("new"),action("ongoing",{inProgress:true}),action("dated",{dueAt:"2026-11-30T00:00:00Z"}),action("blocked",{blocksOthers:true})];
  assert.deepEqual(rankActions(items,now).map(a=>a.id),["blocked","dated","ongoing","old","new"]);
  assert.deepEqual(rankActions([action("b"),action("a")],now).map(a=>a.id),["a","b"]);
  assert.deepEqual(rankActions([action("repository:setup",{projectId:"b"}),action("repository:setup",{projectId:"a"})],now).map(a=>a.projectId),["a","b"]);
});
test("deadline boundaries and missing dates do not invent urgency", () => {
  assert.equal(urgency(action("a"),now),3);
  for(const [hours,level] of [[0,0],[24,1],[24.01,2],[72,2],[72.01,3]]) assert.equal(urgency(action("a",{dueAt:new Date(now+hours*3600000).toISOString()}),now),level);
});
