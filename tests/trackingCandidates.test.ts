import { describe, expect, it } from "vitest";
import { checkTrackClosedNotification, describeNotificationCode } from "~/utils/trackingCandidates";

/**
 * Covers checkTrackClosedNotification — the code-8315 "tracking stopped"
 * lead documented in trackingCandidates.ts's top comment, "CODE 8315 =
 * TRACK CLOSE/CANCEL SIGNAL". The four real bodies this is tested against
 * are the exact bytes captured from Tracking Data Small.pcapng (see that
 * comment for where they came from); this isn't testing a guess, it's
 * pinning down the exact behaviour useTracking.ts depends on.
 */
describe("checkTrackClosedNotification", () => {
  const REAL_BODY = "0804100218052000";

  it("matches the real captured body on the real code", () => {
    const result = checkTrackClosedNotification(8315, REAL_BODY);
    expect(result.isCandidate).toBe(true);
    expect(result.matchesKnownBody).toBe(true);
  });

  it("is case-insensitive about the body's hex", () => {
    const result = checkTrackClosedNotification(8315, REAL_BODY.toUpperCase());
    expect(result.isCandidate).toBe(true);
    expect(result.matchesKnownBody).toBe(true);
  });

  it("still flags the code even when the body doesn't match anything seen so far", () => {
    // This is the interesting case to get right: a future real notification
    // with code 8315 but a body this file has never captured should still
    // set cameraConfirmedTrackingOff (isCandidate), while separately
    // flagging that it's not byte-identical to prior sightings, instead of
    // being silently dropped either way.
    const result = checkTrackClosedNotification(8315, "00112233");
    expect(result.isCandidate).toBe(true);
    expect(result.matchesKnownBody).toBe(false);
  });

  it("does not match an unrelated code, even with the exact known body", () => {
    const result = checkTrackClosedNotification(8317, REAL_BODY);
    expect(result.isCandidate).toBe(false);
  });

  it("does not match PTZ_STATE (8302) or the other undecoded codes seen this project", () => {
    for (const code of [8302, 8199, 8195, 8198, 8234, 8248, 8275, 8298, 8334]) {
      expect(checkTrackClosedNotification(code, REAL_BODY).isCandidate).toBe(false);
    }
  });
});

describe("describeNotificationCode", () => {
  it("labels 8315 without claiming it's a confirmed decode", () => {
    const label = describeNotificationCode(8315);
    expect(label).toContain("candidate");
    expect(label).not.toContain("confirmed");
  });

  it("returns null for codes this file has no lead on", () => {
    expect(describeNotificationCode(1)).toBeNull();
  });
});
