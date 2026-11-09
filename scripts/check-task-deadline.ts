import assert from "node:assert/strict";
import { test } from "node:test";
import { extractTaskDeadline, taskDeadline } from "../lib/task-deadline";
const createdAt = new Date("2026-11-09T02:30:00.000Z");

test("absolute dates accept calendar dates, Chinese labels and explicit timezone offsets", () => {
  assert.equal(extractTaskDeadline("截止：2026-11-20", createdAt)?.dueAt, "2026-11-20T15:59:59.999Z");
  assert.equal(extractTaskDeadline("截止：2026-11-20", createdAt)?.precision, "date");
  assert.equal(extractTaskDeadline("完成需求文档，截止时间：2026年11月20日 18:30。", createdAt)?.dueAt, "2026-11-20T10:30:00.000Z");
  assert.equal(extractTaskDeadline("截至日期：11月20日", createdAt)?.dueAt, "2026-11-20T15:59:59.999Z");
  assert.equal(extractTaskDeadline("截止：2026-11-20T18:00:00+09:00", createdAt)?.dueAt, "2026-11-20T09:00:00.000Z");
  assert.equal(extractTaskDeadline("截止：2026-11-20T18:00:00Z", createdAt)?.dueAt, "2026-11-20T18:00:00.000Z");
  assert.equal(extractTaskDeadline("请在2026-11-20 18:00前提交交付。", createdAt)?.dueAt, "2026-11-20T10:00:00.000Z");
});
test("relative deadlines are anchored to creation and handle Chinese durations", () => {
  assert.equal(extractTaskDeadline("两周内完成", createdAt)?.dueAt, "2026-11-23T02:30:00.000Z");
  assert.equal(extractTaskDeadline("请在7天内完成测试。", createdAt)?.dueAt, "2026-11-16T02:30:00.000Z");
  assert.equal(extractTaskDeadline("三十天内完成", createdAt)?.dueAt, "2026-12-09T02:30:00.000Z");
  assert.equal(extractTaskDeadline("明天下午6点前提交", createdAt)?.dueAt, "2026-11-10T10:00:00.000Z");
  assert.equal(extractTaskDeadline("截止：下周五 18:00", createdAt)?.dueAt, "2026-11-20T10:00:00.000Z");
  assert.equal(extractTaskDeadline("截止：本周日", createdAt)?.dueAt, "2026-11-15T15:59:59.999Z");
  assert.equal(extractTaskDeadline("截止：明天", new Date("2026-12-31T12:00:00Z"))?.dueAt, "2027-01-01T15:59:59.999Z");
});
test("ordinary references, hypotheticals, contradictory dates and incomplete dates stay manual", () => {
  for (const text of ["会议在2026-11-20举行", "例如截止时间为2026-11-20", "不需要截止时间：2026-11-20", "截止：2026-11-20 或 2026-11-22", "截止：2026-11-20；截止：2026-11-22", "截止：下周", "整理截至2026年11月20日的统计数据", "开发日期选择器，示例：11月20日前提交"])
    assert.equal(extractTaskDeadline(text, createdAt), null, text);
  assert.equal(extractTaskDeadline("尽快", createdAt), null);
  assert.equal(extractTaskDeadline("两周左右", createdAt), null);
});
test("invalid calendar days and times are never normalized into a different deadline", () => {
  for (const value of ["2026-02-30", "2026-13-01", "2026-11-20 25:30", "2026-11-20 18:65", "2026-11-20 18:3", "2026-11-20 18:00+15:00", "2026-11-20 EST", "2026-11-20至2026-11-22"])
    assert.equal(extractTaskDeadline(`截止：${value}`, createdAt), null, value);
  assert.equal(extractTaskDeadline("截止：2024-02-29", createdAt)?.dueAt, "2024-02-29T15:59:59.999Z");
});
test("only the task description supplies a deadline, ignoring context and parent research", () => {
  const research = { createdAt, goal: "截止：2026-12-01", constraints: JSON.stringify({ deadline: "2026-11-30" }) };
  const task = { createdAt, objective: "截止：2026-11-20", context: "截止：2026-11-25", package: research };
  assert.equal(taskDeadline(task)?.dueAt, "2026-11-20T15:59:59.999Z");
  assert.equal(taskDeadline(task)?.source, "task");
  assert.equal(taskDeadline({ ...task, objective: "执行测试" }), null);
  const undated = { ...task, objective: "执行测试", context: "仅用虚构数据" };
  assert.equal(taskDeadline(undated), null);
  assert.equal(taskDeadline({ ...task, objective: "截止：2026-11-20；截止：2026-11-22" }), null);
});
test("relative task descriptions use task creation and never inherit parent durations", () => {
  const task = { createdAt: new Date("2026-11-20T00:00:00Z"), objective: "执行测试", context: "fixture", package: { createdAt, goal: "开发系统", constraints: JSON.stringify({deadline:"两周内"}) } };
  assert.equal(taskDeadline(task), null);
  const dated = taskDeadline({ ...task, objective: "两周内完成测试" });
  assert.equal(dated?.dueAt, "2026-12-04T00:00:00.000Z");
  assert.equal(dated?.relative, true);
});
