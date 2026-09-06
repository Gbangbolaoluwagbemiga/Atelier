/**
 * ATELIER — the information architecture, as data.
 *
 * One app. The freelancer experience is singular; only the client area has
 * modes. That shape is the product decision the merge rests on, so it is
 * written down once, here, rather than spread across duplicated <Link> blocks
 * in a desktop nav and a mobile nav that drift apart.
 *
 *   Browse Jobs   one list. Agent-run and human-run jobs sit together, but an
 *                 agent-run one carries a badge — a freelancer deciding whether
 *                 to spend two days on a job should know who reviews it.
 *   My Work       the freelancer side: applications, active jobs, earnings.
 *   Post a Job    where the client chooses Manual or Autopilot.
 *   My Jobs       the client side. Manual jobs get the milestone review UI;
 *                 Autopilot jobs get the decision log.
 *   Analytics     platform and personal figures.
 *   Disputes      arbitration, for the people who do it.
 *
 * Atelier's original routes still resolve — see the redirects in App.tsx —
 * because there are live users with bookmarks and a deployed app that links
 * into /create and /dashboard.
 */

export interface NavItem {
  /** Route path. */
  to: string;
  /** Label in the nav. */
  label: string;
  /**
   * Which role this belongs to. Everything unconditional is `always`; the rest
   * appears when the connected wallet has earned it, which is how the nav stays
   * short for a first-time visitor.
   */
  visibility: "always" | "participant" | "freelancer" | "client" | "arbiter" | "admin";
}

/**
 * The primary nav, in order. Order is meaningful: browse before post, because
 * the marketplace has to look alive before anyone will fund an escrow into it.
 */
export const PRIMARY_NAV: readonly NavItem[] = [
  { to: "/jobs", label: "Browse Jobs", visibility: "always" },
  /*
   * The no-wallet door, and it is "always" on purpose.
   *
   * Someone who has never held a private key is exactly who this is for, so
   * gating it on a connected wallet — or on already being a freelancer — would
   * hide it from every single person it was built for.
   */
  { to: "/get-hired", label: "Get Hired", visibility: "always" },
  { to: "/post", label: "Post a Job", visibility: "always" },
  /*
   * One destination for both sides of the table.
   *
   * "My Work" and "My Jobs" used to be separate entries, which made sense to
   * whoever built it and to nobody using it — most people here hire someone one
   * week and take a job the next, and two nav entries meant two dashboards and
   * two places to check whether anything needed them. The page shows tabs only
   * when you actually have both roles.
   */
  { to: "/my-jobs", label: "My Jobs", visibility: "participant" },
  { to: "/analytics", label: "Analytics", visibility: "always" },
  /*
   * Disputes is NOT here. It is arbitration — a staff tool, not a place a
   * client or freelancer navigates to. It lives behind Admin, which is where it
   * was before and where the link back to it still points. Someone in a dispute
   * reaches it from the job itself, which is the context they need anyway.
   */
  { to: "/admin", label: "Admin", visibility: "admin" },
] as const;

/** What the connected wallet is entitled to see. */
export interface NavRoles {
  isFreelancer: boolean;
  isClient: boolean;
  isArbiter: boolean;
  isAdmin: boolean;
}

export function visibleNav(
  roles: NavRoles,
  items: readonly NavItem[] = PRIMARY_NAV,
): NavItem[] {
  return items.filter((item) => {
    switch (item.visibility) {
      case "always":
        return true;
      // Either side of the table. My Jobs sorts out which tabs to show.
      case "participant":
        return roles.isFreelancer || roles.isClient;
      case "freelancer":
        return roles.isFreelancer;
      case "client":
        return roles.isClient;
      case "arbiter":
        return roles.isArbiter;
      case "admin":
        return roles.isAdmin;
    }
  });
}

/**
 * Whether a nav item should read as current.
 *
 * Prefix matching, so /my-jobs/42 keeps "My Jobs" lit — except for "/", which
 * would otherwise match everything.
 */
export function isCurrent(pathname: string, to: string): boolean {
  if (to === "/") return pathname === "/";
  return pathname === to || pathname.startsWith(`${to}/`);
}

/**
 * Atelier's original paths, kept alive.
 *
 * These are not dead weight: the deployed app, the README, the subgraph docs
 * and at least one live user's bookmarks all point at them. Breaking them to
 * make a routing table tidier would be a self-inflicted regression on a product
 * that is already in use.
 */
export const LEGACY_REDIRECTS: Readonly<Record<string, string>> = {
  "/create": "/post",
  "/dashboard": "/my-jobs",
  // Both freelancer paths now land on the merged page, on the working side.
  "/freelancer": "/my-jobs?tab=working",
  "/work": "/my-jobs?tab=working",
} as const;
