"use client";

import { useEffect, useRef, useState } from "react";

/** Ease-out expo for the counter animation. */
function easeOutExpo(t: number): number {
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

export function CountUp({
  end,
  duration = 1200,
  prefix = "",
  suffix = "",
  decimals = 0,
  format = true,
}: {
  end: number;
  duration?: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  /** when true, format with fmtNum() / inr() logic (caller pre-formats) */
  format?: boolean;
}) {
  const [display, setDisplay] = useState("0");
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const started = useRef(false);

  // IntersectionObserver: only animate when scrolled into view
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !started.current) {
          started.current = true;
          setVisible(true);
        }
      },
      { threshold: 0.3 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // The count-up animation (RAF loop)
  useEffect(() => {
    if (!visible) return;
    const start = performance.now();
    const from = 0;
    let raf: number;

    const tick = (now: number) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = easeOutExpo(progress);
      const current = from + (end - from) * eased;
      setDisplay(current.toFixed(decimals));
      if (progress < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        setDisplay(end.toFixed(decimals));
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [visible, end, duration, decimals]);

  return (
    <span ref={ref} className={visible ? "count-visible" : ""} style={{ display: "inline-block" }}>
      {prefix}{display}{suffix}
    </span>
  );
}
