"use client";
import { useEffect } from "react";
// Anchors can arrive before async panels. Reveal the exact target once it mounts.
export function useActionTarget(locationKey: string) {
  useEffect(() => {
    let observer: MutationObserver | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reveal = () => {
      const id = window.location.hash.slice(1);
      if (!/^(personal-task-|delivery-|clarification-|project-repository$|project-knowledge$|research-progress$|research-reply-|research-summary$|saved-evidence-)/.test(id)) return true;
      const node = document.getElementById(id);
      if (!node) return false;
      let parent: HTMLElement | null = node;
      while (parent) { if (parent instanceof HTMLDetailsElement) parent.open = true; parent = parent.parentElement; }
      node.tabIndex = -1; node.focus({ preventScroll: true }); node.scrollIntoView({ block: "center" });
      return true;
    };
    const begin = () => {
      observer?.disconnect(); clearTimeout(timer);
      if (reveal()) return;
      observer = new MutationObserver(() => { if (reveal()) { observer?.disconnect(); clearTimeout(timer); } });
      observer.observe(document.body, { childList: true, subtree: true });
      timer = setTimeout(() => observer?.disconnect(), 15000);
    };
    begin(); window.addEventListener("hashchange", begin);
    return () => { observer?.disconnect(); clearTimeout(timer); window.removeEventListener("hashchange", begin); };
  }, [locationKey]);
}
