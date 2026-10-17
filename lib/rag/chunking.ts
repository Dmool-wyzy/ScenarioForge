import { cleanContent } from "./cleaning";

export type TextChunk = { content: string; tokenCount: number; metadata: { heading: string; offset: number; continued: boolean; tokenCountEstimated: true } };

// Keep fenced code and Markdown tables together. Oversized blocks are split by
// lines with their fence/table header repeated, rather than shredding cells.
export function chunkText(text: string, size = 800, overlap = 120): TextChunk[] {
  if (size < 100 || overlap < 0 || overlap >= size) throw new Error("Invalid chunk settings");
  const cleaned = cleanContent(text);
  if (!cleaned) return [];
  const lines = cleaned.split("\n");
  const blocks: { text: string; heading: string; offset: number; fence?: string; table?: string }[] = [];
  let heading = "", offset = 0;
  for (let i = 0; i < lines.length;) {
    const start = offset;
    const line = lines[i];
    if (!line.trim()) { offset += line.length + 1; i++; continue; }
    if (/^#{1,6}\s/.test(line)) heading = line.replace(/^#+\s*/, "");
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    const table = i + 1 < lines.length && /\|/.test(line) && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1]);
    const group = [line]; offset += line.length + 1; i++;
    if (fence) {
      const closing = new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`);
      while (i < lines.length) { const next = lines[i++]; group.push(next); offset += next.length + 1; if (closing.test(next)) break; }
    } else {
      while (i < lines.length && lines[i].trim() && !/^#{1,6}\s|^\s*(`{3,}|~{3,})/.test(lines[i]) && (!table || /\|/.test(lines[i]))) {
        group.push(lines[i]); offset += lines[i].length + 1; i++;
      }
    }
    blocks.push({ text: group.join("\n"), heading, offset: start, fence: fence ? line : undefined, table: table ? group.slice(0, 2).join("\n") : undefined });
  }
  const chunks: TextChunk[] = [];
  let pending = "", pendingHeading = "", pendingOffset = 0;
  function push(content: string, title: string, at: number, continued = false) {
    if (content.trim()) chunks.push({ content: content.trim(), tokenCount: Math.ceil(Buffer.byteLength(content, "utf8") / 3), metadata: { heading: title, offset: at, continued, tokenCountEstimated: true } });
  }
  function flush() { if (pending) push(pending, pendingHeading, pendingOffset); pending = ""; }
  for (const block of blocks) {
    if (block.fence || block.table) {
      flush();
      if (block.text.length <= size * 2) { push(block.text, block.heading, block.offset); continue; }
      const rows = block.text.split("\n");
      const prefix = block.fence ?? block.table!;
      const suffix = block.fence ? block.fence.trim().match(/^(`{3,}|~{3,})/)![0] : "";
      let part = prefix;
      const body = block.fence ? rows.slice(1, rows.at(-1)?.trim().startsWith(suffix) ? -1 : undefined) : rows.slice(2);
      for (const row of body) {
        if (part.length > prefix.length && part.length + row.length > size * 2) { push(`${part}\n${suffix}`, block.heading, block.offset, true); part = prefix; }
        part += `\n${row}`;
      }
      push(`${part}\n${suffix}`, block.heading, block.offset, true);
      continue;
    }
    if (pending && (pendingHeading !== block.heading || pending.length + block.text.length + 2 > size)) {
      const previous = pending;
      const previousAt = pendingOffset;
      flush();
      if (pendingHeading === block.heading && overlap) { pending = previous.slice(-overlap); pendingOffset = previousAt + previous.length - pending.length; }
    }
    if (!pending) { pendingHeading = block.heading; pendingOffset = block.offset; }
    pending += `${pending ? "\n\n" : ""}${block.text}`;
    while (pending.length > size) {
      const window = pending.slice(0, size);
      const boundary = Math.max(window.lastIndexOf("。"), window.lastIndexOf(". "), window.lastIndexOf("\n"), window.lastIndexOf(" "));
      const end = boundary > size * 0.65 ? boundary + 1 : size;
      push(pending.slice(0, end), pendingHeading, pendingOffset);
      const advance = Math.max(1, end - overlap);
      pending = pending.slice(advance); pendingOffset += advance;
    }
  }
  flush();
  return chunks;
}
