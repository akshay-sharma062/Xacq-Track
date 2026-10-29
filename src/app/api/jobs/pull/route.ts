/**
 * Durable cron trigger for the Meta ads-pull (spec 5.7: "alert on failures",
 * and a durable queue so a slow platform or a spike never drops the job).
 *
 * In prod, Vercel cron (or a host timer) hits this once per hour; it runs a
 * single `runDuePulls()` pass for the cadence that is due this hour. Idempotent
 * (pulls upsert, so re-firing the same slot is a no-op). Authenticated by a
 * shared secret header so a random caller can't trigger pulls.
 *
 *   POST /api/jobs/pull   header: `x-job-secret: <CRON_PULL_SECRET>`
 */
import { NextRequest, NextResponse } from "next/server";
import { runDuePulls, cadenceForHour, daysForCadence } from "@/jobs/pull-scheduler";

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-job-secret");
  const expected = process.env.CRON_PULL_SECRET;
  if (!expected || secret !== expected) {
    return NextResponse.json({ error: "invalid job secret" }, { status: 401 });
  }

  const tz = process.env.TZ ?? "Asia/Kolkata";
  const hour = new Date(new Date().toLocaleString("en-US", { timeZone: tz })).getHours();
  const cadence = cadenceForHour(hour);
  if (!cadence) {
    return NextResponse.json({ fired: false, reason: `no pull due at ${String(hour).padStart(2, "0")}:00 ${tz}` });
  }

  const res = await runDuePulls({ days: daysForCadence(cadence) });
  return NextResponse.json({
    fired: true,
    cadence,
    tokenPresent: res.tokenPresent,
    simulateMode: res.simulateMode,
    ran: res.ran,
    failures: res.failures,
    skipped: res.skipped,
  });
}
