import assert from "node:assert/strict";
import { test } from "node:test";
import { scoreProjectKnowledge } from "../lib/project-knowledge";

const yolo = {
  title: "YOLO 安全帽检测数据集",
  question: "安全帽检测的数据集和标注类别有哪些？",
  claim: "样例资料包含安全帽、未佩戴安全帽两类标签，许可证还需核实。",
  sources: JSON.stringify([{ title: "数据集标注说明", snippet: "YOLO 安全帽检测数据集说明" }]),
};

test("项目共享资料按标题、问题和内容的关键词相关度排序", () => {
  const unrelated = { title: "校园活动预算", question: "预算安排", claim: "活动预算待确认。", sources: "[]" };
  assert.ok(scoreProjectKnowledge("YOLO 安全帽", yolo) > scoreProjectKnowledge("YOLO 安全帽", unrelated));
  assert.equal(scoreProjectKnowledge("完全无关的财务报表", yolo), 0);
  assert.ok(scoreProjectKnowledge("安全帽检测", yolo) > 0);
});
