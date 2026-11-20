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

    const children = root.querySelectorAll<HTMLElement>(".animate-in");
    if (children.length === 0) return;

    const obs = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const el = entry.target as HTMLElement;
            const idx = Array.from(children).indexOf(el);
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
