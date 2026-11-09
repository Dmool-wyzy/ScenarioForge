"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/hooks/useResearch";
import RepositoryFiles from "./RepositoryFiles";

type Repository = {
  enabled: boolean; head?: string; remoteUrl?: string | null; remoteBranch?: string; capabilities?: { import: boolean; workspace?: boolean };
  remote?: { configured: boolean; publicKey?: string; checkedAt: string | null; head: string | null; connection?: { url: string; branch: string; imported: boolean } };
  files?: string[];
  tasks?: { id: string; objective: string; assigneeName: string | null; mine: boolean; git: { commit: string; branch: string; merged: boolean } | null }[];
};
type Review = { taskId: string; head: string; commit: string; merged: boolean; diff: string };
type Props = { projectId: string; projectName: string; isOwner: boolean };

export default function ProjectRepository({ projectId, projectName, isOwner }: Props) {
  const endpoint = `/api/projects/${projectId}/repository`;
  const [data, setData] = useState<Repository | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [branch, setBranch] = useState<string | null>(null);
  const [pushReview, setPushReview] = useState<{ head: string; remoteHead: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback((signal?: AbortSignal) => {
    const timeout = AbortSignal.timeout(65000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    return apiRequest<Repository>(endpoint, { signal: requestSignal }).then(async result => {
      const target = window.location.hash.match(/^#delivery-([A-Za-z0-9_-]{1,100})$/)?.[1];
      if (target && result.enabled && !result.tasks?.some(task => task.id === target)) {
        const delivery = await apiRequest<NonNullable<Repository["tasks"]>[number]>(`${endpoint}?delivery=${encodeURIComponent(target)}`, { signal: requestSignal });
        result = { ...result, tasks: [delivery, ...(result.tasks ?? [])] };
      }
      if (!signal?.aborted) { setData(result); setLoadError(""); }
    }).catch(cause => {
      if (!signal?.aborted) setLoadError(cause instanceof Error ? cause.message : "仓库暂时无法读取，请重新读取。");
      throw cause;
    }).finally(() => { if (!signal?.aborted) setLoading(false); });
  }, [endpoint]);
  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal).catch(() => undefined);
    return () => abort.abort();
  }, [load]);
  const refresh = async () => {
    setLoading(true); setLoadError("");
    await load();
  };
  const act = async (body: { action: string; [key: string]: unknown }) => {
    if (busy || loading) return;
    setBusy(true); setError(""); setMessage(""); setPushReview(null);
    try {
      await apiRequest(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(body.action === "import" ? 185000 : 65000) });
      setReview(null);
      await refresh();
      window.dispatchEvent(new Event("scenarioforge:actions-changed"));
      if (body.action === "connect") setMessage("已连接本项目的仓库。接下来配置仓库授权。");
      if (body.action === "prepare") setMessage("部署公钥已生成。请在 GitHub 授权后，点击验证授权并导入。");
      if (body.action === "import") setMessage("仓库已导入。可以邀请组员并开始团队交付。");
      if (body.action === "initialize") setMessage("项目工作区已创建，可以邀请组员协作；稍后仍可连接 GitHub。");
      if (body.action === "pull") setMessage("已检查并快进拉取远程分支。请刷新下方文件与分支查看最新内容。");
      if (body.action === "push") setMessage("main 已推送到 GitHub。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "仓库操作失败。"); }
    finally { setBusy(false); }
  };
  const showDiff = async (id: string) => {
    setBusy(true); setError("");
    try { setReview(await apiRequest<Review>(`${endpoint}?task=${encodeURIComponent(id)}`)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "读取差异失败。"); }
    finally { setBusy(false); }
  };
  const unavailable = busy || loading || !!loadError;
  const synced = !!data?.head && !!data.remote?.checkedAt && data.remote.head === data.head;
  const connection = data?.remote?.connection;
  const targetBranch = data?.remoteBranch ?? "main";
  const status = loading ? "读取中" : loadError ? "暂不可用" : data?.remoteUrl ? synced ? "已同步到 GitHub" : "已关联远程地址" : data?.enabled ? "工作区已创建" : connection ? "等待授权导入" : "待连接";

  return <details id="project-repository" className="panel group/repository mb-5 overflow-hidden" data-testid="project-repository">
    <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 sm:px-6">
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1"><span className="text-sm font-semibold text-[#365540]">团队 Git 工作区</span><span className={`rounded-full px-2.5 py-1 text-[10px] ${loadError ? "bg-[#fff5ed] text-[#9d5944]" : "bg-[#eef2e7] text-[#617655]"}`}>{status}</span></span>
      <span className="shrink-0 text-xs text-[#65735d]"><span className="group-open/repository:hidden">展开</span><span className="hidden group-open/repository:inline">收起</span><span className="ml-2 inline-block transition-transform group-open/repository:rotate-180" aria-hidden="true">⌄</span></span>
    </summary>
    <div className="border-t border-[#e3e8db] px-5 pb-5 pt-4 sm:px-6 sm:pb-6" aria-busy={loading || busy}>
      <p className="mb-5 text-xs leading-6 text-[#65735d]">为「{projectName}」连接独立仓库，导入项目文件并审查团队交付。</p>
      {loadError && <div role="alert" className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#e8cfc3] bg-[#fff5ed] px-4 py-3 text-xs leading-6 text-[#9d5944]"><span>{loadError}</span><button type="button" className="secondary" disabled={loading} onClick={() => void refresh().catch(() => undefined)}>重新读取仓库</button></div>}
      {error && <p role="alert" className="mb-4 rounded-lg bg-[#fff5ed] px-4 py-3 text-xs text-[#9d5944]">{error}</p>}
      {message && <p role="status" className="mb-4 rounded-lg bg-[#f0f5e9] px-4 py-3 text-xs leading-6 text-[#45633c]">{message}</p>}
      <div>
        <section className="min-w-0" aria-label="连接项目仓库">

          {loading && !data ? <p role="status" className="text-xs leading-6 text-[#65735d]">正在读取当前项目的仓库…</p> : !data ? <p className="text-xs leading-6 text-[#65735d]">连接恢复后，可以查看或配置此项目的仓库。</p> : data.remoteUrl ? <div className="text-xs leading-6" aria-label="GitHub 同步">
            <div className="grid gap-x-6 gap-y-5 md:grid-cols-2"><label>GitHub 仓库地址<input readOnly value={data.remoteUrl} /></label><label>远程目标分支<input readOnly value={targetBranch} /></label></div><a className="mt-3 inline-block text-[#1f6657] underline underline-offset-4" href={data.remoteUrl} target="_blank" rel="noreferrer">在 GitHub 查看仓库 ↗</a>
            <p className="mt-3">{!data.remote?.checkedAt ? "尚未验证远程同步。创建部署密钥并在 GitHub 授权后检查连接。" : synced ? `上次检查：远程 ${targetBranch} 与工作区 main 一致。` : data.remote.head ? `工作区与远程 ${targetBranch} 不一致，请检查后再推送。` : `远程 ${targetBranch} 尚无提交，工作区内容尚未推送。`}</p>
            {data.remote?.checkedAt && <p className="text-[#65735d]">检查时间：{new Date(data.remote.checkedAt).toLocaleString()}</p>}
            {isOwner ? <>
              {!data.remote?.configured ? <button type="button" className="secondary mt-3" disabled={unavailable} onClick={() => void act({ action: "key" })}>创建本仓库部署密钥</button> : <>
                <details className="mt-3 rounded-lg bg-[#f5f7f0] p-3"><summary className="cursor-pointer font-medium">GitHub 仓库授权</summary><p className="my-3">在此仓库的 <a className="underline" target="_blank" rel="noreferrer" href={data.remoteUrl.replace(/\.git$/, "") + "/settings/keys/new"}>Deploy keys 设置</a>添加下面的公钥，需要推送时勾选 Allow write access；只读授权可用于导入和检查。每个项目使用独立密钥。</p><label htmlFor={`repo-key-${projectId}`}>仓库部署公钥<textarea id={`repo-key-${projectId}`} readOnly rows={3} value={data.remote.publicKey ?? ""} className="font-mono text-xs" /></label></details>
                <div className="mt-4 flex flex-wrap gap-2"><button type="button" className="secondary" disabled={unavailable} onClick={() => void act({ action: "check" })}>检查 GitHub 连接</button>{data.capabilities?.workspace && <button type="button" className="secondary" disabled={unavailable || !data.remote.head || !data.head || synced} onClick={() => void act({ action: "pull", head: data.head, remoteHead: data.remote!.head })}>快进拉取远程更新</button>}<button type="button" className="primary" disabled={unavailable || !data.remote.checkedAt || !data.head || synced} onClick={() => setPushReview({ head: data.head!, remoteHead: data.remote!.head })}>准备推送已审核 main</button></div>
              </>}
              {pushReview && <section className="mt-4 rounded-lg border border-[#d5e2cd] p-4" aria-label="确认 GitHub 推送"><p>将提交 {pushReview.head.slice(0, 12)} 及其历史推送到所关联 GitHub 仓库的 {targetBranch} 分支。包含导入的文件和已合并交付；仓库的公开或私有属性保持不变。</p><ul className="my-2 list-inside list-disc">{data.files?.map(file => <li key={file}>{file}</li>)}</ul><div className="flex flex-wrap gap-2"><button type="button" className="primary" disabled={unavailable} onClick={() => void act({ action: "push", ...pushReview })}>确认推送到 GitHub</button><button type="button" className="secondary" disabled={busy} onClick={() => setPushReview(null)}>取消</button></div></section>}
            </> : <p className="mt-3 text-[#65735d]">仓库连接和远程推送由项目创建者管理，你可以在下方提交自己的交付。</p>}
          </div> : isOwner ? <>
            <form onSubmit={event => { event.preventDefault(); void act(data.capabilities?.import ? { action: "prepare", url: remoteUrl.trim() || connection?.url, branch: (branch ?? connection?.branch ?? "").trim() } : { action: "connect", url: remoteUrl.trim() }); }}>
              <div className="grid gap-x-6 gap-y-5 md:grid-cols-2">
                <label>GitHub 仓库地址<input type="url" required maxLength={200} placeholder="https://github.com/owner/repository.git" value={connection?.url ?? remoteUrl} onChange={event => setRemoteUrl(event.target.value)} readOnly={!!connection} disabled={unavailable} autoComplete="off" spellCheck={false} /></label>
                <label>导入分支（可选）<input maxLength={200} placeholder="留空使用仓库默认分支" value={branch ?? connection?.branch ?? ""} onChange={event => setBranch(event.target.value)} disabled={unavailable || !data.capabilities?.import} autoComplete="off" spellCheck={false} /></label>
              </div>
              <p className="mt-4 text-xs leading-6 text-[#65735d]">支持公开、私有和已有内容的 GitHub 仓库。先生成本项目公钥，在仓库中授权，再导入所选分支及提交历史。</p>
              {!data.capabilities?.import && <p role="status" className="mt-3 text-xs leading-6 text-[#836b40]">服务器仓库服务尚待更新，完整导入功能暂未启用；当前可连接公开空仓库。</p>}
              {data.enabled && <p className="mt-3 text-xs leading-6 text-[#836b40]">此项目已创建工作区。若仍只有初始化 README，可直接导入，原工作区会自动备份；已有交付的工作区会保留。</p>}
              <div className="mt-5 flex flex-wrap items-center gap-3"><button type="submit" className="primary text-sm" disabled={unavailable || !(remoteUrl.trim() || connection?.url)}>{busy ? "正在处理…" : connection ? "保存导入分支" : data.capabilities?.import ? "生成部署公钥" : "关联公开空仓库"}</button><a href="https://github.com/new" target="_blank" rel="noreferrer" className="text-xs text-[#1f6657] underline underline-offset-4">去 GitHub 创建仓库 ↗</a></div>
            </form>
            {connection && data.remote?.publicKey && <section className="mt-5" aria-label="仓库导入授权">
              <label>仓库部署公钥<textarea readOnly rows={3} value={data.remote.publicKey} className="font-mono text-xs" /></label>
              <p className="mt-3 text-xs leading-6 text-[#65735d]">在此仓库的 <a href={connection.url.replace(/\.git$/, "") + "/settings/keys/new"} target="_blank" rel="noreferrer" className="text-[#1f6657] underline">Settings → Deploy keys</a> 中添加公钥。只读授权即可导入；后续需要推送，请勾选 Allow write access。</p>
              <p className="mt-2 text-xs leading-6 text-[#65735d]">导入分支：{connection.branch || "仓库默认分支"}。仓库文件将对本项目成员可见；子模块和 Git LFS 大文件保留引用，不自动下载。</p>
              <button type="button" className="primary mt-4" disabled={unavailable} onClick={() => void act({ action: "import" })}>{busy ? "正在处理…" : "验证授权并导入"}</button>
            </section>}
            {!data.enabled && !connection && <div className="mt-5"><button type="button" className="secondary" disabled={unavailable} onClick={() => void act({ action: "initialize" })}>先创建项目工作区</button><p className="mt-2 text-[11px] leading-5 text-[#65735d]">用于从零开始的文档协作；要导入已有仓库，请先完成上方导入流程。</p></div>}
          </> : <p className="text-xs leading-6 text-[#65735d]">等待项目创建者连接仓库或创建工作区。你可以先开展研究并提交任务。</p>}
        </section>

      </div>
      {data?.enabled && data.capabilities?.workspace && <RepositoryFiles key={projectId} projectId={projectId} isOwner={isOwner} onChanged={refresh} />}
      {data?.enabled && <section className="mt-6 border-t border-[#e3e8db] pt-5" aria-label="团队交付">
        <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-3"><h3 className="text-sm font-semibold text-[#365540]">团队交付与审查</h3></div><button type="button" className="secondary" disabled={loading || busy} onClick={() => void refresh().catch(() => undefined)}>刷新仓库与交付</button></div>
        <p className="mt-3 text-xs leading-6 text-[#65735d]">团队分支 main · {data.head?.slice(0, 12)}。成员提交文档后保存到任务分支，项目创建者查看差异并确认合并。</p>
        <details className="mt-3"><summary className="cursor-pointer text-xs text-[#365540]">main 中的文件</summary><ul className="mt-2 list-inside list-disc text-xs">{data.files?.map(file => <li key={file} className="break-all">{file}</li>)}</ul></details>
        <ul className="mt-4 divide-y divide-[#e3e8db]">{data.tasks?.map(task => <li id={`delivery-${task.id}`} key={task.id} className="sf-action-target py-3"><p className="text-sm font-medium">{task.objective}</p><p className="mt-1 break-all text-xs text-[#65735d]">{task.assigneeName} · {task.git ? `${task.git.branch} · ${task.git.commit.slice(0, 12)} · ${task.git.merged ? "已合并" : "待审查"}` : "尚未保存到 Git"}</p><div className="mt-2 flex flex-wrap gap-2">{!task.git && task.mine && <button type="button" className="secondary" disabled={unavailable} onClick={() => void act({ action: "store", taskId: task.id })}>保存我的交付到任务分支</button>}{task.git && <button type="button" className="secondary" disabled={unavailable} onClick={() => void showDiff(task.id)}>查看差异</button>}</div></li>)}</ul>
        {!data.tasks?.length && <p className="mt-4 text-xs leading-6 text-[#65735d]">还没有待交付的任务。邀请组员完成任务并确认提交后，即可在这里查看。</p>}
        {review && <section className="mt-4 rounded-lg border border-[#d5e2cd] p-4" aria-label="Git 交付差异"><h3 className="text-sm font-semibold">交付差异</h3><pre className="my-3 max-h-96 overflow-auto whitespace-pre-wrap break-words bg-[#f4f6f0] p-3 text-xs">{review.diff || (review.merged ? "这份交付已合并到 main。" : "没有差异。")}</pre>{isOwner && !review.merged && <button type="button" className="primary" disabled={unavailable} onClick={() => void act({ action: "merge", taskId: review.taskId, head: review.head, commit: review.commit })}>确认将此差异合并到 main</button>}</section>}
      </section>}
    </div>
  </details>;
}
