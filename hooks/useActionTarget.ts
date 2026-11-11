"use client";
import { useEffect } from "react";
// Anchors can arrive before async panels. Reveal the exact target once it mounts.
export function useActionTarget(locationKey: string) {
  useEffect(() => {
    let observer: MutationObserver | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let targetId = "";
    let openedPanels = new WeakSet<HTMLElement>();
    const reveal = () => {
      const id = targetId;
      if (!/^(personal-task-|delivery-|clarification-|project-repository$|project-knowledge$|research-progress$|research-reply-|research-summary$|saved-evidence-)/.test(id)) return true;
      const node = document.getElementById(id);
      if (!node) return false;
      const hiddenPanel = node.closest<HTMLElement>('[role="tabpanel"][hidden]');
      if (hiddenPanel) {
        if (!openedPanels.has(hiddenPanel)) {
          const labelledTabs = (hiddenPanel.getAttribute("aria-labelledby") ?? "").split(/\s+/)
            .map(label => document.getElementById(label)).filter((tab): tab is HTMLElement => tab?.getAttribute("role") === "tab");
          const tab = labelledTabs[0] ?? Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]'))
            .find(candidate => hiddenPanel.id && (candidate.getAttribute("aria-controls") ?? "").split(/\s+/).includes(hiddenPanel.id));
          if (tab) { openedPanels.add(hiddenPanel); tab.click(); }
        }
        // Tab selection is asynchronous; wait for hidden to change before focusing.
        return false;
      }
      let parent: HTMLElement | null = node;
      while (parent) { if (parent instanceof HTMLDetailsElement) parent.open = true; parent = parent.parentElement; }
      node.tabIndex = -1; node.focus({ preventScroll: true }); node.scrollIntoView({ block: "center" });
      return true;
    };
    const begin = () => {
      observer?.disconnect(); clearTimeout(timer);
      targetId = window.location.hash.slice(1);
      openedPanels = new WeakSet<HTMLElement>();
      observer = new MutationObserver(() => { if (reveal()) { observer?.disconnect(); clearTimeout(timer); } });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
      timer = setTimeout(() => observer?.disconnect(), 15000);
      if (reveal()) { observer.disconnect(); clearTimeout(timer); }
    };
    begin(); window.addEventListener("hashchange", begin);
    return () => { observer?.disconnect(); clearTimeout(timer); window.removeEventListener("hashchange", begin); };
  }, [locationKey]);
}
