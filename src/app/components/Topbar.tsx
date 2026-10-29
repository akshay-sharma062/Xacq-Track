"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

interface Persona {
  email: string;
  name: string;
  role: string;
  phoneMask: boolean;
}

/**
 * Top-of-page bar: the acting persona (switchable, spec 5.10 roles), the
 * current client (drives `?client=`), and a read-only / portal hint. Persona
 * switching POSTs to /api/session (sets the cookie) and refreshes; client
 * switching rewrites the URL query so server components re-scope the data.
 */
export function Topbar({ title, crumb }: { title: string; crumb?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [me, setMe] = useState<Persona | null>(null);
  const [clients, setClients] = useState<{ id: string; name: string }[]>([]);

  const clientId = sp.get("client") ?? "";

  useEffect(() => {
    fetch("/api/session")
      .then((r) => r.json())
      .then((j) => {
        setPersonas(j.personas ?? []);
        setMe(j.session ? { ...j.session } : null);
        setClients(j.clients ?? []);
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
    if (id) next.set("client", id);
    else next.delete("client");
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
          <option value="">Client (default)</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
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
