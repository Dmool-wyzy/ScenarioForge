"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import type { WorkspaceFile } from "@/lib/types";
import { apiRequest } from "@/hooks/useResearch";

const MDEditor = dynamic(() => import("@uiw/react-md-editor"), { ssr: false, loading: () => <p className="muted py-8 text-sm">正在加载编辑器…</p> });

export default function MarkdownEditor({ file, packageId, onSaved, onEditingChange }: { file: WorkspaceFile; packageId: string; onSaved: () => Promise<void>; onEditingChange: (editing: boolean) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [baseContent, setBaseContent] = useState("");
  const [baseVersion, setBaseVersion] = useState(0);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const token = useRef<string | null>(null);
  const endpoint = `/api/research/${packageId}/files/${encodeURIComponent(file.filename)}`;
  const draftKey = `scenarioforge:draft:${packageId}:${file.filename}`;
  const tokenKey = `${draftKey}:token`;

  useEffect(() => {
    if (!editing) return;
    const renew = setInterval(() => {
      void apiRequest(endpoint, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "renew", lockToken: token.current }) }).catch((e) => setError(e instanceof Error ? e.message : "编辑锁续期失败，请保留草稿。"));
    }, 30_000);
    const heldToken = token.current;
    return () => {
      clearInterval(renew);
      void fetch(endpoint, { method: "PATCH", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "unlock", lockToken: heldToken }) }).catch(() => {});
    };
  }, [editing, endpoint]);

  const dirty = editing && draft !== baseContent;
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const begin = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      const savedToken = sessionStorage.getItem(tokenKey) ?? crypto.randomUUID();
      token.current = savedToken; sessionStorage.setItem(tokenKey, savedToken);
      const result = await apiRequest<{ file: { content: string; version: number } }>(endpoint, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "lock", baseVersion: file.version, lockToken: savedToken }) });
      const recovered = sessionStorage.getItem(draftKey);
      setDraft(recovered ?? result.file.content); setBaseContent(result.file.content); setBaseVersion(result.file.version);
      if (recovered !== null) setNotice("已恢复当前窗口的未保存草稿，请确认内容后再保存。");
      setEditing(true); onEditingChange(true);
    } catch (e) { setError(e instanceof Error ? e.message : "无法进入编辑。"); }
    finally { setBusy(false); }
  };

  const save = async () => {
    setBusy(true); setError("");
    try {
      await apiRequest(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baseVersion, content: draft, changeNote: note || "用户更新文档", lockToken: token.current }) });
      sessionStorage.removeItem(draftKey); sessionStorage.removeItem(tokenKey);
      await onSaved(); setEditing(false); onEditingChange(false); setNotice("已保存，并通知 Agent 重新读取最新内容。");
    } catch (e) { setError(e instanceof Error ? e.message : "保存失败，草稿仍保留在编辑器中。"); }
    finally { setBusy(false); }
  };

  const cancel = async () => {
    setBusy(true); setError("");
    try {
      await apiRequest(endpoint, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "unlock", lockToken: token.current }) });
      sessionStorage.removeItem(draftKey); sessionStorage.removeItem(tokenKey);
      setEditing(false); onEditingChange(false); await onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : "无法取消编辑，请稍后重试。"); }
    finally { setBusy(false); }
  };

  return <section className="mb-5">{editing ? <div className="space-y-3" data-color-mode="light"><p className="muted text-xs">编辑期间 Agent 会等待此文件解锁。你的修改会受到保护。</p><MDEditor value={draft} onChange={(value) => { const text = (value ?? "").slice(0, 100000); setDraft(text); try { sessionStorage.setItem(draftKey, text); } catch { setNotice("浏览器草稿空间不足，请及时保存。"); } }} height={480} preview="edit" extraCommands={[]} previewOptions={{ skipHtml: true }} textareaProps={{ "aria-label": "Markdown 文件内容", maxLength: 100000 }} /><label>修改说明<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="例如：调整阶段二顺序" /></label><div className="flex flex-wrap gap-2"><button className="primary text-sm" disabled={busy || !draft.trim()} onClick={save}>{busy ? "处理中…" : "保存并通知 Agent"}</button><button className="secondary" disabled={busy} onClick={cancel}>取消编辑</button></div></div> : <button className="secondary" disabled={busy} onClick={begin}>{busy ? "正在进入编辑…" : "编辑 Markdown"}</button>}{error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}{notice && <p role="status" className="mt-3 text-xs text-[#527060]">{notice}</p>}</section>;
}
