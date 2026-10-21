import { sendSetTrackingFramingCandidate } from "~/utils/trackingCandidates";

/**
 * Tracking Framing — the 3x3 "preset tracking point" picker from the real
 * Insta360 iPhone app (TrackingFramingPicker.vue).
 *
 * WHAT THE REAL APP DOES (screenshots + screen recording, 2026-10-21): while
 * tracking is on, a small square-with-a-dot icon appears near the top-left of
 * the live view. Tapping it opens a "Tracking Framing" screen — "Tap the white
 * box to select a preset tracking point" — with nine small white boxes in a 3x3
 * grid. The screen STAYS OPEN across picks (the recording shows nine picks
 * back to back inside one open picker, then it closes ~2s after the last).
 * Picking a box turns it into a green marker on the subject and the gimbal
 * moves so the subject sits at that point.
 *
 * WHAT THE CAMERA IS SENT — CONFIRMED FROM A CAPTURE (Tracking_points_Full.pcapng,
 * 2026-10-21, iPhone app -> camera, matched against its screen recording; the
 * recording runs ~11.5s behind the packet clock, and with that offset every
 * pick lines up): one frame per pick, UCD2 file-type, message code 244, empty
 * of anything but this body — the same layout as code 237:
 *   field 1 (varint)  = millisecond Unix timestamp
 *   fields 2-5 (f32) = x, y, w, h
 * x, y are the box's TOP-LEFT corner, not its centre: the middle pick's
 * x + w/2, y + h/2 is (0.50005, 0.50005) — exactly the frame centre — and the
 * nine centres this gives match the box positions measured off the screenshot
 * to within about 1%. w and h are constant, 0.0605 x 0.1075, which on a 16:9
 * frame is a square (0.0605 * 16 = 0.1075 * 9 = 0.968). Picks went in row-major
 * order (top-left, top-centre, ... bottom-right); the camera answered each
 * with a plain 200, empty body, and pushed no notification afterwards.
 *
 * Also in that capture, NOT used here: code 245, empty body, sent each of the
 * four times the picker was opened (before any pick). The camera's reply is a
 * 20-byte field 1 holding four floats 0.4579, 0.4247, 0.0851, 0.1510 — the
 * same rect layout, whose centre is (0.5005, 0.5002): the frame centre, i.e.
 * very probably "the current framing point" read back, at its default. Only
 * ever seen before the first pick, so whether it reflects a later choice is
 * unknown. See sendSetTrackingFramingCandidate in trackingCandidates.ts.
 *
 * STILL UNVERIFIED: that sending 244 from THIS app moves the gimbal. The
 * capture shows what the iPhone app does, not that 244 alone is enough — if
 * nothing moves, the first thing to try is also sending 245 when the picker
 * opens, as the iPhone app did. Watch the camera body, the oracle used for
 * all the Deep Track work.
 *
 * To remove the feature: delete this file, TrackingFramingPicker.vue, the
 * "framing" block in useTracking.ts, the <TrackingFramingPicker> in
 * app/pages/camera.vue, sendSetTrackingFramingCandidate in
 * trackingCandidates.ts and CODE_SET_TRACKING_FRAMING_CANDIDATE in
 * src-tauri/src/luna.rs (const, is_allowed_command arm, test entry).
 */

/** The box the iPhone app sends, normalised 0..1, origin TOP-LEFT. */
export interface FramingRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FramingPoint {
  /** 0..8, row-major from the top-left (0 = top-left, 4 = centre, 8 = bottom-right). */
  index: number;
  /** What is sent to the camera. */
  rect: FramingRect;
  /** Centre of the box, normalised 0..1 — where the picker draws it. */
  x: number;
  y: number;
  /** Plain-words name, for the status chip and aria-labels. */
  label: string;
}

/** Captured values, rounded to 4dp from the float32s on the wire. */
const BOX_W = 0.0605;
const BOX_H = 0.1075;
const LEFTS = [0.2663, 0.4698, 0.6733] as const;
const TOPS = [0.2226, 0.4463, 0.6699] as const;

const ROW_NAMES = ["top", "middle", "bottom"] as const;
const COLUMN_NAMES = ["left", "centre", "right"] as const;

export const FRAMING_POINTS: readonly FramingPoint[] = TOPS.flatMap((top, row) =>
  LEFTS.map((left, column) => ({
    index: row * 3 + column,
    rect: { x: left, y: top, w: BOX_W, h: BOX_H },
    x: left + BOX_W / 2,
    y: top + BOX_H / 2,
    label:
      row === 1 && column === 1
        ? "centre"
        : `${ROW_NAMES[row]} ${COLUMN_NAMES[column]}`.replace("middle ", ""),
  })),
);

/**
 * Whether choosing a point actually reaches the camera. True now that the
 * command is known; kept so the picker's wording keys off one place. Flip to
 * false to put the picker back to on-screen-only (nothing is sent).
 */
export const FRAMING_SENDS_TO_CAMERA = true;

export interface FramingSendResult {
  /** True only once a real command has gone to the camera and it answered. */
  sent: boolean;
  /** Shown to the person when `sent` is false. */
  reason?: string;
}

/**
 * Tell the camera which preset point to centre the tracked subject on —
 * code 244, see this file's top comment. Rejects if the camera errors; the
 * caller (useTracking.ts's selectFraming) turns that into the chip's note.
 */
export async function sendTrackingFramingCandidate(
  point: FramingPoint,
): Promise<FramingSendResult> {
  if (!FRAMING_SENDS_TO_CAMERA) {
    return { sent: false, reason: "Framing sending is switched off." };
  }
  await sendSetTrackingFramingCandidate(point.rect);
  return { sent: true };
}

/**
 * The rectangle a video of `videoWidth` x `videoHeight` occupies inside a
 * `containerWidth` x `containerHeight` box when shown with `object-contain`
 * (letter/pillar-boxed, centred). Same maths TrackingOverlay.vue uses for its
 * drawn box, kept separate so that working component isn't touched.
 */
export function containRect(
  containerWidth: number,
  containerHeight: number,
  videoWidth: number,
  videoHeight: number,
): { left: number; top: number; width: number; height: number } | null {
  if (containerWidth <= 0 || containerHeight <= 0 || videoWidth <= 0 || videoHeight <= 0)
    return null;
  const containerAspect = containerWidth / containerHeight;
  const videoAspect = videoWidth / videoHeight;
  if (videoAspect > containerAspect) {
    const height = containerWidth / videoAspect;
    return { left: 0, top: (containerHeight - height) / 2, width: containerWidth, height };
  }
  const width = containerHeight * videoAspect;
  return { left: (containerWidth - width) / 2, top: 0, width, height: containerHeight };
}
