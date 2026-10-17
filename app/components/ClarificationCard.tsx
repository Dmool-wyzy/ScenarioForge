"use client";
import { useState } from "react";
import type { Clarification } from "@/lib/types";
import { apiRequest } from "@/hooks/useResearch";

export default function ClarificationCard({ question, packageId, onAnswered }: { question: Clarification; packageId: string; onAnswered: () => Promise<void> }) {
  const [text, setText] = useState(""); const [choices, setChoices] = useState<string[]>([]); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const answered = question.status === "answered";
  return <section className="mt-5 rounded-lg border border-[#b5cbb7] bg-[#f0f6ed] p-4"><div className="mb-2 flex items-center gap-2"><span className="text-xs font-bold text-[#1c6555]">AGENT 向你确认</span><span className="muted text-[11px]">{question.priority === "blocking" ? "回答后继续研究" : "选填"}</span></div><h3 className="text-sm font-semibold leading-6">{question.question}</h3><p className="muted mt-2 text-xs leading-6">{question.whyNeeded}</p>{question.defaultAssumption && <p className="muted mt-2 text-xs">默认假设：{question.defaultAssumption}</p>}
    {answered ? <p className="mt-3 whitespace-pre-wrap text-sm">你的回答：{question.answer}</p> : <form className="mt-4 space-y-3" onSubmit={async (event) => {
      event.preventDefault(); setBusy(true); setError("");
      try { await apiRequest(`/api/research/${packageId}/answer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clarificationId: question.id, answer: question.type === "multi_choice" ? choices : text }) }); await onAnswered(); }
      catch (e) { setError(e instanceof Error ? e.message : "提交失败。"); } finally { setBusy(false); }
    }}>
      {question.type === "text" ? <textarea aria-label="回答澄清问题" rows={3} value={text} onChange={(e) => setText(e.target.value)} required maxLength={5000} /> : <div className="space-y-2">{question.options?.map((option) => <label key={option} className="flex items-center gap-2 rounded border border-[#d4e0cf] bg-white p-2 text-sm font-normal"><input className="!m-0 !w-auto" type={question.type === "multi_choice" ? "checkbox" : "radio"} name={question.id} value={option} checked={question.type === "multi_choice" ? choices.includes(option) : text === option} onChange={(e) => question.type === "multi_choice" ? setChoices((old) => e.target.checked ? [...old, option] : old.filter((v) => v !== option)) : setText(option)} />{option}</label>)}</div>}
      {question.status === "blocked" && <p className="text-xs text-amber-800">等待已超时，你仍可回答以继续。</p>}
      {question.status === "defaulted" && <p className="text-xs text-amber-800">已按默认假设继续，你的回答可以更新它。</p>}
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
      <button className="primary text-sm" disabled={busy || (question.type === "multi_choice" ? !choices.length : !text.trim())}>{busy ? "提交中…" : "提交回答"}</button>
    </form>}
  </section>;
}
