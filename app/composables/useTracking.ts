import { readPhotographyOption } from "~/utils/lunaSettings";
import {
  checkBoxWriteConfirmed,
  checkTrackClosedNotification,
  sendCloseTrackingCandidate,
  sendOpenTrackingCandidate,
  sendTrackingBoxCandidate,
  sendTrackUserOpsCandidate,
  type TrackingBox,
} from "~/utils/trackingCandidates";
import { FRAMING_POINTS, sendTrackingFramingCandidate } from "~/utils/trackingFraming";
import { getCameraTransport } from "~/utils/transport";

export type TrackingSendState = "idle" | "sending" | "sent" | "error";

/** Index of the middle point in FRAMING_POINTS (row-major, 0..8) — the
 * default the camera reported before any pick; see trackingFraming.ts. */
const FRAMING_CENTRE_INDEX = 4;

export interface TrackingNotification {
  code: number;
  requestId: number;
  bodyHex: string;
}

/** Keeps the debug readout from growing without bound across a long session. */
const MAX_NOTIFICATIONS = 20;

/** Set once a listener is attached, so toggling on/off repeatedly doesn't pile up handlers. */
let unlistenNotifications: (() => void) | null = null;

/**
 * The "sustained" box-write mode's resend timer — module-level for the same
 * reason as `unlistenNotifications` above: sendBox()/cancel()/toggle() can
 * run in any order from the UI, and this guarantees there's never more than
 * one resend loop alive at once, however they're called.
 */
let sustainTimer: ReturnType<typeof setInterval> | null = null;

function clearSustainTimer() {
  if (sustainTimer) {
    clearInterval(sustainTimer);
    sustainTimer = null;
  }
}

/** How many times, and how far apart, "burst" mode repeats a box write. */
const BURST_COUNT = 3;
const BURST_SPACING_MS = 150;
/** How often "sustained" mode re-sends the current box while tracking stays
 * on. ~2s sits in the 1-3s cadence the real app's own traffic showed for its
 * own continued box writes — see trackingCandidates.ts's top comment. */
const SUSTAIN_INTERVAL_MS = 2000;

/**
 * FOUND 2026-10-20: David reported seeing "camera reported: tracking off"
 * (code 8315) exactly once, on the very first stop-tracking try, then never
 * again on any retry. Root cause — a race, not a logging gap (there's no
 * persistent log of these; see this constant's own use below): `cancel()`'s
 * `await sendCloseTrackingCandidate()` only waits for CLOSE_TRACKING (238)'s
 * own direct, matched reply. Code 8315 is a separate, later push from the
 * camera — trackingCandidates.ts's "CODE 8315" note measured it arriving
 * 0-1s *after* that reply, over the real app's own traffic. `toggle()` used
 * to disable notification capture (both the Rust-side `notify_unmatched`
 * flag and this file's event listener) the instant `cancel()` resolved —
 * almost always before that trailing 8315 push arrived, so the reader loop
 * silently dropped it (see luna.rs's `notify_unmatched` check). The one
 * sighting was luck: whatever extra latency was in play that first time let
 * the push sneak in ahead of the disable call; every retry since, the
 * disable consistently won the race. Fix: keep capture on for this long
 * after switching off before actually disabling it, so the trailing push
 * has room to land. Comfortably above the measured 0-1s window.
 */
const DISABLE_CAPTURE_GRACE_MS = 2500;

/** Set while a delayed capture-disable (see DISABLE_CAPTURE_GRACE_MS above)
 * is pending, so switching tracking back on before it fires can cancel it
 * instead of having it cut capture out from under the new session. */
let disableCaptureTimer: ReturnType<typeof setTimeout> | null = null;

function clearDisableCaptureTimer() {
  if (disableCaptureTimer) {
    clearTimeout(disableCaptureTimer);
    disableCaptureTimer = null;
  }
}

/** Set once the camera-disconnect watcher below has been installed, so
 * calling useTracking() from a second component (camera.vue and
 * TrackingOverlay.vue both do) can't attach it twice. */
let disconnectWatcherInstalled = false;

/**
 * State and actions for the experimental Deep Track overlay
 * (TrackingOverlay.vue). Entirely separate from useCameraSettings/
 * useLiveView — nothing outside this file and TrackingOverlay.vue depends on
 * it, so both can be deleted together. See app/utils/trackingCandidates.ts
 * for exactly what is (and is not) confirmed about what this sends, and its
 * doc comment specifically for why `notifications` below exists: the box
 * "snapping" David saw in the real app's screen recording could be the
 * phone's own tracking pushing an updated box to the camera, or the camera
 * reporting its own result back — the capture this toggles on is how to
 * tell those apart empirically instead of guessing.
 *
 * UPDATE 2026-10-19: real per-packet timestamps from a second capture (see
 * trackingCandidates.ts's top comment) showed the real app's own traffic
 * isn't a single open-then-set pair per box: it sends OPEN_TRACKING_
 * CANDIDATE (217) once, well before any box is drawn, then writes the box
 * repeatedly — once at set, then roughly every 1-3s for as long as tracking
 * stays engaged. `openOnEnable` and `boxWriteMode` below let David try those
 * parts of the pattern independently from the live overlay (is 217 even
 * necessary? does repeating the write matter?) instead of this file locking
 * in one guessed-at combination in code.
 *
 * UPDATE 2026-10-19: candidate 237 — the one candidate anywhere in this
 * investigation with a measured (if small-sample) physical correlation, see
 * trackingCandidates.ts's top comment — is now implemented and wired in here
 * as its own `sendTrackUserOps` toggle. Deliberately not merged into
 * `boxWriteMode`: which candidate rides each write and how often the write
 * repeats are separate experiments.
 *
 * UPDATE 2026-10-19 (later the same day): CONFIRMED POSITIVE — David watched
 * the gimbal physically track him with `sendTrackUserOps` on (see its own
 * comment below for the full result). `sendTrackUserOps` now defaults to
 * true.
 *
 * UPDATE 2026-10-19 (later still): `boxWriteMode` now defaults to "single"
 * instead of "sustained" — David found "single" much more reliable in a
 * back-to-back live comparison. See `boxWriteMode`'s own comment below and
 * trackingCandidates.ts's top comment ("SINGLE VS SUSTAINED") for the full
 * result and caveats.
 *
 * UPDATE 2026-10-19 (later again): David asked whether the camera ever
 * acknowledges tracking being switched off. Answer, from correlating a
 * capture of the real iPhone app against its screen recording: a strong
 * candidate, code 8315 — see trackingCandidates.ts's top comment, "CODE
 * 8315 = TRACK CLOSE/CANCEL SIGNAL", for the full evidence. `checkTrack
 * ClosedNotification` and `cameraConfirmedTrackingOff` below wire that up
 * so the debug readout can show it live instead of only logging it to
 * `notifications`. This has NOT yet been confirmed against this app's own
 * traffic — see `cameraConfirmedTrackingOff`'s own comment for what would
 * close that gap.
 *
 * UPDATE 2026-10-20: David saw code 8315 exactly once, then never again on
 * retry — not a missing log (none of this is written to disk; see below),
 * a real race in `toggle()`'s off-path, now fixed. See
 * DISABLE_CAPTURE_GRACE_MS's own comment for the full story. This app's own
 * traffic still hasn't *confirmed* 8315 the way trackingCandidates.ts's
 * pcap/video correlation did — that one sighting arrived outside this race
 * window by luck, not because capture was reliably catching it — so this is
 * still open, now that the race isn't masking retries.
 */
export function useTracking() {
  const { mode } = useCameraSettings();

  const enabled = useState<boolean>("tracking-enabled", () => false);
  const sendState = useState<TrackingSendState>("tracking-send-state", () => "idle");
  const lastError = useState<string | null>("tracking-error", () => null);
  /** The box actually sent to the camera, for the overlay to draw. */
  const lastBox = useState<TrackingBox | null>("tracking-last-box", () => null);
  /**
   * Raw DEEP_TRACK (PhotographyOptionType 91) read-back after the last send,
   * for the debug readout only. CONFIRMED unreliable: in the real app's own
   * capture this field did not change even once, including across genuine
   * tracking use. Shown for visibility into the raw bytes — never read this
   * as a verdict on whether a send worked. The only signal that has held up
   * so far is physical: does the camera body pan/tilt to follow a moving
   * subject.
   */
  const lastStatus = useState<Record<string, unknown> | null>("tracking-last-status", () => null);
  /**
   * Raw, undecoded frames the camera sent that weren't a response to
   * anything we asked for — see utils/transport.ts's
   * setNotificationCapture/onTrackingNotification and
   * src-tauri/src/luna.rs's UnmatchedNotification. Empty unless/until the
   * camera ever actually pushes something; see trackingCandidates.ts's doc
   * comment for why that's an open question, not an assumption either way.
   */
  const notifications = useState<TrackingNotification[]>("tracking-notifications", () => []);
  /**
   * The first real camera-reported tracking status this investigation has
   * had — null until a notification arrives that looks like the "tracking
   * stopped" signal documented in trackingCandidates.ts's top comment,
   * "CODE 8315 = TRACK CLOSE/CANCEL SIGNAL" (code 8315, correlated there
   * against four real CLOSE_TRACKING sends and their matching screen
   * recording), true once one does. Reset to null whenever this app sends
   * something that would re-engage tracking (toggling the experiment on,
   * or writing a new box in sendBox()) — correct, not pessimistic: once a
   * new attempt starts, the last "off" confirmation no longer describes the
   * current state, and this should go back to "don't know" rather than keep
   * showing stale confidence.
   *
   * CONFIRMED 2026-10-20 against this app's own traffic: with capture left
   * on continuously (Deep Track enabled the whole time, only `cancel()`
   * invoked per attempt), David saw this flip true on 5 of 6 tries in one
   * session — see trackingCandidates.ts's "CODE 8315" note for that result
   * and what's still open about the 1 miss (a different code, or nothing
   * at all; `notifications` below would show which, if captured). Earlier
   * misses before that session had a separate, now-fixed cause — see
   * DISABLE_CAPTURE_GRACE_MS below.
   */
  const cameraConfirmedTrackingOff = useState<boolean | null>(
    "tracking-camera-confirmed-off",
    () => null,
  );
  /**
   * FOUND 2026-10-20: a 4-attempt controlled retest (toggle off, toggle on,
   * draw one large box, repeat) where David saw 2 of the 4 draws engage
   * tracking and 2 didn't — with code 9 and code 237 both sent, and both
   * acked with a plain 200, in every single attempt. The real tell turned
   * out to be the code-9 reply's own body: `checkBoxWriteConfirmed` (see
   * trackingCandidates.ts) is true only when it echoes back `08 5e`
   * (option 94 confirmed) rather than coming back empty under that same 200.
   * That split matched the reported 2-worked/2-didn't exactly — see
   * trackingCandidates.ts's top comment, "FOUND 2026-10-20", for the full
   * writeup including the two later signals (8317, 8315) that independently
   * agree. Unlike cameraConfirmedTrackingOff above, this needs no grace
   * period and no separate push notification: it's set synchronously from
   * writeBoxOnce()'s own await, so it's the earliest signal this file has
   * of whether a given write actually took. Reset to null whenever a new
   * attempt starts (sendBox()) or tracking is cancelled, same reasoning as
   * cameraConfirmedTrackingOff's reset.
   */
  const boxWriteConfirmed = useState<boolean | null>("tracking-box-write-confirmed", () => null);
  /**
   * REDESIGNED 2026-10-20: David asked for the single Deep Track button in
   * camera.vue's navbar to be the one place that shows and controls a real
   * lock, instead of a drawn box staying on screen with its own "x" — see
   * TrackingOverlay.vue's top comment for the removed affordance this
   * replaces. `locked` is true only once a box write actually got the
   * camera's confirmation (boxWriteConfirmed above), not just "the
   * draw-a-box surface is switched on" (`enabled` alone, which the button
   * already showed amber for before today). camera.vue colours the button
   * from this directly, and decides to call `cancel()` instead of `toggle()`
   * when clicking it while this is true — see that file for the full
   * click-handling split. No separate bookkeeping: this just reads
   * `boxWriteConfirmed`, so anything that resets that (a new sendBox(),
   * cancel(), or switching the experiment off) takes this back to false on
   * its own.
   */
  const locked = computed(() => enabled.value && boxWriteConfirmed.value === true);
  /**
   * ADDED 2026-10-21: Tracking Framing — the iPhone app's 3x3 "preset tracking
   * point" picker (TrackingFramingPicker.vue; read app/utils/trackingFraming.ts
   * for what is and isn't known). `framingIndex` is 0..8 row-major, or null
   * for "nothing chosen" (the camera's own default — the capture's code-245
   * read-back suggests the frame centre, see trackingFraming.ts). `framingNote`
   * is non-null when the last choice did NOT reach the camera, with the reason
   * to show. Cleared whenever the
   * lock lets go (cancel(), or toggle() switching off): a framing choice
   * describes one lock, and whether the camera itself remembers it across locks
   * is unknown.
   */
  const framingIndex = useState<number | null>("tracking-framing-index", () => null);
  const framingPickerOpen = useState<boolean>("tracking-framing-picker-open", () => false);
  const framingNote = useState<string | null>("tracking-framing-note", () => null);

  function resetFraming() {
    framingIndex.value = null;
    framingPickerOpen.value = false;
    framingNote.value = null;
  }

  function openFramingPicker() {
    framingPickerOpen.value = true;
  }

  function closeFramingPicker() {
    framingPickerOpen.value = false;
  }

  /** Record the chosen point and send it to the camera (code 244). The picker
   * stays OPEN, as the iPhone app's does — its recording shows nine picks back
   * to back inside one open picker — so the person closes it themselves. A
   * failed send never undoes the local choice; the chip shows it either way,
   * with `framingNote` saying why. */
  async function selectFraming(index: number) {
    const point = FRAMING_POINTS[index];
    if (!point) return;
    framingIndex.value = index;
    framingNote.value = null;
    try {
      const result = await sendTrackingFramingCandidate(point);
      framingNote.value = result.sent ? null : (result.reason ?? "Not sent to the camera.");
    } catch (cause) {
      framingNote.value = cause instanceof Error ? cause.message : String(cause);
    }
  }

  /** Send candidate OPEN_TRACKING (217) once, when the experiment is switched
   * on — matching where the real app's own traffic actually put it (well
   * before any box, not per-drag; see this file's top comment). Off lets you
   * test whether 217 matters at all, since its timing alone didn't confirm
   * that it does. */
  const openOnEnable = useState<boolean>("tracking-open-on-enable", () => true);
  /** How a drawn box gets written to the camera — three candidates for the
   * part of the real app's pattern that's still unconfirmed:
   *  - "single": one SET_PHOTOGRAPHY_OPTIONS/94 write. This project's
   *    original guess, before the real traffic was decoded closely.
   *  - "burst": the same write repeated a few times in quick succession.
   *  - "sustained": one write, then a resend every ~2s for as long as
   *    tracking stays on and the box doesn't change — the closest replica of
   *    what the real app's own traffic actually looked like.
   *
   * SINGLE VS SUSTAINED, 2026-10-19: with openOnEnable and sendTrackUserOps
   * both on, David tried "single" and "sustained" back to back in the same
   * live session and called "single" much more reliable — see
   * trackingCandidates.ts's top comment for the full note and its caveats
   * (one person's live comparison, not a counted trial). Defaults to
   * "single" as of this result — previously "sustained", on the assumption
   * that matching the real app's own observed resend behaviour was the safer
   * choice. That assumption hasn't held up so far; repeating the write on a
   * timer has shown no observed advantage.
   */
  const boxWriteMode = useState<"single" | "burst" | "sustained">(
    "tracking-box-write-mode",
    () => "single",
  );
  /** Also send candidate 237 (PHONE_COMMAND_TRACK_USER_OPS) alongside every
   * option-94 box write this session's `boxWriteMode` triggers — once per
   * single write, once per burst repeat, once per sustained tick. A separate
   * toggle from `boxWriteMode` on purpose: which candidate to send (94 vs
   * 237) and how often to resend it are different questions.
   *
   * CONFIRMED POSITIVE, 2026-10-19: with this on (and openOnEnable + sustained
   * box writes), David watched the gimbal physically track him — the first
   * real positive result anywhere in this investigation, and the only
   * variable that changed from an earlier same-day run (same other settings)
   * that produced confirmed zero movement. Defaults to true as of this
   * result — previously false, back when 237 was unconfirmed and brand new
   * to this app. See trackingCandidates.ts's top comment, "FIRST CONFIRMED
   * POSITIVE", for the full writeup and what's still unisolated (whether 94's
   * sustained resend is even still needed once 237 is in play, or whether
   * 237 alone would do it). */
  const sendTrackUserOps = useState<boolean>("tracking-send-track-user-ops", () => true);

  /**
   * FIXED 2026-10-20 (later the same day): David's report — "a swift
   * disconnect and reconnect still has the tracking button in green" —
   * turned out not to be a timing race at all, and David confirmed what he
   * means by "disconnect": clicking the Disconnect button, which lives on
   * index.vue/settings.vue, never on camera.vue. This watcher used to live
   * in camera.vue's own <script setup>, as a plain `watch(isConnected,
   * ...)` — but a component-scoped watch is torn down the instant its
   * component unmounts. Lock tracking on the camera page, navigate to the
   * home page, hit Disconnect then Connect, and camera.vue was unmounted
   * for the entire round trip: nothing was listening, so `enabled`/
   * `boxWriteConfirmed` never got reset, and the button came back green on
   * the next visit to /camera because `locked` had never stopped being
   * true. Any disconnect-and-reconnect done from off this page reproduced
   * it, "swift" or not — the speed was never the variable.
   *
   * Fix: moved here and installed once, in a detached effect scope
   * (`effectScope(true)` — explicitly not tied to whichever component
   * happens to call `useTracking()` first, so unmounting it doesn't stop
   * this), so it keeps watching `useCamera().isConnected` for the lifetime
   * of the app regardless of which page (if any) is currently mounted.
   * Guarded by `disconnectWatcherInstalled` above so a second component
   * calling `useTracking()` doesn't attach a second copy.
   */
  if (!disconnectWatcherInstalled) {
    disconnectWatcherInstalled = true;
    effectScope(true).run(() => {
      const { isConnected } = useCamera();
      watch(
        isConnected,
        (connected) => {
          if (!connected && enabled.value) void toggle();
        },
        { immediate: true },
      );

      /**
       * ADDED 2026-10-21: David asked that switching the capture mode (the
       * Video / Pure / Slow-mo / Photo / Pano / Timelapse strip) switch Deep
       * Track off completely and put the framing selector back to the middle.
       * Watches the same `camera-capture-mode` state useCameraCapture.ts owns
       * (not a call to useCameraCapture(), which would also start its status
       * poll) — it changes both when the strip is clicked and when the camera
       * reports a mode change itself, and it covers Video <-> Pure, which share
       * one function mode and so would be missed by watching that instead.
       * Lives in this detached scope for the same reason the disconnect
       * watcher above does: it must keep working when the camera page isn't
       * mounted.
       *
       * Tracking off goes through toggle() — the same path as the button, so
       * the lock, the box and the picker are all cleared and the camera is
       * told to close tracking if a box had been sent. Then the selector is
       * set to the centre point. If a non-centre point had been sent to the
       * camera, centre is also sent (code 244, best effort — a failure is
       * ignored): whether the camera itself remembers a pick across a lock,
       * or a mode change, is unknown, so this doesn't assume it forgets.
       * Nothing at all is sent when no custom point was ever picked.
       */
      const modeId = useState<string>("camera-capture-mode", () => "video");
      watch(modeId, () => {
        const sentCustomPoint =
          framingIndex.value !== null && framingIndex.value !== FRAMING_CENTRE_INDEX;
        if (enabled.value) void toggle();
        framingIndex.value = FRAMING_CENTRE_INDEX;
        const centre = FRAMING_POINTS[FRAMING_CENTRE_INDEX];
        if (sentCustomPoint && centre) void sendTrackingFramingCandidate(centre).catch(() => {});
      });
    });
  }

  /**
   * Turning the overlay off also cancels an in-flight candidate box, so
   * switching this feature off doesn't silently leave the camera (if any of
   * this turns out to do anything at all) straddling a half-open tracking
   * attempt. Also starts/stops the raw notification capture above, so it
   * only ever runs while this experiment is actually switched on, and sends
   * candidate open (217) once per `openOnEnable`, not per box — see this
   * file's top comment for why that moved here from sendBox().
   *
   * FIXED 2026-10-20: the off-branch used to `await cancel()` — which sends
   * CLOSE_TRACKING (238) and waits for a reply — *before* setting
   * `enabled.value = false`. This came up because the disconnect watcher
   * above calls this same function: if the camera is already gone when that
   * fires, `sendCloseTrackingCandidate()` doesn't fail fast, it sits on
   * `luna_command`'s own 10s timeout (src-tauri/src/luna.rs) before the
   * `.catch` even runs — and `enabled`, so `locked` too, stayed true that
   * whole time. Fixed by flipping `enabled.value` (and, mirroring cancel()'s
   * own fix just below, `lastBox`/`boxWriteConfirmed`/`sendState`/
   * `lastError`) synchronously, first, with no await in between — this is
   * the one path where "off" has to look instant even if the camera never
   * answers at all. The close send itself still goes out, just as a
   * fire-and-forget best effort afterward, exactly where it used to: if the
   * camera's actually still there, it still gets told; if it's gone,
   * there's nothing left to tell and nothing here waits around to find out.
   */
  async function toggle() {
    const next = !enabled.value;
    const hadBox = !next && Boolean(lastBox.value);
    clearSustainTimer();
    enabled.value = next;
    const transport = getCameraTransport();
    if (next) {
      clearDisableCaptureTimer();
      notifications.value = [];
      cameraConfirmedTrackingOff.value = null;
      if (!unlistenNotifications && transport.onTrackingNotification) {
        unlistenNotifications = await transport.onTrackingNotification((notification) => {
          notifications.value = [notification, ...notifications.value].slice(0, MAX_NOTIFICATIONS);
          if (checkTrackClosedNotification(notification.code, notification.bodyHex).isCandidate) {
            cameraConfirmedTrackingOff.value = true;
          }
        });
      }
      if (transport.setNotificationCapture) {
        await transport.setNotificationCapture(true).catch(() => {});
      }
      if (openOnEnable.value) {
        await sendOpenTrackingCandidate().catch(() => {});
      }
    } else {
      sendState.value = "idle";
      lastError.value = null;
      lastBox.value = null;
      boxWriteConfirmed.value = null;
      resetFraming();
      if (hadBox) {
        sendCloseTrackingCandidate().catch(() => {});
      }
      // Delayed, not immediate — see DISABLE_CAPTURE_GRACE_MS above: the
      // camera's own async "tracking closed" push (code 8315) lands after
      // this point, and turning capture off right away was losing it.
      clearDisableCaptureTimer();
      disableCaptureTimer = setTimeout(() => {
        disableCaptureTimer = null;
        if (transport.setNotificationCapture) {
          transport.setNotificationCapture(false).catch(() => {});
        }
        unlistenNotifications?.();
        unlistenNotifications = null;
      }, DISABLE_CAPTURE_GRACE_MS);
    }
  }

  async function refreshStatus() {
    try {
      const value = await readPhotographyOption(mode.value, "DEEP_TRACK");
      lastStatus.value = (value.deep_track as Record<string, unknown> | undefined) ?? null;
    } catch {
      // Debug-only readout; a failed status read must not block the send flow.
    }
  }

  /** One write of `box`, per `sendTrackUserOps`: always the option-94
   * candidate; also candidate 237 when that toggle is on. Shared by the
   * initial send below and every burst/sustained repeat, so the two
   * candidates always ride the same cadence instead of drifting apart. A
   * 237 failure never aborts the write — it's the newer, less-trusted
   * candidate riding alongside the one already confirmed to not error. */
  async function writeBoxOnce(box: TrackingBox): Promise<void> {
    const response = await sendTrackingBoxCandidate(box);
    boxWriteConfirmed.value = checkBoxWriteConfirmed(response);
    if (sendTrackUserOps.value) {
      await sendTrackUserOpsCandidate(box).catch(() => {});
    }
  }

  /** Draw a box and write it to the camera per `boxWriteMode`. Candidate
   * open (217) is no longer sent here — `toggle()` already sent it (if at
   * all) when the experiment was switched on, matching the real app's own
   * timing instead of this project's original per-drag guess. */
  async function sendBox(box: TrackingBox) {
    clearSustainTimer();
    sendState.value = "sending";
    lastError.value = null;
    cameraConfirmedTrackingOff.value = null;
    boxWriteConfirmed.value = null;
    try {
      await writeBoxOnce(box);
      lastBox.value = box;
      sendState.value = "sent";
      await refreshStatus();

      if (boxWriteMode.value === "burst") {
        for (let i = 1; i < BURST_COUNT; i++) {
          await new Promise((resolve) => setTimeout(resolve, BURST_SPACING_MS));
          await writeBoxOnce(box).catch(() => {});
        }
      } else if (boxWriteMode.value === "sustained") {
        sustainTimer = setInterval(() => {
          writeBoxOnce(box).catch(() => {});
        }, SUSTAIN_INTERVAL_MS);
      }
    } catch (cause) {
      lastError.value = cause instanceof Error ? cause.message : String(cause);
      sendState.value = "error";
    }
  }

  /** The Deep Track button's click-while-locked path (camera.vue's
   * `handleTrackingClick`) — candidate close/cancel (238). Also stops a
   * "sustained" write loop, if one from a previous box is still running.
   *
   * FIXED 2026-10-20: same bug as `toggle()` above, same fix. This used to
   * `await sendCloseTrackingCandidate()` — another `luna_command` round
   * trip sitting behind the same 10s timeout (src-tauri/src/luna.rs) —
   * before clearing `lastBox`/`boxWriteConfirmed`, so cancelling a lock
   * against a camera that had just gone unreachable left the button
   * looking locked for up to 10s, same symptom David reported for the
   * disconnect-watcher path even though that report was specifically about
   * `toggle()`. Fixed the same way: flip `lastBox`/`boxWriteConfirmed`/
   * `sendState`/`lastError` synchronously first — the lock has to let go
   * instantly, whether or not the camera is still there to tell — then send
   * CLOSE_TRACKING as fire-and-forget afterward.
   */
  function cancel() {
    clearSustainTimer();
    lastError.value = null;
    lastBox.value = null;
    boxWriteConfirmed.value = null;
    sendState.value = "idle";
    resetFraming();
    sendCloseTrackingCandidate()
      .then(() => refreshStatus())
      .catch((cause) => {
        lastError.value = cause instanceof Error ? cause.message : String(cause);
      });
  }

  return {
    enabled,
    sendState,
    lastError,
    lastBox,
    lastStatus,
    notifications,
    cameraConfirmedTrackingOff,
    boxWriteConfirmed,
    locked,
    openOnEnable,
    boxWriteMode,
    sendTrackUserOps,
    framingIndex,
    framingPickerOpen,
    framingNote,
    openFramingPicker,
    closeFramingPicker,
    selectFraming,
    toggle,
    sendBox,
    cancel,
  };
}
