# Tracking Framing — what the capture showed

Source: `Tracking_points_Full.pcapng` + `ScreenRecording_10-21-2026_15-45-17_1.MOV`,
both 2026-10-21, iPhone app driving the Luna Ultra (192.168.42.51 → 192.168.42.1,
port 6666). Decoded with a Python/scapy reader using the same UCD2 framing as
`scripts/lib/ucd2.mjs` (`scripts/decode-capture.mjs` needs `tshark`, which wasn't
available where this was analysed — it should give the same frames).

## Result

**Code 244 is the pick.** Nine phone → camera frames, one per pick, in the order
the picks were made (row-major: top-left … bottom-right). Body, same layout as
code 237:

| field | wire    | meaning                      |
| ----- | ------- | ---------------------------- |
| 1     | varint  | millisecond Unix timestamp   |
| 2, 3  | float32 | x, y — box **top-left**      |
| 4, 5  | float32 | w, h — constant 0.0605 × 0.1075 |

Sent values (x then y), as decoded:

| pick (row, col) | x      | y      |
| --------------- | ------ | ------ |
| top row         | 0.2663 / 0.4698 / 0.6733 | 0.2226 |
| middle row      | 0.2663 / 0.4698 / 0.6733 | 0.4463 |
| bottom row      | 0.2663 / 0.4698 / 0.6733 | 0.6699 |

Why top-left and not centre: the middle pick's centre is (0.50005, 0.50005) —
the exact frame centre; and 0.0605 × 16 = 0.1075 × 9, so the box is a square on a
16:9 frame, which is what the picker draws.

Every 244 was answered with a plain `200`, empty body. No camera push followed.

The screen recording agrees (it runs ~11.5 s behind the packet clock): the
picker stays open across all nine picks; each pick turns that box green and the
gimbal moves so the subject sits there; the picker closes ~2 s after the last.

## Also seen, not implemented

- **Code 245**, empty body, sent each of the 4 times the picker was opened (all
  before the first pick). Reply: a rect `0.4579, 0.4247, 0.0851, 0.1510` — centre
  (0.5005, 0.5002), i.e. almost certainly "current framing point", at its
  default (frame centre). Only ever read before a pick, so whether it tracks a
  later choice is unknown.
- **Locking used code 237 only.** No code 9 (option 94) and no 217 appear in this
  capture; the lock came from a single 237 at the moment "Start Smart Tracking"
  showed. One capture, and 217 may simply have been sent before it began — but
  it bears on the open "is option 94 needed once 237 is sent?" question in
  `trackingCandidates.ts`.
- **237's x/y look like top-left too.** That 237 was `x 0.4324, y 0.0628,
  w 0.29, h 0.4969`. Drawn on the recording's frame, reading x/y as top-left
  boxes the head; reading them as centre puts the box mostly above the head and
  partly off the top of the frame. This app (`TrackingOverlay.vue`, and the
  comments in `trackingCandidates.ts`) sends x/y as the box **centre**. It
  works today, plausibly because the camera only needs a frontal face somewhere
  in the region, but the box it's given is shifted by half its size. Not changed.

## To test

From `~/insta360-luna-ultra-desktop`, `bun run dev`, connect, lock Deep Track on
your face (square-on), click the framing icon at the top-left, pick a point.
Watch the camera body, not the screen: the subject should move to that point.

- If nothing moves: also send 245 when the picker opens (what the iPhone app did).
- If it moves but lands off by about half a box: the corner convention is wrong
  for this app's path; check `rect` in `FRAMING_POINTS`.
