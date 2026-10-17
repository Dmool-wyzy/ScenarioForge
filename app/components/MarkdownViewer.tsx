"use client";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkEvidenceCitations } from "@/lib/citation-markdown";
export default function MarkdownViewer({ content, onEvidenceClick }: { content: string; onEvidenceClick?: (id: string) => void }) {
  return <div className="prose"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm, remarkEvidenceCitations]} urlTransform={(url) => {
    const safe = defaultUrlTransform(url);
    return /^(https?:\/\/|#)/i.test(safe) ? safe : "";
  }} components={{ a: ({ children, href }) => href?.startsWith("#evidence-") && onEvidenceClick ? <button className="text-[#1c6555] underline" onClick={() => onEvidenceClick(href.slice(10))}>{children}</button> : <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>, img: ({ alt }) => <span className="muted text-sm">[图片：{alt ?? "参考图"}]</span> }}>{content}</ReactMarkdown></div>;
}
