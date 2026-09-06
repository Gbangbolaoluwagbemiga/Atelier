import { describe, it, expect } from "vitest";
import {
  PRIMARY_NAV,
  isCurrent,
  visibleNav,
  type NavRoles,
} from "@/lib/atelier/nav";

const NOBODY: NavRoles = {
  isFreelancer: false,
  isClient: false,
  isArbiter: false,
  isAdmin: false,
};

describe("visibleNav", () => {
  it("shows a first-time visitor only the unconditional entries", () => {
    expect(visibleNav(NOBODY).map((i) => i.to)).toEqual([
      "/jobs",
      "/get-hired",
      "/post",
      "/analytics",
    ]);
  });

  /**
   * Browse Jobs and Post a Job must survive every role combination. They are
   * the two doors into the marketplace: hide either behind a role and a new
   * wallet lands on an app with nothing to do.
   */
  it("always offers a way in and a way to post", () => {
    const combos: NavRoles[] = [
      NOBODY,
      { ...NOBODY, isFreelancer: true },
      { ...NOBODY, isClient: true },
      { ...NOBODY, isArbiter: true, isAdmin: true },
      { isFreelancer: true, isClient: true, isArbiter: true, isAdmin: true },
    ];
    for (const roles of combos) {
      const paths = visibleNav(roles).map((i) => i.to);
      expect(paths).toContain("/jobs");
      expect(paths).toContain("/post");
      // The no-wallet door must survive every role combination — hiding it
      // from anyone hides it from the people it exists for.
      expect(paths).toContain("/get-hired");
    }
  });

  /**
   * My Jobs is one destination for both sides of the table. Either role earns
   * it, and the page itself decides whether to show tabs — so the nav must not
   * try to distinguish them.
   */
  it("shows My Jobs to either side of the table", () => {
    expect(visibleNav({ ...NOBODY, isFreelancer: true }).map((i) => i.to)).toContain("/my-jobs");
    expect(visibleNav({ ...NOBODY, isClient: true }).map((i) => i.to)).toContain("/my-jobs");
  });

  it("offers it exactly once to someone with both roles", () => {
    const paths = visibleNav({
      isFreelancer: true,
      isClient: true,
      isArbiter: false,
      isAdmin: false,
    }).map((i) => i.to);
    expect(paths.filter((p) => p === "/my-jobs")).toHaveLength(1);
  });

  it("hides My Jobs from someone who has neither posted nor been hired", () => {
    expect(visibleNav(NOBODY).map((i) => i.to)).not.toContain("/my-jobs");
  });

  it("reveals admin only to an admin", () => {
    expect(visibleNav({ ...NOBODY, isAdmin: true }).map((i) => i.to)).toContain("/admin");
  });

  /**
   * Disputes is arbitration — a staff tool reached from Admin, not a place a
   * client or freelancer navigates to. It must not reappear in the nav for
   * anyone, including an arbiter, who gets there through Admin.
   */
  it("never puts Disputes in the nav, for any role", () => {
    const everyone: NavRoles[] = [
      NOBODY,
      { ...NOBODY, isFreelancer: true },
      { ...NOBODY, isClient: true },
      { ...NOBODY, isArbiter: true },
      { isFreelancer: true, isClient: true, isArbiter: true, isAdmin: true },
    ];
    for (const roles of everyone) {
      expect(visibleNav(roles).map((i) => i.to)).not.toContain("/disputes");
    }
  });

  it("keeps admin out of an ordinary user's nav", () => {
    const paths = visibleNav({
      isFreelancer: true,
      isClient: true,
      isArbiter: false,
      isAdmin: false,
    }).map((i) => i.to);
    expect(paths).not.toContain("/admin");
  });

  it("preserves declaration order regardless of roles", () => {
    const all = visibleNav({
      isFreelancer: true,
      isClient: true,
      isArbiter: true,
      isAdmin: true,
    });
    expect(all.map((i) => i.to)).toEqual(PRIMARY_NAV.map((i) => i.to));
  });
});

describe("isCurrent", () => {
  it("lights a nav item on its own route", () => {
    expect(isCurrent("/jobs", "/jobs")).toBe(true);
  });

  it("stays lit on a child route", () => {
    expect(isCurrent("/my-jobs/42", "/my-jobs")).toBe(true);
    expect(isCurrent("/post/autopilot", "/post")).toBe(true);
  });

  /**
   * The case a naive startsWith gets wrong: "/work" must not light on
   * "/workspace", and "/" must not light on everything.
   */
  it("does not match a route that merely shares a prefix", () => {
    expect(isCurrent("/workspace", "/work")).toBe(false);
    expect(isCurrent("/jobsy", "/jobs")).toBe(false);
  });

  it("lights home only on home", () => {
    expect(isCurrent("/", "/")).toBe(true);
    expect(isCurrent("/jobs", "/")).toBe(false);
  });
});
