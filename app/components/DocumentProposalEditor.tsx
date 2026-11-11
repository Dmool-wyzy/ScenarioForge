"use client";

import { useState } from "react";
import { DOCUMENT_TEMPLATES, documentSelectionSchema, type DocumentProposal, type DocumentSpec } from "@/lib/document-proposal";
import type { WorkspaceFile } from "@/lib/types";

type DraftDocument = { filename: string; purpose: string; outline: string };

export default function DocumentProposalEditor({ proposal, files, disabled, submitting, stale = false, onConfirm, onCancel, onPreview }: {
  proposal: DocumentProposal; files: WorkspaceFile[]; disabled: boolean; submitting: boolean; stale?: boolean;
  onConfirm: (documents: DocumentSpec[]) => Promise<void>; onCancel: () => void; onPreview: () => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<DraftDocument[]>(() => proposal.documents.map(document => ({
    filename: document.filename, purpose: document.purpose, outline: document.contentOutline.join("\n"),
  })));
  const [templateName, setTemplateName] = useState("");
  const documents = drafts.map(document => ({ filename: document.filename.trim(), purpose: document.purpose.trim(),
    contentOutline: document.outline.split(/\r?\n/).map(line => line.trim()).filter(Boolean) }));
  const validation = documentSelectionSchema.safeParse(documents);
  const usedNames = new Set(documents.map(document => document.filename.toLowerCase()));
  const templates = DOCUMENT_TEMPLATES.filter(document => !usedNames.has(document.filename.toLowerCase()));
  const selectedTemplate = templates.find(document => document.filename === templateName) ?? templates[0];
  const protectedFile = files.find(file => file.updatedBy === "user" && usedNames.has(file.filename.toLowerCase()));
  const error = protectedFile ? `${protectedFile.filename} 已由你编辑。请从清单移除或使用新文件名，保留原文。` : !validation.success
    ? validation.error.issues[0]?.code === "custom" || validation.error.issues[0]?.code === "invalid_format"
      ? validation.error.issues[0].message
      : "请保留 1–20 份文档，填写文件名、用途和 1–12 条内容要点；每条要点最多 500 字，用途最多 1000 字。"
    : null;
  const edit = (index: number, patch: Partial<DraftDocument>) => setDrafts(current => current.map((document, position) => position === index ? { ...document, ...patch } : document));
  return <section aria-label="确认文档清单" className="mx-4 mb-5 min-w-0 rounded-lg border border-[#bfcfc3] bg-[#f7f9f4] p-4 sm:mx-6">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <h3 className="text-sm font-semibold">确认文档清单</h3><span className="muted text-xs">{drafts.length} / 20 份</span>
    </div>
    <p className="muted mt-2 text-xs leading-6">清单确认后才会生成正文；尚未创建文件。你可以增加、移除或修改每份文档，未选择的已有文档会保留。</p>
    {stale && <div role="alert" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs leading-6 text-amber-900">
      <p>资料或文档已更新，请重新预览清单；当前编辑内容已保留。</p>
      <button type="button" className="mt-1 underline" disabled={disabled} onClick={() => void onPreview()}>重新预览清单</button>
    </div>}
    <details className="mt-2 text-xs"><summary className="cursor-pointer text-[#527060]">本次需求</summary><p className="mt-2 whitespace-pre-wrap break-words leading-6">{proposal.request}</p></details>
    <form className="mt-4 space-y-3" onSubmit={async event => {
      event.preventDefault();
      if (disabled || stale || error || !validation.success) return;
      await onConfirm(validation.data);
    }}>
      {drafts.map((document, index) => <fieldset key={index} aria-label={`文档 ${index + 1}`} disabled={disabled} className="min-w-0 space-y-3 rounded-lg border border-[#dce1d9] bg-white p-3">
        <legend className="px-1 text-xs font-medium text-[#527060]">文档 {index + 1}</legend>
        <div className="flex min-w-0 flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 text-xs">文件名<input aria-label={`文档 ${index + 1} 文件名`} value={document.filename} onChange={event => edit(index, { filename: event.target.value })} maxLength={83} placeholder="例如：ARCHITECTURE.md" autoComplete="off" className="!min-w-0 font-mono" /></label>
          <button type="button" className="secondary text-xs" aria-label={`移除文档 ${index + 1}`} onClick={() => setDrafts(current => current.filter((_, position) => position !== index))}>移除</button>
        </div>
        <label className="block text-xs">用途<input aria-label={`文档 ${index + 1} 用途`} value={document.purpose} onChange={event => edit(index, { purpose: event.target.value })} maxLength={1000} placeholder="这份文档帮助 Agent 完成什么？" /></label>
        <label className="block text-xs">内容要点<span className="muted ml-2 font-normal">每行一条</span><textarea aria-label={`文档 ${index + 1} 内容要点`} value={document.outline} onChange={event => edit(index, { outline: event.target.value })} rows={3} maxLength={6011} placeholder="写清希望这份文档包含的内容" /></label>
      </fieldset>)}
      <fieldset disabled={disabled || drafts.length >= 20} className="min-w-0 space-y-2">
        <div className="flex min-w-0 flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 text-xs">常用文档<select aria-label="添加文档模板" value={selectedTemplate?.filename ?? ""} onChange={event => setTemplateName(event.target.value)} disabled={disabled || drafts.length >= 20 || !templates.length} className="!min-w-0">
            {templates.length ? templates.map(document => <option key={document.filename} value={document.filename}>{document.filename} · {document.purpose}</option>) : <option value="">已添加全部常用文档</option>}
          </select></label>
          <button type="button" className="secondary text-xs" disabled={disabled || drafts.length >= 20 || !selectedTemplate} onClick={() => {
            if (selectedTemplate) setDrafts(current => [...current, { filename: selectedTemplate.filename, purpose: selectedTemplate.purpose, outline: selectedTemplate.contentOutline.join("\n") }]);
          }}>添加模板</button>
        </div>
        <button type="button" className="secondary text-xs" onClick={() => setDrafts(current => [...current, { filename: "", purpose: "", outline: "" }])}>添加自定义文档</button>
      </fieldset>
      <p className="muted text-xs leading-6">文件名使用英文字母开头，以 .md 结尾，可包含数字、下划线和连字符；不含目录路径，且不能重名。</p>
      {error && <p role="alert" className="break-words text-xs leading-6 text-red-700">{error}</p>}
      <div className="flex flex-wrap gap-3 border-t border-[#dce1d9] pt-3">
        <button type="submit" className="primary text-sm" disabled={disabled || stale || !!error}>{submitting ? "正在提交…" : `确认并生成 ${drafts.length} 份文档`}</button>
        <button type="button" className="secondary text-sm" disabled={disabled} onClick={onCancel}>暂不生成</button>
      </div>
      <p className="muted text-xs leading-6">确认后会调用模型生成所选文档，可能消耗 API 额度；这一步不修改项目代码或运行测试。</p>
    </form>
  </section>;
}
