/**
 * ATELIER — the information architecture, as data.
 *
 * One app. The freelancer experience is singular; only the client area has
 * modes. That shape is the product decision the merge rests on, so it is
 * written down once, here, rather than spread across duplicated <Link> blocks
 * in a desktop nav and a mobile nav that drift apart.
 *
 *   Browse Jobs   one list. Agent-posted and human-posted, mixed and
 *                 indistinguishable. Not two tabs, not a filter.
 *   My Work       the freelancer side: applications, active jobs, earnings.
 *   Post a Job    where the client chooses Manual or Autopilot.
 *   My Jobs       the client side. Manual jobs get the milestone review UI;
 *                 Autopilot jobs get the decision log.
 *   Analytics     platform and personal figures.
 *   Disputes      arbitration, for the people who do it.
 *
 * SecureFlow's original routes still resolve — see the redirects in App.tsx —
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
  visibility: "always" | "freelancer" | "client" | "arbiter" | "admin";
}

/**
 * The primary nav, in order. Order is meaningful: browse before post, because
 * the marketplace has to look alive before anyone will fund an escrow into it.
 */
export const PRIMARY_NAV: readonly NavItem[] = [
  { to: "/jobs", label: "Browse Jobs", visibility: "always" },
  { to: "/work", label: "My Work", visibility: "freelancer" },
  { to: "/post", label: "Post a Job", visibility: "always" },
  { to: "/my-jobs", label: "My Jobs", visibility: "client" },
  { to: "/analytics", label: "Analytics", visibility: "always" },
  { to: "/disputes", label: "Disputes", visibility: "arbiter" },
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
 * SecureFlow's original paths, kept alive.
 *
 * These are not dead weight: the deployed app, the README, the subgraph docs
 * and at least one live user's bookmarks all point at them. Breaking them to
 * make a routing table tidier would be a self-inflicted regression on a product
 * that is already in use.
 */
export const LEGACY_REDIRECTS: Readonly<Record<string, string>> = {
  "/create": "/post",
  "/dashboard": "/my-jobs",
  "/freelancer": "/work",
} as const;
