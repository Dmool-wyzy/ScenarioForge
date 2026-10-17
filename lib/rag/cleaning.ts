export function cleanContent(value: string) {
  return value.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").replace(/[ \t]+$/gm, "").replace(/\n{4,}/g, "\n\n\n").trim();
}
