import type { FilePlanItem, WorkspaceFile } from "@/lib/types";

const priorityLabels = { required: "必须", recommended: "建议", optional: "补充" };

export default function FilePlan({ items, files }: { items: FilePlanItem[]; files: WorkspaceFile[] }) {
  return <section aria-label="文件计划" className="border-t border-[#e6e9e1] px-6 py-5">
    <h3 className="text-sm font-semibold">文件计划</h3>
    <p className="muted mt-2 text-xs leading-6">{items.length ? "按当前场景选择文档，每份文件聚焦一个职责。研究发现新主题时会先更新计划，再生成文件。" : "将先列出文件名称、用途、优先级和内容要点。默认包含 README.md、RESEARCH.md、SOURCES.md，其他文档按需规划。"}</p>
    {items.length > 0 && <div className="mt-4 max-h-80 space-y-4 overflow-y-auto">{items.map((item) => <article key={item.filename} className="rounded-lg border border-[#e6e9e1] p-3">
      <div className="flex flex-wrap items-center gap-2"><h4 className="break-all font-mono text-xs font-semibold">{item.filename}</h4><span className="rounded bg-[#ecf2e9] px-2 py-1 text-[11px]">{item.priority} · {priorityLabels[item.priority]}</span><span className="muted ml-auto text-xs">{files.some((file) => file.filename === item.filename) ? "已生成" : "待生成"}</span></div>
      <p className="mt-2 text-sm leading-6">{item.purpose}</p><ul className="muted mt-2 list-disc space-y-1 pl-5 text-xs leading-5">{item.contentOutline.map((point, index) => <li key={index}>{point}</li>)}</ul>
    </article>)}</div>}
  </section>;
}
