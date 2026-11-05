"use client";

import { Suspense, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

interface Persona {
  email: string;
  name: string;
  role: string;
  phoneMask: boolean;
}

// D-01: the ad-account filter options come straight from the AdAccount link
// rows (session route) — one real account today (Upcurvv-FML), never a
// canned dropdown.
interface AdAccountOption {
  metaId: string;
  name: string;
  displayOwnerName: string | null;
  currency: string;
  status: string;
}

/**
 * Top-of-page bar: the acting persona (switchable, spec 5.10 roles), the
 * current client (drives `?client=`), and a read-only / portal hint. Persona
 * switching POSTs to /api/session (sets the cookie) and refreshes; client
 * switching rewrites the URL query so server components re-scope the data.
 */
function TopbarInner({ title, crumb }: { title: string; crumb?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [me, setMe] = useState<Persona | null>(null);
  const [clients, setClients] = useState<{ id: string; name: string }[]>([]);
  const [adAccounts, setAdAccounts] = useState<AdAccountOption[]>([]);

  // Dashboard-V2 §1: "All clients" is the DEFAULT (value "all"); a specific
  // client id drills down. Same DB-driven option set (no hardcoding).
  const clientId = sp.get("client") ?? "all";
  const adAccountId = sp.get("adAccount") ?? "";

  useEffect(() => {
    fetch("/api/session")
      .then((r) => r.json())
      .then((j) => {
        setPersonas(j.personas ?? []);
        setMe(j.session ? { ...j.session } : null);
        setClients(j.clients ?? []);
        setAdAccounts(j.adAccounts ?? []);
      })
      .catch(() => {});
  }, []);

  async function switchPersona(email: string) {
    await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    router.refresh();
  }
  function switchClient(id: string) {
    const next = new URLSearchParams(sp.toString());
    // "all" (or empty) = the All-clients default view; a specific id drills in.
    if (id && id !== "all") next.set("client", id);
    else next.delete("client");
    // Switching client re-scopes the ad-account list, so drop the ad-account
    // filter (it is client-specific) to avoid a stale `?adAccount=`.
    next.delete("adAccount");
    router.replace(`${pathname}?${next.toString()}`);
  }
  function switchAdAccount(metaId: string) {
    const next = new URLSearchParams(sp.toString());
    if (metaId) next.set("adAccount", metaId);
    else next.delete("adAccount");
    router.replace(`${pathname}?${next.toString()}`);
  }

  return (
    <div className="topbar">
      <div className="title">
        <span className="crumb">{crumb ?? "Xacqora Track"}</span>
        <h1>{title}</h1>
      </div>
      <div className="row">
        <select
          value={clientId}
          onChange={(e) => switchClient(e.target.value)}
          style={{ minWidth: 160 }}
        >
          <option value="all">All clients (default)</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        {/* D-01: ad-account filter, options from the AdAccount link rows. */}
        <select
          value={adAccountId}
          onChange={(e) => switchAdAccount(e.target.value)}
          style={{ minWidth: 150 }}
          title="Filter reports by Meta ad account"
        >
          <option value="">All ad accounts</option>
          {adAccounts.map((a) => (
            <option key={a.metaId} value={a.metaId}>
              {a.name} ({a.currency})
            </option>
          ))}
        </select>
        <div className="row" style={{ gap: 6 }}>
          <span className="badge accent">{me?.role ?? "…"}</span>
          <span className="muted" style={{ fontSize: 12 }}>
            {me?.name}
          </span>
          <select
            value={me?.email ?? ""}
            onChange={(e) => switchPersona(e.target.value)}
            style={{ minWidth: 120, padding: "4px 8px" }}
            title="Switch demo persona"
          >
            {personas.map((p) => (
              <option key={p.email} value={p.email}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}

/**
 * D-10: the exported component is the Suspense-bounded wrapper — call sites
 * (`<Topbar .../>` on ~10 pages) stay unchanged; the boundary keeps the
 * useSearchParams invariant safe on every client-side param switch
 * (client/account/ad-account selects = router.replace, not a full reload).
 */
export function Topbar({ title, crumb }: { title: string; crumb?: string }) {
  return (
    <Suspense fallback={null}>
      <TopbarInner title={title} crumb={crumb} />
    </Suspense>
  );
}
