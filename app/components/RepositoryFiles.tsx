"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/hooks/useResearch";

type Entry = { path: string; mode: string; type: string; oid: string; size: number };
type Workspace = { branch: string; head: string; editable: boolean; prefix: string; ahead: number; behind: number; files: Entry[]; branches: { name: string; head: string; editable: boolean; merged: boolean }[] };
type FileView = Entry & { head: string; text: string | null; base64: string | null; reason: string | null };
type Change = { path: string; content?: string; encoding?: "utf8" | "base64"; delete?: boolean };
type Comparison = { branch: string; head: string; commit: string; merged: boolean; diff: string; truncated: boolean };
type History = { head: string; commits: { commit: string; author: string; date: string; subject: string }[]; more: boolean };
type Editor = { original: string | null; path: string; text: string; initial: string };
const limit = 1024 * 1024;
function sizeLabel(size: number) { return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KiB`; }
function readUpload(file: File): Promise<string> { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = () => reject(new Error("读取上传文件失败。")); reader.readAsDataURL(file); }); }

export default function RepositoryFiles({ projectId, isOwner, onChanged }: { projectId: string; isOwner: boolean; onChanged: () => Promise<void> }) {
  const endpoint = `/api/projects/${projectId}/repository`;
  const [data, setData] = useState<Workspace | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [directory, setDirectory] = useState(""), [search, setSearch] = useState(""), [tab, setTab] = useState<"files" | "history" | "branches">("files");
  const [file, setFile] = useState<FileView | null>(null), [editor, setEditor] = useState<Editor | null>(null), [changes, setChanges] = useState<Change[]>([]), [message, setMessage] = useState("");
  const [newBranch, setNewBranch] = useState(""), [uploadPath, setUploadPath] = useState("");
  const [comparison, setComparison] = useState<Comparison | null>(null), [history, setHistory] = useState<History | null>(null), [skip, setSkip] = useState(0), [detail, setDetail] = useState<string | null>(null);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const editorDirty = !!editor && (editor.original === null || editor.path !== editor.original || editor.text !== editor.initial);
  const draft = changes.length > 0 || editorDirty;
  const get = useCallback(<T,>(view: string, branch: string, extra: Record<string, string> = {}) => apiRequest<T>(`${endpoint}?${new URLSearchParams({ view, branch, ...extra })}`, { signal: AbortSignal.timeout(65000) }), [endpoint]);
  const load = useCallback(async (branch = "main") => {
    const result = await get<Workspace>("workspace", branch);
    setData(result); setComparison(null); setDeleteBranch(false); setFile(null); setEditor(null); setHistory(null); setDetail(null); setSkip(0);
    return result;
  }, [get]);
  useEffect(() => {
    let cancelled = false;
    void get<Workspace>("workspace", "main").then(result => { if (!cancelled) setData(result); }).catch(cause => { if (!cancelled) setError(cause.message); });
    return () => { cancelled = true; };
  }, [get]);
  useEffect(() => {
    if (!draft) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [draft]);
  const run = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { await operation(); } catch (cause) { setError(cause instanceof Error ? cause.message : "仓库操作失败，请刷新确认结果。"); }
    finally { setBusy(false); }
  };
  const post = <T,>(body: { action: string; [key: string]: unknown }) => apiRequest<T>(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(65000) });
  const switchBranch = async (branch: string) => { await load(branch); setDirectory(""); setSearch(""); };
  const queue = (incoming: Change[]) => {
    const next = [...changes.filter(item => !incoming.some(change => change.path === item.path)), ...incoming];
    const total = next.reduce((sum, item) => sum + (item.encoding === "base64" ? atob(item.content ?? "").length : new TextEncoder().encode(item.content ?? "").length), 0);
    if (next.length > 50 || total > 4 * limit) throw new Error("每次提交最多 50 个文件，总大小最多 4 MiB。");
    setChanges(next); setComparison(null);
  };
  const openFile = async (entry: Entry) => {
    if (!data) return;
    const result = await get<FileView>("file", data.branch, { path: entry.path });
    if (result.head !== data.head) throw new Error("分支已更新，请先处理草稿，再刷新文件列表。");
    setFile(result); setEditor(null);
  };
  const stageEditor = () => {
    if (!editor || !data) return;
    const filename = editor.path.trim();
    if (!filename || filename.startsWith("/") || filename.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git") || /[\\\u0000-\u001f:*?"<>|]/.test(filename)) throw new Error("请输入有效的相对文件路径。");
    if (new TextEncoder().encode(editor.text).length > limit) throw new Error("单个文件最多 1 MiB。");
    if (filename !== editor.original && data.files.some(entry => entry.path === filename)) throw new Error("目标路径已存在，请打开该文件进行编辑。");
    queue([...(editor.original && filename !== editor.original ? [{ path: editor.original, delete: true }] : []), { path: filename, content: editor.text, encoding: "utf8" }]);
    setEditor(null); setFile(null); setNotice("已加入待提交列表，填写提交说明后保存到当前分支。");
  };
  const upload = async (files: FileList | null) => {
    if (!files?.length || !data) return;
    const input = Array.from(files);
    if (input.length > 50 || input.reduce((sum, item) => sum + item.size, 0) > 4 * limit || input.some(item => item.size > limit)) throw new Error("单个文件最多 1 MiB，每次最多 50 个文件、合计 4 MiB。");
    const prefix = uploadPath.trim().replace(/\/$/, "");
    const staged: Change[] = [];
    for (const item of input) {
      const relative = item.webkitRelativePath || item.name;
      staged.push({ path: [prefix, relative].filter(Boolean).join("/"), content: await readUpload(item), encoding: "base64" });
    }
    if (new Set(staged.map(item => item.path)).size !== staged.length) throw new Error("上传列表含同名文件，请分别指定目录。");
    queue(staged); setNotice("文件已加入待提交列表。同名文件将被替换，请核对后再提交。");
  };
  const download = () => {
    if (!file || file.base64 === null) return;
    const blob = new Blob([Uint8Array.from(atob(file.base64), char => char.charCodeAt(0))], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob), anchor = document.createElement("a"); anchor.href = url; anchor.download = file.path.split("/").at(-1)!; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const showHistory = async (offset = 0) => { if (!data) return; setHistory(await get<History>("history", data.branch, { skip: String(offset) })); setSkip(offset); setDetail(null); setTab("history"); };
  const fileRows = data?.files.filter(entry => search ? entry.path.toLowerCase().includes(search.toLowerCase()) : entry.path.startsWith(directory)) ?? [];
  const folders = search ? [] : [...new Set(fileRows.map(entry => entry.path.slice(directory.length)).filter(value => value.includes("/")).map(value => value.split("/")[0]))].sort();
  const visible = search ? fileRows : fileRows.filter(entry => !entry.path.slice(directory.length).includes("/"));
  const locked = busy || !data;
  return <section className="mt-6 min-w-0 border-t border-[#e3e8db] pt-5" aria-label="仓库文件与版本" aria-busy={busy}>
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-semibold text-[#365540]">仓库文件与版本</h3><button type="button" className="secondary" disabled={busy || draft} onClick={() => void run(async () => { await load(data?.branch); await onChanged(); })}>刷新文件与分支</button></div>
    {error && <p role="alert" className="mt-3 rounded-lg bg-[#fff5ed] p-3 text-xs text-[#9d5944]">{error}</p>}
    {notice && <p role="status" className="mt-3 rounded-lg bg-[#f0f5e9] p-3 text-xs text-[#45633c]">{notice}</p>}
    {!data ? <p className="mt-3 text-xs text-[#65735d]">{error ? "点击刷新重试。" : "正在读取文件和分支…"}</p> : <>
      <div className="mt-4 grid gap-4 md:grid-cols-2"><label>浏览分支<select value={data.branch} disabled={locked || draft} onChange={event => void run(() => switchBranch(event.target.value))} className="w-full min-w-0">{data.branches.map(branch => <option key={branch.name} value={branch.name}>{branch.name}{branch.editable ? " · 可编辑" : ""}</option>)}</select></label><div className="self-end break-all text-xs leading-6 text-[#65735d]">{data.head.slice(0, 12)} · {data.files.length} 个文件<br />相对 main：领先 {data.ahead} / 落后 {data.behind} 个提交</div></div>
      <nav className="my-4 flex flex-wrap gap-2" aria-label="仓库视图">{([['files', '文件'], ['history', '提交历史'], ['branches', '分支与合并']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={tab === value} className={tab === value ? "primary" : "secondary"} disabled={busy} onClick={() => value === "history" ? void run(() => showHistory()) : setTab(value)}>{label}</button>)}</nav>
      {tab === "files" && <>
        {!data.editable && <p className="mb-3 text-xs leading-6 text-[#65735d]">当前分支只读。进入“分支与合并”，从当前版本创建自己的工作分支后即可上传和编辑。</p>}
        <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
          <div className="min-w-0 rounded-lg border border-[#dce4d5] p-3">
            <label className="text-xs">搜索文件<input value={search} placeholder="按路径搜索" onChange={event => setSearch(event.target.value)} /></label>
            <div className="my-3 flex flex-wrap items-center gap-2 text-xs"><button type="button" className="text-[#1f6657] underline" onClick={() => { setDirectory(""); setSearch(""); }}>根目录</button><span className="break-all">/ {directory}</span>{directory && !search && <button type="button" className="text-[#1f6657] underline" onClick={() => setDirectory(directory.split("/").slice(0, -2).join("/") + (directory.split("/").length > 2 ? "/" : ""))}>上一级</button>}</div>
            <ul className="max-h-80 overflow-auto text-xs">{folders.map(folder => <li key={folder}><button type="button" className="w-full break-all rounded px-2 py-2 text-left hover:bg-[#eff3e8]" onClick={() => setDirectory(directory + folder + "/")}>📁 {folder}/</button></li>)}{visible.slice(0, 300).map(entry => <li key={entry.path}><button type="button" disabled={busy || editorDirty} className={`flex w-full items-center justify-between gap-2 rounded px-2 py-2 text-left hover:bg-[#eff3e8] ${file?.path === entry.path ? "bg-[#eff3e8]" : ""}`} onClick={() => void run(() => openFile(entry))}><span className="min-w-0 break-all">{entry.mode === "160000" ? "↗ " : entry.mode === "120000" ? "↪ " : ""}{search ? entry.path : entry.path.slice(directory.length)}</span><span className="shrink-0 text-[10px] text-[#65735d]">{sizeLabel(entry.size)}</span></button></li>)}</ul>
            {!folders.length && !visible.length && <p className="py-4 text-xs text-[#65735d]">没有匹配的文件。</p>}{visible.length > 300 && <p className="mt-2 text-xs">仅显示前 300 项，请搜索缩小范围。</p>}
          </div>
          <div className="min-w-0 rounded-lg border border-[#dce4d5] p-3">
            {editor ? <><label className="text-xs">文件路径<input value={editor.path} disabled={busy} onChange={event => setEditor({ ...editor, path: event.target.value })} placeholder="例如 docs/说明.md" /></label><label className="mt-3 block text-xs">文件内容<textarea rows={12} value={editor.text} disabled={busy} spellCheck={false} className="font-mono text-xs" onChange={event => setEditor({ ...editor, text: event.target.value })} /></label><div className="mt-3 flex flex-wrap gap-2"><button type="button" className="primary" disabled={busy || !editorDirty} onClick={() => void run(async () => stageEditor())}>加入待提交</button><button type="button" className="secondary" disabled={busy} onClick={() => setEditor(null)}>放弃本次编辑</button></div></> : file ? <><p className="break-all text-xs font-semibold">{file.path}</p><p className="my-2 text-[10px] text-[#65735d]">{sizeLabel(file.size)} · {file.oid.slice(0, 12)}</p>{file.text !== null ? <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all bg-[#f4f6f0] p-3 font-mono text-xs">{file.text || "（空文件）"}</pre> : <p className="my-4 text-xs">{file.reason}</p>}<div className="mt-3 flex flex-wrap gap-2">{file.base64 !== null && <button type="button" className="secondary" onClick={download}>下载文件</button>}{data.editable && file.text !== null && <button type="button" className="secondary" disabled={busy || changes.some(change => change.path === file.path)} onClick={() => setEditor({ original: file.path, path: file.path, text: file.text!, initial: file.text! })}>编辑 / 重命名</button>}{data.editable && ["100644", "100755"].includes(file.mode) && <button type="button" className="secondary" disabled={busy} onClick={() => void run(async () => { queue([{ path: file.path, delete: true }]); setFile(null); })}>标记删除</button>}</div></> : <p className="py-8 text-center text-xs leading-6 text-[#65735d]">选择文件查看内容、下载或编辑。<br />支持 UTF-8 文本预览，二进制文件可下载。</p>}
          </div>
        </div>
        {data.editable && <div className="mt-4 rounded-lg border border-[#dce4d5] p-4"><div className="grid gap-4 md:grid-cols-2"><label className="text-xs">上传到目录（可选）<input placeholder="留空上传到根目录，例如 src/assets" value={uploadPath} onChange={event => setUploadPath(event.target.value)} disabled={busy} /></label><div className="flex flex-wrap items-end gap-2"><button type="button" className="secondary" disabled={busy || editorDirty} onClick={() => { setFile(null); setEditor({ original: null, path: directory, text: "", initial: "" }); }}>新建文本文件</button><label className={`secondary cursor-pointer ${busy ? "opacity-50" : ""}`}>上传文件<input aria-label="上传文件" type="file" multiple disabled={busy} className="sr-only" onChange={event => { const input = event.currentTarget; void run(async () => { await upload(input.files); input.value = ""; }); }} /></label><label className={`secondary cursor-pointer ${busy ? "opacity-50" : ""}`}>上传文件夹<input aria-label="上传文件夹" type="file" multiple {...{ webkitdirectory: "" }} disabled={busy} className="sr-only" onChange={event => { const input = event.currentTarget; void run(async () => { await upload(input.files); input.value = ""; }); }} /></label></div></div><p className="mt-3 text-[11px] leading-5 text-[#65735d]">单文件 ≤ 1 MiB，每次 ≤ 50 个文件、合计 ≤ 4 MiB；上传文件夹保留目录。同名文件在提交时替换。</p></div>}
      </>}
      {tab === "history" && <div className="rounded-lg border border-[#dce4d5] p-4"><ul className="divide-y divide-[#e3e8db]">{history?.commits.map(row => <li key={row.commit} className="py-3"><button type="button" disabled={busy} className="text-left text-sm text-[#365540] underline" onClick={() => void run(async () => { const result = await get<{ diff: string }>("commit", data.branch, { commit: row.commit }); setDetail(result.diff); })}>{row.subject}</button><p className="mt-1 break-all text-[11px] text-[#65735d]">{row.commit.slice(0, 12)} · {row.author} · {new Date(row.date).toLocaleString()}</p></li>)}</ul><div className="mt-3 flex gap-2"><button type="button" className="secondary" disabled={busy || skip === 0} onClick={() => void run(() => showHistory(Math.max(0, skip - 25)))}>上一页</button><button type="button" className="secondary" disabled={busy || !history?.more} onClick={() => void run(() => showHistory(skip + 25))}>下一页</button></div>{detail !== null && <pre className="mt-4 max-h-96 overflow-auto whitespace-pre-wrap break-all bg-[#f4f6f0] p-3 text-xs" aria-label="提交差异">{detail}</pre>}</div>}
      {tab === "branches" && <div className="rounded-lg border border-[#dce4d5] p-4"><form onSubmit={event => { event.preventDefault(); void run(async () => { const result = await post<{ branch: string }>({ action: "branch-create", name: newBranch.trim(), from: data.branch, head: data.head }); await switchBranch(result.branch); setNewBranch(""); setTab("files"); setNotice("已创建工作分支，可以上传或编辑文件。"); }); }}><label className="text-xs">新分支名称<input placeholder="例如 feature/login" value={newBranch} maxLength={80} onChange={event => setNewBranch(event.target.value)} disabled={busy || draft} /></label><p className="mt-2 break-all text-[11px] text-[#65735d]">基于当前 {data.branch} 创建；完整名称为 {data.prefix}{newBranch || "分支名"}。</p><button type="submit" className="primary mt-3" disabled={busy || draft || !newBranch.trim()}>创建我的分支</button></form>{data.branch !== "main" && <div className="mt-5 border-t border-[#e3e8db] pt-4"><div className="flex flex-wrap gap-2"><button type="button" className="secondary" disabled={busy || draft} onClick={() => void run(async () => { setComparison(await get<Comparison>("compare", data.branch)); })}>与 main 比较</button>{data.editable && <button type="button" className="secondary" disabled={busy || draft || !data.branches.find(branch => branch.name === data.branch)?.merged} onClick={() => setDeleteBranch(true)}>删除已合并分支</button>}</div>{deleteBranch && <div className="mt-3 text-xs"><p>确认删除 {data.branch}？已合并的提交仍保存在 main 的历史中。</p><button type="button" className="secondary mt-2" disabled={busy} onClick={() => void run(async () => { await post({ action: "branch-delete", branch: data.branch, head: data.head }); await switchBranch("main"); setNotice("已删除工作分支。"); })}>确认删除分支</button><button type="button" className="secondary ml-2" onClick={() => setDeleteBranch(false)}>取消</button></div>}</div>}{comparison && <section className="mt-4" aria-label="分支合并审查"><p className="text-xs">{comparison.branch} → main · {comparison.merged ? "已合并" : "待审查"}</p><pre className="my-3 max-h-96 overflow-auto whitespace-pre-wrap break-all bg-[#f4f6f0] p-3 text-xs">{comparison.diff || "没有文件差异。"}</pre>{isOwner && comparison.branch.startsWith("work/") && !comparison.merged && <button type="button" className="primary" disabled={busy || draft || comparison.truncated} onClick={() => void run(async () => { await post({ action: "branch-merge", branch: comparison.branch, head: comparison.head, commit: comparison.commit }); await load(data.branch); await onChanged(); setNotice("分支已合并到 main，可在上方确认推送到 GitHub。"); })}>确认将分支合并到 main</button>}{!isOwner && !comparison.merged && <p className="text-xs text-[#65735d]">提交后请项目创建者在此审查并合并。</p>}</section>}</div>}
      {(changes.length > 0 || editorDirty) && <section className="mt-4 rounded-lg border border-[#cddcc1] bg-[#f7f9f2] p-4" aria-label="待提交变更"><h4 className="text-sm font-semibold">待提交变更 · {changes.length} 项</h4><p className="mt-2 text-xs leading-6 text-[#65735d]">草稿暂存在当前页面；切换项目或关闭页面前请提交。只有点击提交后才会保存到 {data.branch}。</p>{editorDirty && <p className="mt-2 text-xs text-[#9d5944]">编辑器还有未加入列表的内容，请先加入待提交或放弃本次编辑。</p>}<ul className="mt-2 divide-y divide-[#e3e8db]">{changes.map(change => <li key={change.path} className="flex items-start justify-between gap-2 py-2 text-xs"><details className="min-w-0 flex-1"><summary className="cursor-pointer break-all">{change.delete ? "删除" : data.files.some(entry => entry.path === change.path) ? "修改 / 替换" : "新增"} · {change.path}</summary>{change.content !== undefined && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all">{change.encoding === "base64" ? `上传文件：约 ${sizeLabel(Math.ceil(change.content.length * 3 / 4))}` : change.content}</pre>}</details><button type="button" disabled={busy} className="shrink-0 text-[#9d5944] underline" onClick={() => setChanges(changes.filter(item => item.path !== change.path))}>撤回</button></li>)}</ul><label className="mt-3 block text-xs">提交说明<input value={message} onChange={event => setMessage(event.target.value)} maxLength={200} placeholder="例如：新增登录页面和测试文档" disabled={busy} /></label><button type="button" className="primary mt-3" disabled={busy || editorDirty || !changes.length || !message.trim()} onClick={() => void run(async () => { await post({ action: "files-commit", branch: data.branch, head: data.head, message: message.trim(), changes }); setChanges([]); setMessage(""); await load(data.branch); await onChanged(); setNotice("已保存 Git 提交。可在分支与合并中查看差异，由项目创建者合并。"); })}>{busy ? "正在处理…" : "提交到当前分支"}</button></section>}
    </>}
  </section>;
}
