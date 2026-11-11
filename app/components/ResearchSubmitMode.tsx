"use client";

export type ResearchMode = "documents" | "chat";

export default function ResearchSubmitMode({ mode, onChange, disabled }: { mode: ResearchMode; onChange: (mode: ResearchMode) => void; disabled: boolean }) {
  return <fieldset disabled={disabled} className="space-y-2">
    <legend className="mb-2 text-xs font-medium text-[#527060]">本次操作</legend>
    <div className="flex flex-wrap gap-3">
      <label className="flex items-center gap-2 text-xs"><input type="radio" name="research-mode" value="documents" checked={mode === "documents"} onChange={() => onChange("documents")} className="!m-0 !w-auto" />生成方案</label>
      <label className="flex items-center gap-2 text-xs"><input type="radio" name="research-mode" value="chat" checked={mode === "chat"} onChange={() => onChange("chat")} className="!m-0 !w-auto" />仅讨论</label>
    </div>
    <p className="muted text-xs leading-5">{mode === "documents" ? "先预览并调整文档清单，确认后生成正文；保存后可交给执行 Agent。" : "用于聊天或明确要求联网调研；普通聊天回复不会自动保存为方案文档。"}</p>
  </fieldset>;
}
