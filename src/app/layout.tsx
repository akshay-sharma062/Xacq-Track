import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";
import { Sidebar } from "./components/Sidebar";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Xacqora Track",
  description:
    "Lead tracker & attribution CRM: which ad brought each lead in, where they stand, whether they paid — and the real outcomes sent back to Meta.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Resolve the workspace name for the shell (falls back to the brand when
  // the DB isn't seeded yet, so the app shell always renders).
  let workspace = "Xacqora Track";
  try {
    const ws = await prisma.workspace.findFirst();
    if (ws) workspace = ws.name;
  } catch {
    /* DB not ready — shell still renders */
  }

  return (
    <html lang="en">
      <body>
        {/* D-20: Chart.js v4.5.0 UMD — loaded once in the app shell (before any "use client"
            dashboard component mounts), with SRI verification. */}

        <Script
          src="https://cdn.jsdelivr.net/npm/chart.js@4.5.0/dist/chart.umd.min.js"
          integrity="sha384-XcdcwHqIPULERb2yDEM4R0XaQKU3YnDsrTmjACBZyfdVVqjh6xQ4/DCMd7XLcA6"
          crossOrigin="anonymous"
          strategy="beforeInteractive"
        />
        <div className="app">
          <Sidebar workspace={workspace} />
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
