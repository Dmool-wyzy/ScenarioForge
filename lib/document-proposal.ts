import { z } from "zod";

const documentName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}\.md$/, "文件名须为根目录下的 Markdown 文件，使用英文字母、数字、下划线或连字符。")
  .refine(name => !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])\.md$/i.test(name), "文件名不可使用系统保留名称。");
export const documentSpecSchema = z.object({
  filename: documentName,
  purpose: z.string().trim().min(1).max(1000),
  contentOutline: z.array(z.string().trim().min(1).max(500)).min(1).max(12),
}).strict();
export const documentSelectionSchema = z.array(documentSpecSchema).min(1).max(20).superRefine((items, context) => {
  if (new Set(items.map(item => item.filename.toLowerCase())).size !== items.length) context.addIssue({ code: "custom", message: "文档清单不能包含重名文件（忽略大小写）。" });
  if (JSON.stringify(items).length > 32000) context.addIssue({ code: "custom", message: "文档清单超过 32000 字符，请缩小文档范围。" });
});
export type DocumentSpec = z.infer<typeof documentSpecSchema>;
export type DocumentDefinition = DocumentSpec;
export const documentProposalSchema = z.object({
  id: z.string().min(1).max(100), request: z.string().trim().min(1).max(5000), contextVersion: z.number().int().nonnegative(), documents: documentSelectionSchema,
});
export type DocumentProposal = z.infer<typeof documentProposalSchema>;

export const DOCUMENT_TEMPLATES: DocumentSpec[] = [
  { filename: "PLAN.md", purpose: "实现方案与边界", contentOutline: ["目标与交付物", "范围、约束与待确认假设", "实施步骤与验收方式"] },
  { filename: "TASKS.md", purpose: "任务清单与验收条件", contentOutline: ["可执行任务清单", "验收标准与建议验证命令", "人工审查事项"] },
  { filename: "ARCHITECTURE.md", purpose: "系统架构与模块职责", contentOutline: ["模块边界和职责", "数据流与依赖关系", "技术选择及待确认事项"] },
  { filename: "API_DESIGN.md", purpose: "接口契约与集成约定", contentOutline: ["接口与请求响应结构", "鉴权、校验和错误处理", "兼容与接口验收"] },
  { filename: "DATA_MODEL.md", purpose: "数据结构与存储设计", contentOutline: ["实体、字段与关联", "约束与迁移策略", "一致性和数据验证"] },
  { filename: "EXPERIMENT_PLAN.md", purpose: "研究实验与评估方案", contentOutline: ["研究问题、假设与已知证据", "实验步骤和变量", "指标、复现条件与局限"] },
  { filename: "RISKS.md", purpose: "风险、假设与处理措施", contentOutline: ["已识别风险与影响", "待验证假设", "缓解措施及人工确认事项"] },
  { filename: "TEST_PLAN.md", purpose: "测试策略与验收覆盖", contentOutline: ["关键场景和边界条件", "测试环境与数据", "通过标准及未覆盖事项"] },
  { filename: "TIMELINE.md", purpose: "阶段安排与里程碑", contentOutline: ["阶段目标和依赖", "明确的时间要求", "交付与检查点"] },
];

// This is a transparent local recommendation, not a model-generated research
// conclusion. The user can remove, rename or add every item before generation.
export function recommendDocuments(text: string): DocumentSpec[] {
  const names = new Set(["PLAN.md", "TASKS.md"]);
  const rules: [RegExp, string][] = [
    [/架构|模块划分|微服务|architecture|microservice/i, "ARCHITECTURE.md"],
    [/\bapi\b|接口设计|接口文档|后端接口|restful|graphql/i, "API_DESIGN.md"],
    [/数据库|数据模型|表结构|database|data model|schema/i, "DATA_MODEL.md"],
    [/实验|科研|研究型|对照|评估指标|experiment|benchmark/i, "EXPERIMENT_PLAN.md"],
    [/风险|安全设计|安全审计|risk|threat/i, "RISKS.md"],
    [/测试策略|测试计划|覆盖率|test plan|test strategy|coverage/i, "TEST_PLAN.md"],
    [/里程碑|排期|时间表|milestone|timeline/i, "TIMELINE.md"],
  ];
  for (const [pattern, name] of rules) if (pattern.test(text)) names.add(name);
  for (const template of DOCUMENT_TEMPLATES) if (text.toLowerCase().includes(template.filename.toLowerCase())) names.add(template.filename);
  return DOCUMENT_TEMPLATES.filter(item => names.has(item.filename)).map(item => ({ ...item, contentOutline: [...item.contentOutline] }));
}
