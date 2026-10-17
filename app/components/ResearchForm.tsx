"use client";
import { useRef, useState } from "react";

const examples = ["我想做一个帮助东京留学生找合租室友的应用。预算低，团队 3 人，两周内完成课程演示。", "我想调研安全帽检测的常用数据集、模型和评估指标，为计算机视觉课程项目做准备。", "我想为东京的中国留学生组织一次中秋交流活动，预算有限，预计 30 人参加，需要活动流程和分工。"];

export default function ResearchForm({ onSubmit, loading, disabled }: { onSubmit: (form: FormData) => Promise<void>; loading: boolean; disabled: boolean }) {
  const [goal, setGoal] = useState(""); const [names, setNames] = useState<string[]>([]); const [error, setError] = useState(""); const inputRef = useRef<HTMLInputElement>(null);
  return <form className="space-y-5" onSubmit={async (event) => {
    event.preventDefault(); setError("");
    const data = new FormData(event.currentTarget); const files = inputRef.current?.files;
    if (files && (files.length > 5 || Array.from(files).some((f) => f.size > 5 * 1024 * 1024 || !/\.(md|txt|pdf|docx)$/i.test(f.name)))) { setError("请上传最多 5 个 .md、.txt、.pdf 或 .docx 文件，每个不超过 5 MB。"); return; }
    const constraints = { deadline: data.get("deadline"), teamSize: data.get("teamSize") ? Number(data.get("teamSize")) : undefined, budget: data.get("budget"), techPreference: data.get("techPreference") };
    const payload = new FormData(); payload.set("goal", goal); payload.set("constraints", JSON.stringify(constraints));
    for (const file of Array.from(files ?? [])) payload.append("files", file);
    await onSubmit(payload);
  }}>
    <label>你想完成什么？<textarea name="goal" value={goal} onChange={(e) => setGoal(e.target.value)} required minLength={5} maxLength={5000} rows={5} placeholder="描述你的项目、研究或活动目标……" disabled={loading} /></label>
    <div className="flex flex-wrap gap-2">{["软件项目", "研究项目", "活动策划"].map((label, i) => <button type="button" className="rounded-full border border-[#dce1d9] px-3 py-1 text-xs text-[#527060]" key={label} disabled={loading} onClick={() => setGoal(examples[i])}>{label}示例 ↗</button>)}</div>
    <details><summary className="cursor-pointer text-sm font-medium">约束条件 <span className="muted font-normal">（选填）</span></summary><div className="mt-4 grid grid-cols-2 gap-3"><label>截止时间<input name="deadline" maxLength={200} placeholder="例如：两周内" /></label><label>团队人数<input name="teamSize" type="number" min={1} max={1000} placeholder="例如：3" /></label><label>预算<input name="budget" maxLength={200} placeholder="例如：低预算" /></label><label>技术偏好<input name="techPreference" maxLength={500} placeholder="例如：Next.js" /></label></div></details>
    <div className="rounded-lg border border-dashed border-[#bfcfc3] bg-[#f7f9f4] p-4"><label className="cursor-pointer">参考资料 <span className="muted font-normal">（选填）</span><input ref={inputRef} type="file" name="files" multiple accept=".md,.txt,.pdf,.docx" onChange={(e) => setNames(Array.from(e.target.files ?? []).map((f) => f.name))} className="mt-3 text-xs" /></label><p className="muted mt-2 text-xs leading-6">MD / TXT / PDF / DOCX · 最多 5 个 · 每个 5 MB</p>{names.length > 0 && <p className="mt-2 break-all text-xs">{names.join("、")}</p>}</div>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <button className="primary w-full" disabled={loading || disabled}>{loading ? "正在创建研究…" : disabled ? "研究正在进行中" : "开始研究 →"}</button>
    <p className="muted text-center text-xs">先收集证据，再形成判断。</p>
  </form>;
}
