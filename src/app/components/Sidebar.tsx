"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface Item {
  href: string;
  label: string;
  section: string;
  dot?: string;
}

const NAV: Item[] = [
  { section: "Overview", label: "", href: "#", dot: undefined } as unknown as Item,
  { href: "/", label: "Dashboard", section: "Overview" },
  { section: "Leads", label: "", href: "#", dot: undefined } as unknown as Item,
  { href: "/leads", label: "Lead list", section: "Leads" },
  { href: "/pipeline", label: "Pipeline", section: "Leads", dot: "var(--accent)" },
  { href: "/duplicates", label: "Duplicates", section: "Leads", dot: "var(--warn)" },
  { section: "Reports", label: "", href: "#", dot: undefined } as unknown as Item,
  { href: "/reports", label: "Reports", section: "Reports" },
  { section: "Integrations", label: "", href: "#", dot: undefined } as unknown as Item,
  { href: "/integrations", label: "Integrations hub", section: "Integrations" },
  { href: "/meta", label: "Meta pull + CAPI", section: "Integrations" },
  { section: "Data", label: "", href: "#", dot: undefined } as unknown as Item,
  { href: "/import", label: "CSV import", section: "Data" },
  { section: "Admin", label: "", href: "#", dot: undefined } as unknown as Item,
  { href: "/admin", label: "Team & roles", section: "Admin" },
  { href: "/audit", label: "Audit log", section: "Admin" },
  { href: "/settings", label: "Settings", section: "Admin" },
];

export function Sidebar({ workspace }: { workspace: string }) {
  const pathname = usePathname();
  const sections = Array.from(new Set(NAV.map((n) => n.section)));
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="logo">X</div>
        <div>
          <div className="name">Xacqora Track</div>
          <div className="sub">{workspace}</div>
        </div>
      </div>
      <nav className="nav">
        {sections.map((sec) => (
          <div key={sec}>
            <div className="nav-section">{sec}</div>
            {NAV.filter((n) => n.section === sec).map((n) => (
              <Link key={n.href} href={n.href} className={isActive(n.href) ? "active" : ""}>
                {n.dot ? <span className="dot" style={{ background: n.dot }} /> : null}
                {n.label}
              </Link>
            ))}
          </div>
        ))}
      </nav>
    </aside>
  );
}
