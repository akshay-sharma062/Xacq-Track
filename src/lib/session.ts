/**
 * Session + permissions (spec 5.10 / 10).
 *
 * In prod this is Supabase Auth (spec 8). For the zero-service local demo we
 * resolve the acting user from a cookie (`xacqora_user` = an email) falling
 * back to the `DEMO_USER` env var, so every screen + API route can scope data
 * by what that user is allowed to see. Swapping in Supabase later only means
 * replacing `currentUser()`'s body; the `Session` shape and the `can()` matrix
 * stay the same.
 *
 * Security invariants enforced here (spec 10):
 *   - every read is scoped to the user's visible client set (`Session.clientIds`);
 *   - roles that need phones off see only the last-4 (`maskPhone`);
 *   - the action matrix below is the single source of truth for what a role may do.
 */
import { cookies } from "next/headers";
import { prisma } from "./prisma";

export type Role = "owner" | "admin" | "media_buyer" | "sales_rep" | "viewer";

export interface Session {
  userId: string;
  workspaceId: string;
  email: string;
  name: string;
  role: Role;
  /** client ids this user may see. Empty = all clients in the workspace. */
  clientIds: string[];
  /** when true, this role must see phones masked to the last 4 (spec 5.10). */
  maskPhone: boolean;
}

const ROLES: Role[] = ["owner", "admin", "media_buyer", "sales_rep", "viewer"];

/** Parse the user's `clientAccess` JSON column into a client-id list. */
function parseClientAccess(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Resolve the acting user. A cookie wins (so a user can pick a demo persona);
 * otherwise we fall back to DEMO_USER. Returns null in an unauthenticated
 * context (the API routes turn that into a 401).
 */
export async function currentUser(): Promise<Session | null> {
  let email: string | undefined;
  try {
    const jar = await cookies();
    email = jar.get("xacqora_user")?.value || process.env.DEMO_USER;
  } catch {
    email = process.env.DEMO_USER; // outside request scope
  }
  if (!email) return null;

  const user = await prisma.user.findFirst({
    where: { email },
    include: { workspace: true },
  });
  if (!user) return null;

  return {
    userId: user.id,
    workspaceId: user.workspaceId,
    email: user.email,
    name: user.name,
    role: (ROLES.includes(user.role as Role) ? user.role : "viewer") as Role,
    clientIds: parseClientAccess(user.clientAccess),
    maskPhone: user.phoneMask,
  };
}

/** Which clients a session can read (its explicit list, else the workspace's). */
export async function visibleClients(s: Session): Promise<string[]> {
  if (s.clientIds.length > 0) return s.clientIds;
  const clients = await prisma.client.findMany({
    where: { workspaceId: s.workspaceId },
    select: { id: true },
  });
  return clients.map((c) => c.id);
}

/** Mask a phone to its last 4 digits (spec 5.10). Returns the raw value when
 *  the session may see phones, and a placeholder when it must be masked. */
export function maskPhone(raw: string | null | undefined, session: Session): string {
  if (!raw) return "";
  if (!session.maskPhone) return raw;
  const digits = raw.replace(/[^\d]/g, "");
  const last4 = digits.slice(-4) || "••••";
  return `•••••••••${last4}`;
}

// ---------------------------------------------------------------------------
// Role → action matrix (spec 5.10). `owner`/`admin` get everything; the rest
// are scoped so a client portal stays read-only (spec 5.10: "Read-only by default").
// ---------------------------------------------------------------------------
export type Action =
  | "view"
  | "view_phone"
  | "export"
  | "assign_lead"
  | "move_stage"
  | "add_note"
  | "add_task"
  | "merge_duplicate"
  | "send_capi"
  | "pull_meta"
  | "edit_settings"
  | "delete_lead";

const MATRIX: Record<Role, Action[]> = {
  owner: ["view", "view_phone", "export", "assign_lead", "move_stage", "add_note", "add_task", "merge_duplicate", "send_capi", "pull_meta", "edit_settings", "delete_lead"],
  admin: ["view", "view_phone", "export", "assign_lead", "move_stage", "add_note", "add_task", "merge_duplicate", "send_capi", "pull_meta", "edit_settings", "delete_lead"],
  media_buyer: ["view", "export", "send_capi", "pull_meta"],
  sales_rep: ["view", "view_phone", "assign_lead", "move_stage", "add_note", "add_task", "merge_duplicate"],
  viewer: ["view"], // read-only (client portal default, spec 5.10)
};

export function can(session: Pick<Session, "role">, action: Action): boolean {
  return MATRIX[session.role].includes(action);
}

export { ROLES };
