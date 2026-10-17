import type { Root, RootContent, PhrasingContent } from "mdast";

// Transform text nodes only. Code, existing links and images remain literal.
export function remarkEvidenceCitations() {
  return (tree: Root) => {
    function walk(node: { type: string; children?: (RootContent | PhrasingContent)[] }) {
      if (["code", "inlineCode", "link", "linkReference", "image", "imageReference"].includes(node.type) || !node.children) return;
      const children: (RootContent | PhrasingContent)[] = [];
      for (const child of node.children) {
        if (child.type !== "text") { walk(child); children.push(child); continue; }
        let start = 0;
        for (const match of child.value.matchAll(/\[(EVIDENCE-[1-9]\d*)\]/g)) {
          if (match.index! > start) children.push({ type: "text", value: child.value.slice(start, match.index) });
          children.push({ type: "link", url: `#evidence-${match[1]}`, children: [{ type: "text", value: match[0] }] });
          start = match.index! + match[0].length;
        }
        if (start < child.value.length) children.push({ type: "text", value: child.value.slice(start) });
      }
      node.children = children;
    }
    walk(tree);
  };
}
