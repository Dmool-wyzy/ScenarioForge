"use client";
import { useEffect, useState } from "react";
import { apiRequest } from "@/hooks/useResearch";
export default function FavoriteButton({ kind, targetId }: { kind: string; targetId: string }) {
  const [saved, setSaved] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void apiRequest<{ favorite: { id: string } | null }>(`/api/me/favorites?${new URLSearchParams({ kind, targetId })}`).then(r => { if (active) setSaved(!!r.favorite); }).catch(() => {});
    return () => { active = false; };
  }, [kind, targetId]);
  return <span className="sf-favorite-control">{saved ? <a href="/profile?tab=favorites" aria-label="已收藏，管理我的收藏">★ 已收藏</a> : <button type="button" disabled={busy} onClick={async () => {
    setBusy(true); setError("");
    try { await apiRequest("/api/me/favorites", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, targetId }) }); setSaved(true); }
    catch (e) { setError(e instanceof Error ? e.message : "收藏失败，请重试。"); }
    finally { setBusy(false); }
  }}>{busy ? "收藏中…" : "☆ 收藏"}</button>}{error && <span role="alert">{error}</span>}</span>;
}
