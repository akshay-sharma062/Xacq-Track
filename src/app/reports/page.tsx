import { Topbar } from "../components/Topbar";
import { ReportSwitcher } from "./ReportSwitcher";

/**
 * Screen 9 — Reports (spec 7). All reports live behind /api/reports?key=…;
 * each states its attribution model + window, counts revenue net of refunds,
 * and exports CSV/Excel. This page hosts the client-side report switcher.
 */
export const dynamic = "force-dynamic";

export default function ReportsPage() {
  return (
    <>
      <Topbar title="Reports" crumb="Funnel · ad performance · wasted spend · Meta vs Track" />
      <ReportSwitcher />
    </>
  );
}
