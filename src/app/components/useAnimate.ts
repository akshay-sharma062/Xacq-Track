"use client";

import { useEffect, useRef, useCallback } from "react";

/**
 * IntersectionObserver hook: when an element with the .animate-in class
 * enters the viewport, add .visible to trigger the CSS fadeInUp transition.
 * Staggers children by `staggerMs` (default 80ms per child).
 */
export function useAnimate(staggerMs = 80) {
  const containerRef = useRef<HTMLDivElement>(null);

  const observe = useCallback(() => {
    const root = containerRef.current;
    if (!root) return;

    const children = Array.from(root.querySelectorAll<HTMLElement>(".animate-in"));
    // Also observe the container ITSELF when it carries .animate-in — the
    // account-cards case where the ref sits ON the .animate-in div and its
    // inner children are NOT .animate-in (descendants-only would find 0 and
    // the block would stay stuck at opacity:0 = the "blank dashboard" bug).
    if (root.classList.contains("animate-in")) children.unshift(root);
    if (children.length === 0) return;

    const obs = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const el = entry.target as HTMLElement;
            const idx = children.indexOf(el);
            const delay = idx * staggerMs;
            setTimeout(() => el.classList.add("visible"), delay);
            obs.unobserve(el);
          }
        });
      },
      { threshold: 0.1 }
    );

    children.forEach((c) => obs.observe(c));
    return () => obs.disconnect();
  }, [staggerMs]);

  useEffect(() => {
    const cleanup = observe();
    return cleanup || undefined;
  }, [observe]);

  return containerRef;
}
