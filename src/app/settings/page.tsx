import { Topbar } from "../components/Topbar";
import { SettingsForm } from "./SettingsForm";

/**
 * Screen 13 — Settings (spec 5.10 / 7). Per-client attribution model + window,
 * webhook secret rotation, and the CAPI pixel/dataset. Admin/owner only
 * (enforced at the API layer via the `edit_settings` permission).
 */
export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return (
    <>
      <Topbar title="Settings" crumb="Attribution · webhooks · CAPI" />
      <SettingsForm />
    </>
  );
}
