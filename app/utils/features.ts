/**
 * Feature flags for work that isn't ready to ship.
 *
 * Each flag defaults to `import.meta.dev`, so in-development features stay
 * visible while running `nuxt dev` / `tauri dev` but are hidden in the packaged
 * release build (`tauri build` → `nuxt generate`, where `import.meta.dev` is
 * false). Hard-code a flag to `true`/`false` to force it in any build.
 */
export const FEATURES = {
  /**
   * Capture modes beyond Video and Photo (Pure, Slow-mo, Pano, Pano HDR,
   * Timelapse). Kept back until each is verified on-device.
   */
  extraCaptureModes: true,

  /**
   * The Color Mode picker (Standard / i-Log / Dolby Vision). `color_mode` was
   * the right lever all along; what was wrong was its numbering, which firmware
   * v1.0.238 shifted away from the vendored schema (see the COLOR_MODE override
   * in scripts/build-schema.mjs).
   */
  colorMode: true,

  /**
   * The full settings panel — every option the camera acknowledges, reachable
   * from MORE in the pro bar and the sliders button in the header.
   *
   * Off. Most of those controls have never been exercised on-device, and the
   * two that were checked properly (colour mode, filters) both turned out to be
   * writing wrong values against a stale schema while reporting success. Until
   * each one is verified the same way, a panel of confident-looking controls
   * that quietly do the wrong thing is worse than no panel.
   *
   * Both entry points are gated together — leaving one open would defeat it.
   */
  allSettings: false,

  /**
   * Deep Track overlay — draw a box on the live preview to try the
   * unconfirmed subject-tracking candidates (TrackingOverlay.vue,
   * useTracking.ts, utils/trackingCandidates.ts). Unlike allSettings, this
   * isn't hiding a control that's known to misbehave — it's an openly
   * experimental probe that labels itself as such everywhere it appears
   * (the overlay's own readout, every doc comment in trackingCandidates.ts).
   *
   * Was `import.meta.dev` — a protocol prober that sends unconfirmed raw
   * commands to real hardware has no business in a packaged release build,
   * however harmless it's been so far. Hard-coded to `true` as of
   * 2026-10-20: David confirmed `tauri build`/`build:no-log` (see
   * package.json) is now his day-to-day build going forward, not just
   * `tauri dev --release`, and he wants Deep Track available there too. If
   * that changes back, flip this to `import.meta.dev` to restore the
   * dev-only gate, or to `false` to pull it from every build without
   * removing any files. Still gated at runtime behind its own on/off toggle
   * in the camera page header either way, so even here it sends nothing
   * until a person also switches it on. See docs/PROTOCOL-GAP.md's
   * "Subject tracking" section for what is and isn't known, or delete the
   * files themselves (trackingCandidates.ts's own comment lists all of
   * them) if the experiment is abandoned for good.
   */
  deepTrackExperiment: true,
} as const;
