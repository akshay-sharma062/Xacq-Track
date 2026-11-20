import { Topbar } from "./components/Topbar";
import {
  Stat,
  BarChart,
  Meter,
  Thumbnail,
  inr,
  pct,
  SectionTitle,
  ist,
} from "./components/ui";
import { AutoRefresh } from "./components/AutoRefresh";
import { RangePicker } from "./components/RangePicker";
import { getSession, resolveClient, qs } from "@/lib/api-utils";
import { visibleClients } from "@/lib/session";
import { dashboardAll, clientProfile, SpendRange } from "@/lib/dashboard";
import { prisma } from "@/lib/prisma";
import Link from "next/link";
import DashboardBody from "./components/DashboardBody";

export const dynamic = "force-dynamic";

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const s = await getSession();
  if (!s) {
    return (
      <>
        <Topbar title="Dashboard" crumb="Not signed in" />
        <div className="card empty">No demo user configured. Set DEMO_USER in .env.</div>
      </>
    );
  }
  const sp = qs(await searchParams);
  const client = sp.client;
  const isAll = !client || client === "all";
  const visible = await visibleClients(s);
  const drill = isAll ? null : await resolveClient(s, client);
  const clientIds = isAll ? visible : drill ? [drill] : [];
  if (clientIds.length === 0) {
    return (
      <>
        <Topbar title="Dashboard" crumb={s.name} />
        <div className="card empty">No visible client for this user.</div>
      </>
    );
  }

  const adAccountMeta = sp.adAccount ?? undefined;
  const rangeParam = (sp.range as SpendRange | undefined) ?? undefined;
  const customRange =
    rangeParam === "custom" && (sp.rFrom || sp.rTo)
      ? { dayStart: sp.rFrom ?? undefined, dayEnd: sp.rTo ?? null }
      : undefined;

  // D-20: ALL data fetching is byte-identical to pre-D-20.
  // The premium rendering lives in DashboardBody (use client).
  const d = await dashboardAll(prisma, clientIds, "last_paid_click", 30, adAccountMeta, rangeParam, customRange);
  const k = d.kpi;

  const profile = !isAll && clientIds.length === 1 ? await clientProfile(prisma, clientIds[0]) : null;
  const allClientNames = isAll
    ? (
        await prisma.client.findMany({
          where: { id: { in: clientIds } },
          select: { name: true },
          orderBy: { name: "asc" },
        })
      ).map((c) => c.name)
    : null;

  const view = isAll ? "All clients" : profile?.name ?? (clientIds.length ? "Client" : "");
  const acctLabel = adAccountMeta ? ` · ${adAccountMeta}` : "";
  const rangeLabel = d.spendRange ? d.spendRange.label : "last 30 days";

  const topCampaigns = (d.topCampaigns || []).slice(0, 10).map((c) => ({
    label: c.campaign,
    value: c.spendInr,
  }));

  return (
    <>
      <Topbar title="Dashboard" crumb={`${view} · ${rangeLabel}${acctLabel}`} />
      <AutoRefresh dataAsOf={d.sync.dataAsOf} />
      <RangePicker />

      <DashboardBody
        profile={profile}
        allClientNames={allClientNames}
        isAll={isAll}
        rangeLabel={rangeLabel}
        spendRange={d.spendRange}
        kpi={k}
        accounts={d.accounts}
        spendByDay={d.spendByDay}
        sourceMix={[]}
        topCampaigns={topCampaigns}
        topAds={d.topAds}
        adSets={d.adSets}
        liveRanges={d.liveRanges ?? []}
      />
    </>
  );
}
