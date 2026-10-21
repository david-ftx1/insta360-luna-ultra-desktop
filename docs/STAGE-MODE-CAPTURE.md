# Stage Mode — what the iPhone app sends

Source: `StageMode.pcapng` + a screen recording, 2026-10-21 (capture started
21:02:29, the recording 20 s earlier). Camera 192.168.42.1 TCP 6666, iPhone
192.168.42.51. The phone went Video -> Photo -> Stage Mode, then recorded for a
few seconds in Stage Mode. Zoom was NOT exercised in this capture.

| When (capture s) | On screen | Code | Body | Meaning |
|---|---|---|---|---|
| 15.29 | Video -> Photo | 7 (set options) | option_types [PHOTO_SUB_MODE]; photo_sub_mode omitted (= 0, PHOTO_SINGLE) | already known |
| 19.33 | Photo -> Stage Mode | 7 (set options) | option_types [VIDEO_SUB_MODE]; `video_sub_mode = 22` | **Stage Mode = video_sub_mode 22** (schema stops at 11, 100) |
| 19.33 onward | | 10 (get photography options) | `function_mode = 68` | **Stage Mode settings live under function mode 68** (schema stops at 27) |
| 30.54 | record pressed | 4 (start capture) | `mode = 15` | **capture mode 15** |
| 34.59 | record stopped | 5 (stop capture) | `mode = 15` plus extra_metadata (euler_enable etc.) | same capture mode |

Also seen at start-up: function mode 67 and 68 are both probed in the first
second, so 67 is probably another new mode.

Notes
- The phone packs the repeated option_types (`0a 01 29`); this app sends them
  unpacked (`08 29`). Both are valid protobuf; the app's existing mode switches
  already work that way.
- This app's stop-capture sends only `mode`. The phone also sends extra_metadata.
  Other modes stop fine without it; Stage Mode is untested.
- Unverified from this app: the camera accepting these writes from us, zoom under
  function mode 68, and whether Stage Mode shows a colour/filter picker (none is
  offered: cameraCapabilities.ts has no entry for "stage").
