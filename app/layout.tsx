import type { Metadata } from "next";
import "./globals.css";
import "@uiw/react-md-editor/markdown-editor.css";
import "@uiw/react-markdown-preview/markdown.css";

export const metadata: Metadata = {
  title: "ScenarioForge · 先研究，再创作",
  description: "把一个想法，变成有据可依的项目工作区。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
