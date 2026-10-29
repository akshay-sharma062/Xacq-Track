import type { Metadata } from "next";
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
        <div className="app">
          <Sidebar workspace={workspace} />
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
