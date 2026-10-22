# Gimbal joystick, recentre and tap-to-focus — what the iPhone app sends

Source: `JoystickandFocus.pcapng` + a screen recording, 2026-10-22 (capture started
14:59:54, the recording about 32 s earlier). Camera 192.168.42.1 TCP 6666, iPhone
192.168.42.51. Wire format is implemented in `app/utils/gimbalControl.ts`; every
joystick/recentre message (118) and focus message (3) in the capture is reproduced
byte for byte by that code (checked 2026-10-22).

## Joystick — code 226

Body: `08 <type> 12 <len> <inner> 20 04` (recentre has no `20 04`).

| type | inner | meaning |
|---|---|---|
| 1 | `08 <zigzag v>` and/or `10 <zigzag h>` (a field is omitted when 0) | stick position; empty inner = released |
| 2 | empty | recentre (`08 02 12 00`) |

- Values are zigzag-signed, range -64..64 (zigzag 128 = `80 01`). Evidence: within each
  drag every value has the same parity (all even = positive, all odd = negative).
- Field 1 = vertical, + is UP. Field 2 = horizontal, + is RIGHT. Matched against the
  recording: drag 1 (v=+59, h=0) brought the ceiling into view; drag 2 (v and h negative)
  swung the camera left and down; drag 3 (h positive) swung it right.
- Sent continuously while the finger is held, repeating the same value; one `(0,0)`
  message on release. The further the stick, the larger the value — and the faster the
  gimbal moves.
- `20 04` (field 4 = 4) is in every position message; meaning unknown, copied as is.
- The phone sends code 238 (close tracking) immediately before every recentre (5 of 5).
- No "joystick on" message exists: the pad is always there on the phone.
- The camera replies to each with an empty 200.

## Tap to focus — code 9, option 94 (the same message Deep Track uses for its box)

Three taps, three writes at 37.86 s, 43.99 s and 47.08 s of the capture, with no tracking
active. The yellow box appears in the recording at the matching times. Compared with the
boxes in the video: **x and y are the box's TOP-LEFT corner**, not its centre. w x h is
always 0.1581 x 0.2811 (square on 16:9). Reply `08 5e`. The message ends `18 <n>`, the
function mode (7 = normal video here).

Possible consequence, NOT changed: `trackingCandidates.ts` treats the same x/y as the
box CENTRE (`TrackingBox`, "Box centre, normalised 0..1"). If Deep Track's option-94
write is this same focus box, its box lands half a box (0.08 x 0.14) up and to the left
of where it is drawn.

## Not verified from this app

- That the camera accepts joystick/focus writes from us (the byte layout is identical).
- Focus under other function modes (only Video was captured; the app sends the current
  mode's number).
- Whether the camera needs the repeated "hold" messages, or what a keyboard's fixed
  speed (half, or full with Shift) feels like — those are this app's choices.
