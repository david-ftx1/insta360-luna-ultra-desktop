/**
 * Gimbal joystick, recentre and tap-to-focus — what the iPhone app sends,
 * added 2026-10-22 from JoystickandFocus.pcapng + a screen recording.
 * Findings and the evidence: docs/JOYSTICK-FOCUS-CAPTURE.md.
 *
 * JOYSTICK — code 226, body `08 <type> 12 <len> <inner> 20 04`:
 *   type 1 = stick position. inner = `08 <zigzag v>` (field 1, vertical) and
 *            `10 <zigzag h>` (field 2, horizontal), each omitted when 0.
 *            Positive v = UP, positive h = RIGHT (matched against the video: the
 *            ceiling came into view on v>0, the picture swung left on h<0).
 *            Range -64..64; the further the stick, the faster the gimbal.
 *            Sent continuously while held (the phone repeats the same value),
 *            and once more with an empty inner message (0,0) on release.
 *   type 2 = recentre (`08 02 12 00`, no `20 04`). The phone sends code 238
 *            (close tracking) immediately before it.
 *   The trailing `20 04` (field 4 = 4) is in every position message; its
 *   meaning is unknown, so it is sent exactly as the phone does.
 *   The camera answers every one with an empty 200.
 *
 * TAP TO FOCUS — code 9 (set photography options), option 94, the SAME message
 * the Deep Track code already uses for its box (see trackingCandidates.ts). The
 * capture shows it is what draws the yellow focus box on a tap: x and y are the
 * box's TOP-LEFT corner (checked against three taps in the recording), w x h is
 * always 0.1581 x 0.2811 (square on 16:9). Reply `08 5e` = applied. The message
 * ends with the function mode (`18 07` = normal video in the capture); here it
 * follows the mode the app is in — only Video was captured.
 */

import { enumValue, FUNCTION_MODE } from "~/utils/lunaProto";
import { getCameraTransport } from "~/utils/transport";

const CODE_GIMBAL_JOYSTICK = 226;
const CODE_SET_PHOTOGRAPHY_OPTIONS = 9;

/** Furthest the stick goes, either way (zigzag 128 on the wire). */
export const JOYSTICK_MAX = 64;

const zigzag = (n: number): number => (n >= 0 ? n * 2 : -n * 2 - 1);

function varint(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining);
  return bytes;
}

const clampAxis = (n: number): number =>
  Math.max(-JOYSTICK_MAX, Math.min(JOYSTICK_MAX, Math.round(n)));

/** Stick position. `vertical` + is up, `horizontal` + is right; both -64..64. */
export function buildJoystickBody(vertical: number, horizontal: number): Uint8Array {
  const v = clampAxis(vertical);
  const h = clampAxis(horizontal);
  const inner = [
    ...(v !== 0 ? [0x08, ...varint(zigzag(v))] : []),
    ...(h !== 0 ? [0x10, ...varint(zigzag(h))] : []),
  ];
  return new Uint8Array([0x08, 0x01, 0x12, inner.length, ...inner, 0x20, 0x04]);
}

export const buildRecentreBody = (): Uint8Array => new Uint8Array([0x08, 0x02, 0x12, 0x00]);

/** Fire-and-forget callers catch for themselves; the camera's reply is empty. */
export const sendJoystick = (vertical: number, horizontal: number): Promise<Uint8Array> =>
  getCameraTransport().command(CODE_GIMBAL_JOYSTICK, buildJoystickBody(vertical, horizontal));

export const sendRecentre = (): Promise<Uint8Array> =>
  getCameraTransport().command(CODE_GIMBAL_JOYSTICK, buildRecentreBody());

// ---- tap to focus --------------------------------------------------------

export const FOCUS_BOX_W = 0.1581;
export const FOCUS_BOX_H = 0.2811;

export interface FocusRect {
  /** Top-left corner, normalised 0..1 of the picture. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The focus box centred on a point of the picture, kept inside the frame. */
export function focusRectAround(cx: number, cy: number): FocusRect {
  const x = Math.max(0, Math.min(1 - FOCUS_BOX_W, cx - FOCUS_BOX_W / 2));
  const y = Math.max(0, Math.min(1 - FOCUS_BOX_H, cy - FOCUS_BOX_H / 2));
  return { x, y, w: FOCUS_BOX_W, h: FOCUS_BOX_H };
}

/**
 * req 1330 from JoystickandFocus.pcapng, byte for byte (like the Deep Track
 * template: four fields the schema cannot name sit before field 94, so only the
 * floats and the function mode are spliced).
 */
const FOCUS_TEMPLATE_HEX =
  "0a015e1225a20100aa0100f80101c00501f20516080115b5d8c63e1d4d37c23d2555ef213e2d2ff18f3e1807";
const X_AT = 23;
const Y_AT = 28;
const W_AT = 33;
const H_AT = 38;
const FUNCTION_MODE_AT = 43; // the value byte after `18` (field 3)
const FALLBACK_FUNCTION_MODE = 7;

/** Function mode as a number: a schema name, or the bare number of an unnamed mode. */
export function functionModeNumber(mode: string): number {
  if (/^\d+$/.test(mode)) return Number(mode);
  return enumValue(FUNCTION_MODE, mode) ?? FALLBACK_FUNCTION_MODE;
}

export function buildFocusBody(rect: FocusRect, functionMode: string): Uint8Array {
  const body = Uint8Array.from(
    FOCUS_TEMPLATE_HEX.match(/../g)!.map((pair) => Number.parseInt(pair, 16)),
  );
  const view = new DataView(body.buffer);
  view.setFloat32(X_AT, rect.x, true);
  view.setFloat32(Y_AT, rect.y, true);
  view.setFloat32(W_AT, rect.w, true);
  view.setFloat32(H_AT, rect.h, true);
  body[FUNCTION_MODE_AT] = functionModeNumber(functionMode);
  return body;
}

export const sendFocus = (rect: FocusRect, functionMode: string): Promise<Uint8Array> =>
  getCameraTransport().command(CODE_SET_PHOTOGRAPHY_OPTIONS, buildFocusBody(rect, functionMode));
