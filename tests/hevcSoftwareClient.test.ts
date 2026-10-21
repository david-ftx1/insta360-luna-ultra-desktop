import { describe, expect, it } from "vitest";
import {
  destroySoftwareHevcDecoder,
  feedSoftwareHevc,
  resetSoftwareHevcDecoder,
  softwareHevcDecodeStats,
  softwareHevcSupported,
  startSoftwareHevcDecoder,
} from "~/utils/hevcSoftwareClient";

/**
 * No Worker in this test environment, so every call here takes the
 * no-worker path — which is exactly the shape of failure this file guards:
 * a platform without module-worker support must reject cleanly rather than
 * throwing out of a `postMessage` call on a worker that was never created.
 */
describe("hevcSoftwareClient without Worker support", () => {
  it("reports itself unsupported", () => {
    expect(softwareHevcSupported()).toBe(false);
  });

  it("rejects instead of throwing when asked to start", async () => {
    await expect(
      startSoftwareHevcDecoder({
        onFrame: () => {},
        onError: () => {},
      }),
    ).rejects.toThrow(/unavailable/);
  });

  it("feed, reset and destroy are no-ops rather than throwing", async () => {
    expect(() => feedSoftwareHevc(new Uint8Array([0, 0, 0, 1]))).not.toThrow();
    await expect(resetSoftwareHevcDecoder()).resolves.toBeUndefined();
    expect(() => destroySoftwareHevcDecoder()).not.toThrow();
  });

  it("reports zeroed decode stats when no worker ever ran", () => {
    // feedSoftwareHevc() above is a no-op without a worker, so no "fed" ack
    // ever arrives to record a stat — this should read as empty, not throw
    // or divide by zero computing the average.
    expect(softwareHevcDecodeStats()).toEqual({
      feedCount: 0,
      avgDecodeMs: 0,
      maxDecodeMs: 0,
      avgAllocMs: 0,
      maxAllocMs: 0,
      avgMathMs: 0,
      maxMathMs: 0,
      avgPostMs: 0,
      maxPostMs: 0,
      framesOutCount: 0,
    });
  });
});
