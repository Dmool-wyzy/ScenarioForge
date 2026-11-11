import type { FilePlanItem, WorkspaceFilename, WorkspaceFile } from "@/lib/types";
export default function FileTabs({ files, filePlan, selected, onSelect, disabled }: { files: WorkspaceFile[]; filePlan: FilePlanItem[]; selected: WorkspaceFilename; onSelect: (filename: WorkspaceFilename) => void; disabled?: boolean }) {
  const names = [...new Set([...filePlan.map((item) => item.filename), ...files.map((file) => file.filename)])];
  return <div role="tablist" aria-label="工作区文件" className="flex overflow-x-auto border-y border-[#e6e9e1] bg-[#f8f9f5]">{names.map((name) => <button role="tab" aria-selected={name === selected} disabled={disabled} key={name} onClick={() => onSelect(name)} className={`shrink-0 border-b-2 px-4 py-3 font-mono text-xs ${selected === name ? "border-[#1c6555] bg-white text-[#1c6555]" : "border-transparent text-[#6e7a73]"}`}>{name}{files.some((f) => f.filename === name) && <span className="ml-2 text-[#79a18b]">●</span>}</button>)}</div>;
}
