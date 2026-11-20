"use client";

import { useEffect, useRef, useMemo } from "react";

// Chart.js v4 UMD global (loaded by layout.tsx <Script> tag)
declare const Chart: any;

const FONT = "system-ui, ui-sans-serif, sans-serif";
const GRID = "rgba(255,255,255,0.06)";

function makeOpts(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 1200, easing: "easeOutQuart" },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: "rgba(18,24,38,0.95)",
        borderColor: "rgba(79,140,255,0.4)",
        borderWidth: 1,
        titleFont: { family: FONT, size: 12 },
        bodyFont: { family: FONT, size: 12 },
        padding: 10,
        cornerRadius: 8,
        displayColors: true,
        boxPadding: 3,
      },
    },
    scales: {
      x: {
        grid: { color: GRID },
        ticks: { color: "#5b647a", font: { family: FONT, size: 11 } },
        border: { color: GRID },
      },
      y: {
        grid: { color: GRID },
        ticks: { color: "#5b647a", font: { family: FONT, size: 11 } },
        border: { color: GRID },
      },
    },
    ...extra,
  };
}

/* ─── DonutChart ─── */
export function DonutChart({
  data,
  size = 200,
  centerLabel,
}: {
  data: { label: string; value: number; color: string }[];
  size?: number;
  centerLabel?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<any>(null);
  const total = useMemo(() => data.reduce((s, d) => s + d.value, 0), [data]);

  useEffect(() => {
    if (!canvasRef.current) return;
    if (chartRef.current) chartRef.current.destroy();
    const ctx = canvasRef.current.getContext("2d");
    if (!ctx) return;

    chartRef.current = new Chart(ctx, {
      type: "doughnut",
      data: {
        labels: data.map((d) => d.label),
        datasets: [
          {
            data: data.map((d) => d.value),
            backgroundColor: data.map((d) => d.color),
            borderColor: "rgba(18,24,38,0.8)",
            borderWidth: 2,
            hoverBorderColor: "#fff",
            hoverBorderWidth: 2,
            hoverOffset: 6,
          },
        ],
      },
      options: makeOpts({
        cutout: "62%",
        animation: { animateRotate: true, duration: 1200 },
        plugins: {
          tooltip: {
            callbacks: {
              label: function (ctx: any) {
                const p = total > 0 ? ((ctx.parsed / total) * 100).toFixed(1) : "0";
                return " " + ctx.label + ": " + ctx.parsed + " (" + p + "%)";
              },
            },
          },
        },
      }),
      plugins: [
        {
          id: "centerText",
          afterDraw: function (chart: any) {
            if (!centerLabel) return;
            var c = chart.ctx;
            var ca = chart.chartArea;
            c.save();
            c.font = "600 " + size * 0.09 + "px " + FONT;
            c.fillStyle = "#8a94a8";
            c.textAlign = "center";
            c.textBaseline = "middle";
            c.fillText(centerLabel, ca.left + ca.width / 2, ca.top + ca.height / 2);
            c.restore();
          },
        },
      ],
    });

    return function () { chartRef.current && chartRef.current.destroy(); };
  }, [data, total, size, centerLabel]);

  return (
    <div className="chart-wrap" style={{ maxWidth: size, maxHeight: size, margin: "0 auto" }}>
      <canvas ref={canvasRef} width={size} height={size} />
    </div>
  );
}

/* ─── LineChart ─── */
export function LineChart({
  data,
  color = "#4f8cff",
  unit = "",
  label,
}: {
  data: { date: string; value: number }[];
  color?: string;
  unit?: string;
  label?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<any>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    if (chartRef.current) chartRef.current.destroy();
    const ctx = canvasRef.current.getContext("2d");
    if (!ctx) return;

    var gradient = ctx.createLinearGradient(0, 0, 0, 300);
    gradient.addColorStop(0, color + "40");
    gradient.addColorStop(1, color + "00");

    chartRef.current = new Chart(ctx, {
      type: "line",
      data: {
        labels: data.map(function (d) { return d.date; }),
        datasets: [
          {
            label: label || "",
            data: data.map(function (d) { return d.value; }),
            borderColor: color,
            backgroundColor: gradient,
            fill: true,
            tension: 0.4,
            pointRadius: 0,
            pointHoverRadius: 5,
            pointHoverBackgroundColor: color,
            pointHoverBorderColor: "#fff",
            pointHoverBorderWidth: 2,
            borderWidth: 2.5,
          },
        ],
      },
      options: makeOpts({
        interaction: { mode: "index", intersect: false },
        plugins: {
          tooltip: {
            callbacks: {
              title: function (items: any[]) { return items[0] ? items[0].label : ""; },
              label: function (ctx: any) {
                return " " + (ctx.dataset.label || "") + ": " + (unit ? unit + " " : "") + Number(ctx.parsed.y).toLocaleString("en-IN");
              },
            },
          },
        },
        scales: {
          x: {
            grid: { color: GRID },
            ticks: { color: "#5b647a", font: { family: FONT, size: 11 }, maxRotation: 30, minRotation: 0 },
            border: { color: GRID },
          },
        },
      }),
      plugins: [
        {
          id: "crosshair",
          afterDraw: function (chart: any) {
            var active = chart.tooltip && chart.tooltip.getActiveElements();
            if (!active || !active.length) return;
            var c = chart.ctx;
            var ca = chart.chartArea;
            var x = active[0].element.x;
            c.save();
            c.beginPath();
            c.moveTo(x, ca.top);
            c.lineTo(x, ca.bottom);
            c.strokeStyle = "rgba(255,255,255,0.1)";
            c.lineWidth = 1;
            c.setLineDash([4, 4]);
            c.stroke();
            c.restore();
          },
        },
      ],
    });

    return function () { chartRef.current && chartRef.current.destroy(); };
  }, [data, color, unit, label]);

  return <div className="chart-wrap"><canvas ref={canvasRef} /></div>;
}

/* ─── BarChartV2 ─── */
export function BarChartV2({
  data,
  horizontal = false,
  color = "#4f8cff",
  unit = "",
}: {
  data: { label: string; value: number }[];
  horizontal?: boolean;
  color?: string;
  unit?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<any>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    if (chartRef.current) chartRef.current.destroy();
    const ctx = canvasRef.current.getContext("2d");
    if (!ctx) return;

    chartRef.current = new Chart(ctx, {
      type: "bar",
      data: {
        labels: data.map(function (d) { return d.label; }),
        datasets: [
          {
            label: "",
            data: data.map(function (d) { return d.value; }),
            backgroundColor: data.map(function (_, i) {
              var a = 0.7 - (i * 0.3) / Math.max(data.length, 1);
              return color + Math.round(a * 255).toString(16).padStart(2, "0");
            }),
            borderRadius: 6,
            borderSkipped: false,
          },
        ],
      },
      options: makeOpts({
        indexAxis: horizontal ? "y" : "x",
        plugins: {
          tooltip: {
            callbacks: {
              label: function (ctx: any) {
                return " " + (unit ? unit + " " : "") + Number(ctx.parsed[horizontal ? "x" : "y"]).toLocaleString("en-IN");
              },
            },
          },
        },
        scales: horizontal
          ? {
              x: { grid: { color: GRID }, ticks: { color: "#5b647a", font: { family: FONT, size: 10 } }, border: { color: GRID } },
              y: { grid: { display: false }, ticks: { color: "#8a94a8", font: { family: FONT, size: 11 } }, border: { color: GRID } },
            }
          : undefined,
      }),
    });

    return function () { chartRef.current && chartRef.current.destroy(); };
  }, [data, horizontal, color, unit]);

  return <div className="chart-wrap"><canvas ref={canvasRef} /></div>;
}

/* ─── AreaChart ─── */
export function AreaChart({
  data,
  datasets,
  unit = "",
}: {
  data: { date: string; value: number }[];
  datasets?: { label: string; values: number[]; color: string }[];
  unit?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<any>(null);

  var series = useMemo(function () {
    if (datasets) return datasets;
    return [{ label: "", values: data.map(function (d) { return d.value; }), color: "#4f8cff" }];
  }, [datasets, data]);

  var labels = useMemo(function () { return data.map(function (d) { return d.date; }); }, [data]);

  useEffect(function () {
    if (!canvasRef.current) return;
    if (chartRef.current) chartRef.current.destroy();
    const ctx = canvasRef.current.getContext("2d");
    if (!ctx) return;

    var ds = series.map(function (s: any) {
      var g = ctx.createLinearGradient(0, 0, 0, 300);
      g.addColorStop(0, s.color + "50");
      g.addColorStop(1, s.color + "05");
      return {
        label: s.label,
        data: s.values,
        borderColor: s.color,
        backgroundColor: g,
        fill: series.length === 1,
        tension: 0.4,
        pointRadius: 0,
        pointHoverRadius: 4,
        borderWidth: 2,
      };
    });

    chartRef.current = new Chart(ctx, {
      type: "line",
      data: { labels: labels, datasets: ds },
      options: makeOpts({
        interaction: { mode: "index", intersect: false },
        plugins: {
          tooltip: {
            callbacks: {
              title: function (items: any[]) { return items[0] ? items[0].label : ""; },
              label: function (ctx: any) {
                return " " + ctx.dataset.label + ": " + (unit ? unit + " " : "") + Number(ctx.parsed.y).toLocaleString("en-IN");
              },
            },
          },
        },
        scales: {
          x: {
            grid: { color: GRID },
            ticks: { color: "#5b647a", font: { family: FONT, size: 11 }, maxRotation: 30, minRotation: 0 },
            border: { color: GRID },
          },
        },
      }),
    });

    return function () { chartRef.current && chartRef.current.destroy(); };
  }, [series, labels, unit]);

  return <div className="chart-wrap"><canvas ref={canvasRef} /></div>;
}

/* ─── GaugeChart ─── */
export function GaugeChart({
  value,
  max = 100,
  label,
  thresholds = { warn: 50, good: 80 },
}: {
  value: number;
  max?: number;
  label?: string;
  thresholds?: { warn: number; good: number };
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<any>(null);

  var gaugeColor = useMemo(function () {
    var p = Math.min(1, Math.max(0, value / max));
    return p >= (thresholds.good / max) ? "#3ecf8e" : p >= (thresholds.warn / max) ? "#f5b83d" : "#ff6b6b";
  }, [value, max, thresholds.good, thresholds.warn]);

  useEffect(function () {
    if (!canvasRef.current) return;
    if (chartRef.current) chartRef.current.destroy();
    const ctx = canvasRef.current.getContext("2d");
    if (!ctx) return;

    var pctVal = Math.min(1, Math.max(0, value / max));

    chartRef.current = new Chart(ctx, {
      type: "doughnut",
      data: {
        datasets: [
          {
            data: [pctVal, 1 - pctVal],
            backgroundColor: [gaugeColor, "rgba(255,255,255,0.04)"],
            borderColor: ["rgba(18,24,38,0.8)", "transparent"],
            borderWidth: [2, 0],
            hoverBorderColor: ["#fff", "transparent"],
            hoverBorderWidth: [2, 0],
            hoverOffset: 4,
          },
        ],
      },
      options: makeOpts({
        cutout: "78%",
        rotation: -90,
        circumference: 180,
        animation: { animateRotate: true, duration: 1500, easing: "easeOutQuart" },
        plugins: { tooltip: { enabled: false } },
      }),
      plugins: [
        {
          id: "gaugeValue",
          afterDraw: function (chart: any) {
            var c = chart.ctx;
            var ca = chart.chartArea;
            var cx = ca.left + ca.width / 2;
            var cy = ca.top + ca.height * 0.85;
            c.save();
            c.textAlign = "center";
            c.textBaseline = "middle";
            c.font = "700 " + canvasRef.current!.width * 0.12 + "px " + FONT;
            c.fillStyle = gaugeColor;
            c.fillText(value.toFixed(1) + (label || ""), cx, cy);
            c.font = "500 " + canvasRef.current!.width * 0.05 + "px " + FONT;
            c.fillStyle = "#8a94a8";
            c.fillText(label ? label.replace(/[0-9.]/g, "").trim() || "" : "", cx, cy + canvasRef.current!.width * 0.1);
            c.restore();
          },
        },
      ],
    });

    return function () { chartRef.current && chartRef.current.destroy(); };
  }, [value, max, label, gaugeColor, thresholds]);

  return (
    <div className="chart-wrap" style={{ maxHeight: 180 }}>
      <canvas ref={canvasRef} />
    </div>
  );
}
