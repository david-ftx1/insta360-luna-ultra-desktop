<script setup lang="ts">
/**
 * Experimental Deep Track overlay — draw a box on the live preview with the
 * mouse, the same gesture David filmed in the real Insta360 app (finger-drag
 * a rectangle, release). Enabling the experiment sends the leading candidate
 * for "open tracking" (code 217, once — see UPDATE below); release after a
 * drag sends "set the tracking box" (SET_PHOTOGRAPHY_OPTIONS option 94) —
 * see app/utils/trackingCandidates.ts for exactly what is and isn't
 * confirmed about those. Gated behind FEATURES.deepTrackExperiment by the
 * caller (app/pages/camera.vue); delete this file, useTracking.ts and
 * trackingCandidates.ts together if the experiment is abandoned.
 *
 * A second box colour was the original ask, for whatever the real app shows
 * once you let go: per close inspection of the iPhone screen recording, it
 * redraws its own green box around the detected subject (briefly a full
 * rectangle, then corner-bracket "locked on" markers) with a small "x" in
 * its *top-left* corner to cancel — see trackingCandidates.ts's doc comment,
 * correcting an earlier top-right assumption (this app's own amber cancel
 * button was positioned to match, back when it existed — see "REDESIGNED
 * 2026-10-20" below for why it doesn't any more). There still isn't a
 * second box drawn here from live data, though: DEEP_TRACK (PhotographyOptionType 91), the only
 * candidate STATUS field found so far, carries no coordinates and is
 * confirmed not to move even during genuine tracking use — see
 * useTracking.ts's lastStatus comment — and no camera -> phone notification
 * carrying coordinates has turned up in either capture so far, despite now
 * having real evidence (see trackingCandidates.ts) that candidate 237
 * correlates with actual small gimbal movement. The "recent notifications"
 * readout below keeps watching for a camera-sourced coordinate frame; until
 * one shows up, there's nothing here to decode into a second drawn box.
 *
 * UPDATE 2026-10-19: real per-packet timestamps from a second capture (see
 * trackingCandidates.ts's top comment) showed the real app doesn't send a
 * single open+set pair per drag — it sends open (217) once, well before any
 * box, then writes the box repeatedly for as long as tracking stays
 * engaged. Since it's unconfirmed which part of that actually matters,
 * useTracking.ts's `openOnEnable` and `boxWriteMode` let the two parts be
 * tried independently; the small controls in the debug readout below pick
 * them from the live overlay instead of this file hardcoding one guess.
 * A third control, "+ 237 per write", toggles useTracking.ts's
 * `sendTrackUserOps` — candidate 237, implemented 2026-10-19 and CONFIRMED
 * that same day to make the gimbal physically track (on by default as of
 * that result; see trackingCandidates.ts's top comment, "FIRST CONFIRMED
 * POSITIVE"). The notification readout further down also now labels a
 * handful of known-but-unexplained camera-initiated codes instead of
 * showing every one as bare numbers — see describeNotificationCode in that
 * same file.
 *
 * FIXED 2026-10-19: the "x" cancel button, and the openOnEnable/boxWriteMode
 * controls added just above, didn't actually work — clicking them did
 * nothing. Cause: `root`'s pointerdown handler (below) fires on *every*
 * pointerdown inside this component, including ones that start on a child
 * button, because only their `click` handlers had `.stop` — pointerdown
 * itself still bubbled up. `onPointerDown` then unconditionally calls
 * `root.setPointerCapture()`, which redirects that pointer's subsequent
 * events (including the click) to `root` instead of whatever was actually
 * under it. Root's own `onPointerUp` saw a near-zero-size "drag" (a click
 * is not a drag) and silently discarded it as a stray click, so the button
 * it started on never got its click at all. David first noticed this as
 * the cancel "x" not working — had to disable the whole experiment from
 * the navbar toggle instead, which doesn't go through this capturing root.
 * Fixed by adding `@pointerdown.stop` to both interactive children, same
 * pattern the cancel button's existing `@click.stop` already used — a
 * reminder that stopping `click` alone isn't enough once a parent captures
 * the pointer on `pointerdown`.
 *
 * UPDATE 2026-10-19 (later again): the "last sent box" overlay (since
 * removed — see "REDESIGNED 2026-10-20" below) staying put on screen while
 * the gimbal itself pans/tilts to bring the subject toward centre was
 * expected, not a bug — see
 * trackingCandidates.ts's "BOX OVERLAY IS STATIC / SNAP IS LIKELY
 * CLIENT-SIDE" note for the full writeup, including what it implies about
 * the real iOS app's own live "snap" box above almost certainly being
 * client-side rather than protocol-driven.
 *
 * UPDATE 2026-10-19 (later again): a new line, "camera reported: tracking
 * off", appears in the debug readout below when useTracking.ts's
 * `cameraConfirmedTrackingOff` flips true — code 8315, a strong candidate
 * for the camera's own close/cancel acknowledgment, found by correlating a
 * real iPhone-app capture against its screen recording. See
 * trackingCandidates.ts's top comment, "CODE 8315 = TRACK CLOSE/CANCEL
 * SIGNAL", for the evidence, and useTracking.ts's own comment on that state
 * for what's still unconfirmed (this app's *own* traffic hasn't been
 * checked against it yet — live use of this overlay is exactly that check).
 *
 * REDESIGNED 2026-10-20: the amber "last sent box" + its "x" (described
 * above and in trackingCandidates.ts/useTracking.ts's older comments) is
 * gone. David asked for the box to disappear once the camera's answered —
 * accepted or not, same either way — and for the single Deep Track button
 * in camera.vue's navbar to be the one place showing a lock (it turns
 * green — see useTracking.ts's `locked`) and the one way to cancel it
 * (clicking it while green, instead of this component's old "x" — see
 * camera.vue). What's drawn here now is only `pendingBoxStyle`, local to
 * this component and alive only for the moment a just-released drag is
 * actually in flight to the camera; `lastBox` itself still exists in
 * useTracking.ts (toggle() still needs it to know whether to auto-cancel on
 * switching the experiment off) but is deliberately not rendered here any
 * more.
 *
 * REMOVED ON-SCREEN DIAGNOSTICS, later the same day (2026-10-20): David
 * asked for every bit of debug text this component used to overlay on the
 * viewfinder — the "Deep Track (experimental)..." panel, the openOnEnable /
 * boxWriteMode / "+ 237 per write" controls, the sendState/lastError/
 * lastStatus lines, the cameraConfirmedTrackingOff and boxWriteConfirmed
 * readouts both described above, and the raw camera-notifications list —
 * gone, full stop. Every comment above that talks about "the debug readout
 * below" or a line that "appears in" it is describing what used to render
 * here, not what's in this file now. None of the state those lines read
 * was deleted, only the rendering of it: useTracking.ts still collects
 * `notifications`, still flips `cameraConfirmedTrackingOff` and
 * `boxWriteConfirmed`, `openOnEnable`/`boxWriteMode`/`sendTrackUserOps`
 * still drive real behaviour at their already-confirmed-good defaults (217
 * on enable, single box write, 237 alongside every write) — there's just no
 * longer a UI control or readout for any of it in this component. If this
 * experiment needs debugging again, that's the place to look; this file
 * now draws only the two transient boxes below and nothing else.
 */

import type { TrackingBox } from "~/utils/trackingCandidates";

const props = defineProps<{
  /** Reads the live view's current decoded-frame resolution, so a drawn box
   * can be converted out of the `object-contain` letterboxed display back
   * into the camera's own 0..1 coordinate space. Null while no frame has
   * decoded yet. */
  getIntrinsicSize: () => { width: number; height: number } | null;
}>();

/** Just the two things this component still needs since the debug readout
 * came out — see this file's top comment, "REMOVED ON-SCREEN DIAGNOSTICS".
 * Everything else useTracking.ts tracks (lastBox, sendState, notifications,
 * boxWriteConfirmed, ...) still exists there; this file just doesn't read
 * it any more. */
const { enabled, sendBox } = useTracking();

const root = useTemplateRef<HTMLDivElement>("root");

interface DragState {
  startX: number;
  startY: number;
  curX: number;
  curY: number;
}
const drag = ref<DragState | null>(null);

/** A drag shorter than this, in normalised units, is treated as a stray
 * click rather than a drawn box. */
const MIN_BOX = 0.03;
/** Fallback box size (the captured, fixed 0.1581 x 0.2811) for drawing the
 * pending-box marker when a send didn't carry its own w/h. */
const DEFAULT_W = 0.1581;
const DEFAULT_H = 0.2811;

/** The live view's content rect within `root`, accounting for its own
 * `object-contain` letterboxing — a drawn box means nothing without this. */
function contentRect(): { left: number; top: number; width: number; height: number } | null {
  const el = root.value;
  const size = props.getIntrinsicSize();
  if (!el || !size || size.width === 0 || size.height === 0) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const containerAspect = rect.width / rect.height;
  const videoAspect = size.width / size.height;
  if (videoAspect > containerAspect) {
    const width = rect.width;
    const height = width / videoAspect;
    return { left: 0, top: (rect.height - height) / 2, width, height };
  }
  const height = rect.height;
  const width = height * videoAspect;
  return { left: (rect.width - width) / 2, top: 0, width, height };
}

function clientToNormalized(clientX: number, clientY: number): { x: number; y: number } | null {
  const el = root.value;
  const content = contentRect();
  if (!el || !content || content.width === 0 || content.height === 0) return null;
  const rect = el.getBoundingClientRect();
  const x = (clientX - rect.left - content.left) / content.width;
  const y = (clientY - rect.top - content.top) / content.height;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

function onPointerDown(event: PointerEvent) {
  if (!enabled.value) return;
  const point = clientToNormalized(event.clientX, event.clientY);
  if (!point) return;
  drag.value = { startX: point.x, startY: point.y, curX: point.x, curY: point.y };
  root.value?.setPointerCapture(event.pointerId);
}

function onPointerMove(event: PointerEvent) {
  if (!drag.value) return;
  const point = clientToNormalized(event.clientX, event.clientY);
  if (!point) return;
  drag.value = { ...drag.value, curX: point.x, curY: point.y };
}

/** The box this component just released, shown only while its write to the
 * camera is actually in flight — see this file's top comment, "REDESIGNED
 * 2026-10-20". Cleared in a `finally` so it disappears whether the camera
 * confirmed the write or not; which of those happened is now the navbar
 * button's job to show (useTracking.ts's `locked`), not this box's. */
const pendingBox = ref<TrackingBox | null>(null);

async function onPointerUp() {
  if (!drag.value) return;
  const { startX, startY, curX, curY } = drag.value;
  drag.value = null;
  const w = Math.abs(curX - startX);
  const h = Math.abs(curY - startY);
  if (w < MIN_BOX || h < MIN_BOX) return;
  const box = { x: (startX + curX) / 2, y: (startY + curY) / 2, w, h };
  pendingBox.value = box;
  try {
    await sendBox(box);
  } finally {
    pendingBox.value = null;
  }
}

/** The box being drawn right now, in container-pixel space. */
const dragBoxStyle = computed(() => {
  if (!drag.value) return null;
  const content = contentRect();
  if (!content) return null;
  const left = content.left + Math.min(drag.value.startX, drag.value.curX) * content.width;
  const top = content.top + Math.min(drag.value.startY, drag.value.curY) * content.height;
  const width = Math.abs(drag.value.curX - drag.value.startX) * content.width;
  const height = Math.abs(drag.value.curY - drag.value.startY) * content.height;
  return { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` };
});

/** `pendingBox`, in container-pixel space — see this file's top comment.
 * Shares its shape with `dragBoxStyle` above by design: same box, just past
 * the point where dragging stopped and the camera's answer is what's
 * pending now. */
const pendingBoxStyle = computed(() => {
  if (!pendingBox.value) return null;
  const content = contentRect();
  if (!content) return null;
  const { x, y, w = DEFAULT_W, h = DEFAULT_H } = pendingBox.value;
  const left = content.left + (x - w / 2) * content.width;
  const top = content.top + (y - h / 2) * content.height;
  return {
    left: `${left}px`,
    top: `${top}px`,
    width: `${w * content.width}px`,
    height: `${h * content.height}px`,
  };
});
</script>

<template>
  <div
    ref="root"
    class="absolute inset-0"
    :class="enabled ? 'cursor-crosshair touch-none' : 'pointer-events-none'"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
  >
    <!-- Box being drawn right now -->
    <div
      v-if="dragBoxStyle"
      class="pointer-events-none absolute border-2 border-cyan-400 bg-cyan-400/10"
      :style="dragBoxStyle"
    />

    <!-- Box just released, while its write to the camera (candidate set-box,
         SET_PHOTOGRAPHY_OPTIONS/94) is in flight — gone again as soon as
         that resolves, confirmed or not; see this file's top comment,
         "REDESIGNED 2026-10-20". No cancel control here any more — that's
         the single Deep Track button in camera.vue's navbar now. -->
    <div
      v-if="pendingBoxStyle && !dragBoxStyle"
      class="pointer-events-none absolute border-2 border-amber-400"
      :style="pendingBoxStyle"
    />
  </div>
</template>
