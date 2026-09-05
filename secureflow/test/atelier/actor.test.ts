import { describe, it, expect } from "vitest";
import {
  actorClass,
  actorForMode,
  clientModeFor,
  jobActorFor,
  type Viewer,
} from "@/lib/atelier/actor";

/**
 * The tests that matter here are not "does teal map to teal". They are about
 * the one rule the type system cannot enforce on its own:
 *
 *   A FREELANCER MUST NOT BE ABLE TO TELL WHETHER THEIR CLIENT IS A PERSON
 *   OR AN AGENT.
 *
 * That rule protects a single mixed marketplace. Break it and workers learn
 * which queue to prefer, which re-tiers the market — a product failure that
 * would show up as a slow drift in application counts rather than as a bug, so
 * it has to be caught here.
 */

const CLIENT: Viewer = { role: "client" };
const FREELANCER: Viewer = { role: "freelancer" };
const ARBITER: Viewer = { role: "arbiter" };
const PUBLIC: Viewer = { role: "public" };

describe("clientModeFor — who may know how a job is managed", () => {
  it("tells the client their own mode", () => {
    expect(clientModeFor("autopilot", CLIENT)).toBe("autopilot");
    expect(clientModeFor("manual", CLIENT)).toBe("manual");
  });

  it("tells an arbiter, because mode is material to a dispute", () => {
    expect(clientModeFor("autopilot", ARBITER)).toBe("autopilot");
  });

  it("tells a freelancer nothing, for either mode", () => {
    expect(clientModeFor("autopilot", FREELANCER)).toBeNull();
    expect(clientModeFor("manual", FREELANCER)).toBeNull();
  });

  it("tells the public nothing, for either mode", () => {
    expect(clientModeFor("autopilot", PUBLIC)).toBeNull();
    expect(clientModeFor("manual", PUBLIC)).toBeNull();
  });

  /**
   * The case the design did NOT set out to handle, and the one that actually
   * leaks: hiding only the autopilot jobs.
   *
   * If `manual` were returned to a freelancer while `autopilot` returned null,
   * every job would still be perfectly classifiable — the null ones are the
   * agent ones. Concealment by omission is not concealment. So the assertion is
   * that both modes return the SAME thing to a worker, not merely that autopilot
   * is hidden.
   */
  it("is indistinguishable across modes — no leak by elimination", () => {
    for (const viewer of [FREELANCER, PUBLIC]) {
      expect(clientModeFor("manual", viewer)).toEqual(
        clientModeFor("autopilot", viewer),
      );
    }
  });
});

describe("jobActorFor — the colour a job's chrome takes", () => {
  it("paints an Autopilot job amber for its own client", () => {
    expect(jobActorFor("autopilot", CLIENT)).toBe("agent");
  });

  it("paints a manual job teal for its own client", () => {
    expect(jobActorFor("manual", CLIENT)).toBe("human");
  });

  /**
   * The visual half of the same rule. Two jobs that differ only in mode must
   * render identically to a worker — one amber card in Browse Jobs would undo
   * everything clientModeFor protects.
   */
  it("paints both modes identically for a freelancer", () => {
    expect(jobActorFor("autopilot", FREELANCER)).toBe(
      jobActorFor("manual", FREELANCER),
    );
    expect(jobActorFor("autopilot", FREELANCER)).toBe("human");
  });

  it("paints both modes identically on public pages", () => {
    expect(jobActorFor("autopilot", PUBLIC)).toBe(jobActorFor("manual", PUBLIC));
  });

  it("shows an arbiter who was really in charge", () => {
    expect(jobActorFor("autopilot", ARBITER)).toBe("agent");
  });
});

describe("actor → class mapping", () => {
  it("maps each actor to its scope class", () => {
    expect(actorClass("human")).toBe("actor-human");
    expect(actorClass("agent")).toBe("actor-agent");
  });

  it("never returns the same class for both actors", () => {
    expect(actorClass("human")).not.toBe(actorClass("agent"));
  });

  it("derives the actor from the management mode", () => {
    expect(actorForMode("autopilot")).toBe("agent");
    expect(actorForMode("manual")).toBe("human");
  });
});
