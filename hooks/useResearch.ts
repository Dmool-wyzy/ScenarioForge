"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ResearchSnapshot } from "@/lib/types";

const EVENT_TYPES = ["source_added", "evidence_indexed", "research_question_completed", "retrieval_completed", "index_failed", "index_rebuild_required", "citation_warning", "tool_started", "tool_completed", "tool_failed", "research_started", "planning_completed", "file_plan_updated", "search_started", "search_completed", "search_failed", "evidence_found", "clarification_requested", "clarification_answered", "clarification_timeout", "file_created", "file_updated", "file_locked", "file_unlocked", "research_completed", "research_failed"];
export async function apiRequest<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "请求失败，请稍后重试。");
  return body as T;
}

export function useResearch() {
  const [packageId, setPackageId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ResearchSnapshot | null>(null);
  const [error, setError] = useState("");
  const [connection, setConnection] = useState("idle");
  const [creating, setCreating] = useState(false);
  const refreshVersion = useRef(0);
  const select = useCallback((id: string) => {
    setPackageId(id);
    const url = new URL(window.location.href); url.searchParams.set("package", id); window.history.replaceState(null, "", url);
    localStorage.setItem("scenarioforge:last-package", id);
  }, []);
  useEffect(() => {
    const id = new URL(window.location.href).searchParams.get("package") ?? localStorage.getItem("scenarioforge:last-package");
    if (id && /^[a-zA-Z0-9_-]{8,100}$/.test(id)) queueMicrotask(() => select(id));
  }, [select]);
  const refresh = useCallback(async () => {
    if (!packageId) return;
    const version = ++refreshVersion.current;
    try {
      const data = await apiRequest<ResearchSnapshot>(`/api/research/${packageId}`);
      if (version === refreshVersion.current) setSnapshot(data);
    } catch (e) { if (version === refreshVersion.current) setError(e instanceof Error ? e.message : "无法读取研究包。"); }
  }, [packageId]);
  useEffect(() => {
    if (!packageId) return;
    let active = true;
    const abort = new AbortController();
    let source: EventSource | undefined;
    const version = ++refreshVersion.current;
    void apiRequest<ResearchSnapshot>(`/api/research/${packageId}`, { signal: abort.signal }).then((data) => {
      if (!active || version !== refreshVersion.current) return;
      setSnapshot(data); setError("");
      source = new EventSource(`/api/research/${packageId}/stream?after=${data.events.at(-1)?.sequence ?? 0}`);
      source.onopen = () => { if (active) setConnection("connected"); };
      source.onerror = () => { if (active) setConnection("reconnecting"); };
      for (const type of EVENT_TYPES) source.addEventListener(type, () => { if (active) void refresh(); });
    }).catch((e) => { if (active) setError(e instanceof Error ? e.message : "读取研究包失败。"); });
    return () => { active = false; abort.abort(); source?.close(); };
  }, [packageId, refresh]);
  const create = async (form: FormData) => {
    setCreating(true); setError("");
    try {
      const result = await apiRequest<{ packageId: string }>("/api/research", { method: "POST", body: form });
      setSnapshot(null); select(result.packageId);
    } catch (e) { setError(e instanceof Error ? e.message : "研究创建失败。"); }
    finally { setCreating(false); }
  };
  const sendMessage = async (message: string) => {
    if (!packageId) return;
    await apiRequest(`/api/research/${packageId}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message }) });
    await refresh();
  };
  return { packageId, snapshot, error, setError, connection, creating, create, refresh, sendMessage };
}
