"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * D-08 — the dashboard date-range control (Yesterday / 7D / 30D / Last Month /
 * Last Year / Custom). Writes `?range=` (+ `?rFrom`/`?rTo` when custom) so the
 * server component re-scopes. 30d is the DEFAULT (omitted param = the stored
 * 30-day rollup, the only per-day data the Meta API returns — `.meta-probe-
 * findings.txt`); every other choice shows the closest-available data with the
 * honest "30-day rollup only" label on the dashboard, never a sliced number.
 */
const OPTIONS: { value: string; label: string }[] = [
  { value: "yesterday", label: "Yesterday" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D (default)" },
  { value: "last_month", label: "Last month" },
  { value: "last_year", label: "Last year" },
  { value: "custom", label: "Custom…" },
];

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export function RangePicker() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const active = sp.get("range") ?? "30d";
  const rFrom = sp.get("rFrom") ?? "";
  const rTo = sp.get("rTo") ?? "";

  function set(next: string) {
    const p = new URLSearchParams(sp.toString());
    if (next === "30d") {
      // 30d = the default stored view; keep the URL clean (server treats absent
      // range as the 30d native window — byte-identical to pre-D-08 behaviour).
      p.delete("range");
      p.delete("rFrom");
      p.delete("rTo");
    } else {
      p.set("range", next);
      if (next !== "custom") {
        p.delete("rFrom");
        p.delete("rTo");
      }
    }
    router.replace(`${pathname}?${p.toString()}`);
  }
  function setCustom(k: "rFrom" | "rTo", v: string) {
    const p = new URLSearchParams(sp.toString());
    p.set("range", "custom");
    if (v) p.set(k, v);
    else p.delete(k);
    router.replace(`${pathname}?${p.toString()}`);
  }

  return (
    <div className="row" style={{ gap: 8, alignItems: "center", marginBottom: 8 }} title="Applies to the KPI row, daily-spend chart and account cards. Beyond the stored 30-day rollup (Meta API limit), the dashboard shows the closest available data with an honest label.">
      <label className="muted" style={{ fontSize: 12 }} htmlFor="range-pick">
        Range
      </label>
      <select
        id="range-pick"
        value={active}
        onChange={(e) => set(e.target.value)}
        style={{ minWidth: 150 }}
      >
        {OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {active === "custom" && (
        <>
          <input type="date" value={rFrom} max={isoToday()} onChange={(e) => setCustom("rFrom", e.target.value)} aria-label="Custom from" />
          <span className="faint">→</span>
          <input type="date" value={rTo} max={isoToday()} onChange={(e) => setCustom("rTo", e.target.value)} aria-label="Custom to" />
        </>
      )}
    </div>
  );
}
