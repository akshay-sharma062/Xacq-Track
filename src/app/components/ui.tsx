/**
 * Small presentational building blocks shared by all 14 screens.
 * Charts are pure inline SVG (no recharts) so the demo runs with zero client
 * JS + zero peer-dep friction on React 19.
 */
import { ReactNode } from "react";

export function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "good" | "bad" | "warn" | "accent";
}) {
  return (
    <div className="card stat">
      <span className="k">{label}</span>
      <span className={`v ${tone ?? ""}`} style={toneColor(tone)}>
        {value}
      </span>
      {sub ? <span className="d muted">{sub}</span> : null}
    </div>
  );
}

function toneColor(t?: "good" | "bad" | "warn" | "accent") {
  switch (t) {
    case "good":
      return { color: "var(--good)" };
    case "bad":
      return { color: "var(--bad)" };
    case "warn":
      return { color: "var(--warn)" };
    case "accent":
      return { color: "var(--accent)" };
    default:
      return {};
  }
}

/** Pure-SVG vertical bar chart (e.g. spend or revenue by day). */
export function BarChart({
  data,
  height = 140,
  color = "var(--accent)",
  unit = "",
}: {
  data: { label: string; value: number }[];
  height?: number;
  color?: string;
  unit?: string;
}) {
  if (data.length === 0) return <div className="empty">no data</div>;
  const max = Math.max(...data.map((d) => d.value), 1);
  const barW = 100 / data.length;
  return (
    <div>
      <svg
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        style={{ width: "100%", height }}
        role="img"
      >
        {data.map((d, i) => {
          const h = (d.value / max) * (height - 18);
          const y = height - h - 14;
          return (
            <g key={i}>
              <rect
                x={i * barW + barW * 0.18}
                y={y}
                width={barW * 0.64}
                height={Math.max(1, h)}
                rx={1.2}
                fill={color}
                opacity={0.85}
              />
              {i % Math.ceil(data.length / 8) === 0 && (
                <text x={i * barW + barW / 2} y={height - 2} fontSize="3" fill="var(--faint)" textAnchor="middle">
                  {d.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="row spread mt" style={{ fontSize: 11 }}>
        <span className="muted">
          max {fmtNum(max)}
          {unit}
        </span>
        <span className="faint">{data.length} pts</span>
      </div>
    </div>
  );
}

/** Pure-SVG horizontal progress bar. */
export function Meter({ value, max, label, tone = "accent" }: { value: number; max: number; label?: string; tone?: "good" | "warn" | "bad" | "accent" }) {
  const pct = max ? Math.min(100, (value / max) * 100) : 0;
  const colors: Record<string, string> = { good: "var(--good)", warn: "var(--warn)", bad: "var(--bad)", accent: "var(--accent)" };
  return (
    <div>
      {label ? (
        <div className="row spread" style={{ fontSize: 12, marginBottom: 4 }}>
          <span className="muted">{label}</span>
          <span className="mono" style={{ color: colors[tone] }}>
            {pct.toFixed(0)}%
          </span>
        </div>
      ) : null}
      <div style={{ height: 6, background: "var(--panel-2)", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: colors[tone], borderRadius: 3 }} />
      </div>
    </div>
  );
}

export function Thumbnail({ url, name }: { url?: string | null; name?: string | null }) {
  if (url)
    return <img className="thumb" src={url} alt={name ?? "ad"} />;
  return (
    <div className="thumb-none">
      {name ? name.slice(0, 8) : "no art"}
    </div>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="row spread mb" style={{ marginTop: 4 }}>
      <h2 style={{ margin: 0 }}>{children}</h2>
      {right}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers (shared across screens + the CSV/report layers)
// ---------------------------------------------------------------------------
export function inr(n: number): string {
  return "₹" + Math.round(n).toLocaleString("en-IN");
}
export function fmtNum(n: number): string {
  return Math.round(n).toLocaleString("en-IN");
}
export function pct(n: number): string {
  return (n * 100).toFixed(1) + "%";
}
export function ist(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
