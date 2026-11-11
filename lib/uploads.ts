import "server-only";
import { ApiError } from "./errors";
import { readBytes } from "./validation";
import type { UploadedText } from "./types";
import { validateDocxArchive } from "./docx";

export async function parseResearchUpload(request: Request, beforeExtract?: (projectId: unknown) => Promise<void>) {
  const bytes = await readBytes(request, 26 * 1024 * 1024);
  let form: FormData;
  try { form = await new Response(new Uint8Array(bytes), { headers: { "Content-Type": request.headers.get("content-type") ?? "" } }).formData(); }
  catch { throw new ApiError(400, "上传表单无法解析。"); }
  if (beforeExtract) await beforeExtract(form.get("projectId"));
  const files = form.getAll("files");
  if (files.length > 5) throw new ApiError(400, "最多上传 5 个文件。");
  const extracted: UploadedText[] = [];
  for (const entry of files) {
    if (!(entry instanceof File)) throw new ApiError(400, "上传文件格式无效。");
    if (entry.size > 5 * 1024 * 1024) throw new ApiError(413, `文件 ${entry.name.slice(0, 80)} 超过 5 MB。`);
    if (entry.size === 0) throw new ApiError(400, "不能上传空文件。");
    const name = entry.name.normalize("NFKC");
    if (name.length > 150 || /[/\\\u0000-\u001f]/.test(name) || !/\.(md|txt|pdf|docx)$/i.test(name)) throw new ApiError(400, "仅支持文件名安全的 .md、.txt、.pdf 和 .docx 文件。");
    const buffer = Buffer.from(await entry.arrayBuffer());
    let text = "";
    try {
      if (/\.(md|txt)$/i.test(name)) text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      else if (/\.pdf$/i.test(name)) {
        if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("invalid PDF signature");
        const { PDFParse } = await import("pdf-parse");
        const parser = new PDFParse({ data: new Uint8Array(buffer) });
        try { text = (await parser.getText()).text; }
        finally { await parser.destroy(); }
      } else {
        if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw new Error("invalid DOCX signature");
        await validateDocxArchive(buffer);
        const mammoth = await import("mammoth");
        text = (await mammoth.extractRawText({ buffer })).value;
      }
    } catch { throw new ApiError(400, `无法提取 ${name} 的文本，请确认文件完整、未加密，且 TXT 使用 UTF-8 编码。`); }
    text = text.replace(/\u0000/g, "").trim();
    if (!text) throw new ApiError(400, `${name} 没有可提取的文本，扫描 PDF 需要先进行文字识别。`);
    extracted.push({ filename: name, extractedText: text.slice(0, 20000) });
  }
  let constraints: unknown;
  try { constraints = JSON.parse(String(form.get("constraints") ?? "{}")); }
  catch { throw new ApiError(400, "约束条件格式无效。"); }
  let sharedKnowledgeIds: unknown;
  try { sharedKnowledgeIds = JSON.parse(String(form.get("sharedKnowledgeIds") ?? "[]")); }
  catch { throw new ApiError(400, "项目共享资料选择格式无效。"); }
  return { projectId: form.get("projectId"), goal: form.get("goal"), mode: form.get("mode") ?? "chat", constraints, files: extracted, sharedKnowledgeIds };
}
