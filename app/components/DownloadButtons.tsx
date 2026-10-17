"use client";
import { useState } from "react";
export default function DownloadButtons({ packageId, filename, hasFiles, hasCurrent }: { packageId: string | null; filename: string; hasFiles: boolean; hasCurrent: boolean }) {
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const download = async (all: boolean) => {
    if (!packageId) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/research/${packageId}/${all ? "workspace" : `files/${encodeURIComponent(filename)}`}`);
      if (!response.ok) { const body = await response.json(); throw new Error(body.error ?? "下载失败。"); }
      const href = URL.createObjectURL(await response.blob()); const anchor = document.createElement("a"); anchor.href = href; anchor.download = all ? "scenarioforge-workspace.zip" : filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch (e) { setError(e instanceof Error ? e.message : "下载失败。"); } finally { setBusy(false); }
  };
  return <div><div className="flex flex-wrap gap-2"><button className="secondary" onClick={() => download(false)} disabled={!hasCurrent || busy}>↓ 当前文件</button><button className="secondary" onClick={() => download(true)} disabled={!hasFiles || busy}>↓ 全部 ZIP</button></div>{error && <p role="alert" className="mt-2 text-xs text-red-700">{error}</p>}</div>;
}
