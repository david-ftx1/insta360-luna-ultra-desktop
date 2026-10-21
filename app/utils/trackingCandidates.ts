import { getCameraTransport } from "~/utils/transport";

/**
 * Deep Track / subject-tracking candidates — UNCONFIRMED.
 *
 * The three codes below came out of a packet capture of the genuine Insta360
 * app turning tracking on and off (Tracking_Enable_Disable.pcapng, captured
 * 2026-10-18 over USB via rvictl while the app drove the camera). Earlier
 * isolated, beep-synced, filmed runs against an empty desk all showed zero
 * physical effect, but none of those runs had a subject in frame, and Deep
 * Track (by the real app's own behaviour) refuses to engage against a scene
 * with nothing to lock onto. See docs/PROTOCOL-GAP.md's "Subject tracking"
 * section and scripts/probe-tracking.mjs for the full evidence, every
 * candidate considered, and everything tried so far.
 *
 * A fourth candidate from that same capture, code 237 (matching
 * PHONE_COMMAND_TRACK_USER_OPS by name — see PROTOCOL-GAP.md), was
 * deliberately NOT implemented here at first: it fires repeatedly with all
 * four floats (x, y, w, h) moving each time, which reads as the box being
 * continuously repositioned while tracking runs — but phone -> camera, same
 * direction as the other three. IMPLEMENTED 2026-10-19 — see
 * "CANDIDATE 237 IMPLEMENTED" below for the decoded structure and why.
 *
 * UPDATE 2026-10-19, from a second capture (Tracking Data Small.pcapng) shot
 * alongside a screen recording of the real app AND a second camera filming
 * the gimbal: this is the first evidence in the whole investigation of any
 * candidate having a real physical effect. Using a verified sync point David
 * gave between the two videos (the moment the gimbal unlocks on switching to
 * camera view), the four code-237 sends in the capture each land within ~2s
 * of a measurable small gimbal movement in the footage — against a near-flat
 * background everywhere else in a 230s clip. Four events isn't a large
 * sample and this doesn't distinguish "the camera reacting to 237
 * specifically" from "the gimbal servoing continuously whenever this kind of
 * traffic flows," but it's a real, reproducible correlation, not noise — see
 * the session transcript around 2026-10-19 for the full frame-diff analysis.
 *
 * That same screen recording also settles what the real app's second box
 * actually looks like, on closer viewing: drag a finger across the preview
 * and it draws a plain green rectangle; release, and the app redraws its own
 * green box around the detected subject (briefly a full rectangle, then
 * corner-bracket "locked on" markers), with a small green "x" in its
 * top-left corner to cancel — see CODE_CLOSE_TRACKING_CANDIDATE's comment
 * below, corrected from an earlier (wrong) top-right assumption. Whether
 * that second box is computed by the phone (and 237 is it pushing that box
 * to the camera, consistent with 237's direction and the new correlation
 * above) or by the camera and merely relayed through 237 is still open —
 * CAMERA_NOTIFICATION_TRACK_SYNC (PROTOCOL-GAP.md's named candidate for the
 * camera reporting its own result) still has no known numeric code or
 * payload, and no camera -> phone frame carrying coordinates has shown up in
 * either capture, including the PTZ-family notifications the second capture
 * did turn up (PTZ_STATE confirmed at code 8302, plus several likely
 * siblings) — all of which carry simple state flags, not coordinates.
 * useTracking.ts's notification capture exists to keep checking for one.
 *
 * UPDATE 2026-10-19 (round two), from decoding Tracking Data Small.pcapng
 * with real per-packet capture timestamps (tshark's own frame.time_epoch)
 * instead of only the one embedded clock field code 237's payload happens to
 * carry: this gives a far more precise and complete picture than the
 * round-one pass above, and corrects two things it got wrong.
 *
 * First, CODE_CLOSE_TRACKING_CANDIDATE (238) does not fire "once mid-session
 * and once as the last frame" as this file used to say. The real capture
 * contains four full OPEN_TRACKING_CANDIDATE (217, see below — corrected
 * 2026-10-19 round three; this paragraph previously, wrongly, said 237,
 * which is a different, unrelated code) -> 238 cycles, alternating cleanly
 * through the whole session — four engages, four cancels, not two cancels.
 * That earlier count came from a less careful pass and undercounted it.
 *
 * Second, CODE_OPEN_TRACKING_CANDIDATE (217, body `08 01`) does not fire
 * right before each box-draw. In this capture it fires as a tight cluster of
 * four, about 49 seconds *before* the box was ever drawn — which, cross-
 * referenced against the screen recording, is well before any tracking UI
 * interaction at all. It reads much more like "entering a tracking-capable
 * view" (camera/live view) than a per-gesture open signal, contradicting
 * this file's original assumption (itself inherited from the first, Oct-18
 * capture, which only showed it clustered near where box writes started —
 * correlation, not the causal per-drag relationship this file assumed from
 * it).
 *
 * This pass also nailed down, precisely, what happens when a box is drawn:
 * SET_PHOTOGRAPHY_OPTIONS/94 (buildTrackingBoxBody's write, below) does not
 * fire once. The real app sends ten of them over about 12 seconds once the
 * box is set — the first lands in the same video frame the green box first
 * becomes visible on screen (confirmed by extracting the screen recording at
 * 0.5s resolution: the box appears and "Start Smart Tracking" shows on
 * screen within half a second of that first write), and the other nine,
 * spaced 1-3s apart, keep going for several seconds *after* that, which
 * reads as continuous box refinement while tracking runs rather than a
 * single "set and done" write. This was independently cross-checked, not
 * just assumed: anchoring the whole capture's clock to that first write
 * predicted the session's first 238 (cancel) at video timestamp ~151.6s —
 * and the frame at that exact timestamp reads "Tracking canceled" on
 * screen, off by under 2 seconds. (File metadata was deliberately not used
 * for any of this — both videos' creation_time tags, and even the screen
 * recording's filename-embedded time, turned out to disagree with this
 * video-frame-grounded mapping by anywhere from 30 seconds to over 20
 * minutes, consistent with earlier findings in this project that this
 * camera/phone/drone's various clocks cannot be trusted for correlation.)
 *
 * None of this proves which part of that pattern is what actually makes the
 * camera respond physically — only that it's a three-part pattern (217 once
 * on entering the view, 94 written repeatedly starting at box-set and
 * continuing while tracking runs, 238 to cancel), not the single open+set
 * pair this file originally implemented. useTracking.ts's `openOnEnable`
 * and `boxWriteMode` exist to let David try the candidate parts of that
 * pattern independently from the live overlay — session-level open vs. none,
 * and single/burst/sustained box writes — instead of this file guessing at
 * one fixed combination in code.
 *
 * FIRST LIVE RESULT, 2026-10-19: David ran this experiment against the real
 * camera (sustained box writes, open-on-enable on) and watched the gimbal
 * directly — confirmed no physical movement at all. That's a genuine
 * negative result, not an inconclusive one (unlike the earlier DJI-video
 * motion-diff attempts), since he was watching the camera itself rather
 * than inferring it from footage. Separately, the same session surfaced a
 * real UI bug, now fixed — see TrackingOverlay.vue's top comment — where
 * the cancel "x" silently did nothing, which is unrelated to whether
 * tracking engaged but was worth ruling out before trusting "no movement"
 * as a verdict on the write patterns rather than on broken UI.
 *
 * So as of this result: none of single/burst/sustained box-write patterns,
 * with or without the session-level 217, have produced physical movement.
 * That narrows what's left to try — e.g. whether 237 (now implemented, see
 * below) is actually required, or whether the real app's box write carries
 * some per-frame field this file's fixed template doesn't vary — rather than
 * confirming the three-part pattern is right.
 *
 * CANDIDATE 237 IMPLEMENTED, 2026-10-19: re-decoding the four captured 237
 * sends from Tracking Data Small.pcapng (the same capture "round two" above
 * used) with real field/wire parsing — not just eyeballing the hex — confirms
 * the structure scripts/probe-tracking.mjs guessed at: field 1 (varint) = a
 * millisecond Unix epoch timestamp a few hundred ms to ~1s behind that
 * packet's own capture time (consistent with "time the phone built this
 * message, before it was sent and captured" — not a protocol clock); fields
 * 2-5 (fixed32/float, the same field numbers option 94's embedded box uses)
 * = x, y, w, h, with ALL FOUR varying on every one of the four captured
 * sends — a genuinely moving/resizing rectangle each time, unlike option 94's
 * fixed-size one. Notably, unlike the option-94 template above, every single
 * byte of all four captured bodies is accounted for by this layout — nothing
 * left over or unexplained, which is part of why this is built fresh
 * (buildTrackUserOpsBody, below) from field tags + varint/float encoding
 * rather than a spliced captured template: there's no unexplained residue
 * here worth preserving byte-for-byte.
 *
 * Wired into useTracking.ts as its own `sendTrackUserOps` toggle (now on by
 * default — see FIRST CONFIRMED POSITIVE below; this comment originally said
 * "off by default", true only when this was first written, before that
 * result came in), not folded into `boxWriteMode`: which candidate to send
 * (94 vs 237) and how often to resend it are separate questions, and 237 is the
 * one candidate in this whole investigation with a real measured physical
 * correlation (see the UPDATE above) — worth testing on its own, not only
 * stacked onto a box-write pattern that's already shown zero effect.
 *
 * FIRST CONFIRMED POSITIVE, 2026-10-19 (same day, later run): with open
 * (217) on enable, sustained (~2s loop) option-94 box writes, AND candidate
 * 237 all switched on together, David watched the camera body directly (the
 * same oracle used throughout this file — not inferred from footage; no
 * second camera filmed this run) and confirmed the gimbal actually panned/
 * tilted to track him. This is the first real positive physical result
 * anywhere in this investigation.
 *
 * What makes this more than "it worked once": the FIRST LIVE RESULT above —
 * open-on-enable + sustained box writes, same two settings, same day,
 * earlier run — produced confirmed ZERO movement. 237 is the only thing
 * that changed between that negative result and this positive one. That's
 * about as clean a before/after as an uncontrolled field test can give,
 * even though it's still one run, not a controlled isolation: it doesn't by
 * itself prove 237 is *necessary* (vs. e.g. some other difference between
 * the two sessions), and it says nothing about whether option 94's sustained
 * resend is still needed once 237 is in play, or whether 237 alone (no box
 * writes at all) would be enough on its own. Those remain open.
 *
 * Also reconfirmed in the same session: 217 sent alone (no box, no 237) did
 * nothing — consistent with every earlier test and with Deep Track needing
 * an actual target to lock onto, not just an "enable" signal by itself.
 *
 * Given this result, `sendTrackUserOps` in useTracking.ts now defaults to
 * on (previously off, back when 237 was unconfirmed-but-new) — so enabling
 * the experiment starts from the one combination that's actually shown a
 * physical effect, not a combination already known to do nothing.
 *
 * David also reported a message on the camera's own LCD referencing
 * something like "no detectable tracking" during this run — worth flagging
 * since every earlier note in this project (see scripts/probe-tracking.mjs)
 * said the camera's screen goes dark/locked during a Wi-Fi session and
 * "cannot be used to confirm any of this." Not yet pinned down: the exact
 * wording, or whether it appeared *instead of* tracking (i.e. an error that
 * cleared once tracking engaged) or alongside it.
 *
 * SINGLE VS SUSTAINED, 2026-10-19 (same day, later still): directly bears on
 * the "whether option 94's sustained resend is still needed once 237 is in
 * play" question left open just above. After the FIRST CONFIRMED POSITIVE
 * result (above) was obtained with boxWriteMode "sustained", David also
 * tried boxWriteMode "single" (one option-94 write, no resend loop) in the
 * same live session, same openOnEnable + sendTrackUserOps settings, and
 * confirmed the gimbal tracked with that too — then, going back and forth
 * between the two, called it plainly: "Single is much more reliable." That's
 * a subjective back-to-back comparison by one person watching one camera,
 * not a counted trial across repeated runs, so treat "more reliable" as a
 * real but informal signal rather than a measured rate. It does NOT answer
 * whether box writes need to repeat at all once 237 is riding alongside them
 * (single still writes box 94 once, just never again) — that's still open —
 * but so far, repeating the write on a timer has shown no advantage and may
 * be actively worse, the opposite of what "sustained is the closest replica
 * of the real app's own traffic" would have predicted. Given this,
 * useTracking.ts's `boxWriteMode` now defaults to "single" instead of
 * "sustained" — see its own doc comment there.
 *
 * BOX OVERLAY IS STATIC / SNAP IS LIKELY CLIENT-SIDE, 2026-10-19 (later
 * again): with boxWriteMode "single", David positioned his head in the
 * top-left of frame, drew a box around it, and watched the gimbal pan/tilt
 * to bring him toward the centre of frame — another confirmed physical
 * tracking result, this time specifically on "single". The drawn/last-sent
 * box overlay (TrackingOverlay.vue's sentBoxStyle) stayed exactly where it
 * was drawn, no longer around the subject once the gimbal moved. That's
 * expected given how this app is built, not a bug: sentBoxStyle just
 * redraws the coordinates of the last box *sent*, with no feedback loop
 * repositioning it — consistent with the NEW NOTIFICATION CODES note below
 * and TrackingOverlay.vue's own top comment, both already saying no camera
 * -> phone notification carrying coordinates has ever turned up to redraw
 * it from.
 *
 * This also bears on a question from outside this file: whether the real
 * iOS app's own "snap"/corner-bracket box (TrackingOverlay.vue's top
 * comment) is something the camera protocol drives, or something the iOS
 * app computes and draws itself from its own on-device subject detection.
 * David's read, which this desktop behaviour supports: it's client-side in
 * the iOS app, not protocol-driven — consistent with every capture so far
 * never showing a camera-sourced coordinate frame. Not proven outright (a
 * coordinate-carrying notification could in principle exist and simply not
 * have been caught by either of this project's two captures), but it's now
 * the best-supported explanation here, and it means a live-tracking box in
 * this app would need its *own* subject-detection running against the live
 * frame, not a value read from the camera — a materially bigger feature
 * than decoding one more candidate.
 *
 * NEW NOTIFICATION CODES, 2026-10-19: a live test against the real camera
 * (sustained box writes, open-on-enable on, watched directly — see FIRST
 * LIVE RESULT above) surfaced two camera-initiated codes never seen in
 * either capture: 8317 (seven times, clustered in the first ~20s after
 * enabling, then one more near the end of a 92s session) and 8199 (once,
 * req 938, body beginning `0d 00 00 1d 9f…` per a still-frame read of the
 * debug overlay off a screen recording — not a byte-exact capture, so that
 * body is not trustworthy enough to decode further). Neither has a known
 * meaning. describeNotificationCode, below, just gives them names so they
 * read as "seen before, unexplained" rather than noise in the readout —
 * actually decoding them needs a Wireshark capture from a session that
 * reproduces them, the same bar every other code in this file had to clear.
 *
 * CODE 8315 = TRACK CLOSE/CANCEL SIGNAL (strong candidate), 2026-10-19
 * (later again): answers a question David asked directly — does the camera
 * ever acknowledge that tracking has stopped. Found by going back to the
 * same source as candidate 237's decode, "Tracking Data Small.pcapng", and
 * this time cross-referencing it against its matching iPhone screen
 * recording (ScreenRecording_10-19-2026 13-14-01_1.MOV — identified by
 * aligning the video filename's local start time against the pcap's own
 * UTC capture window; the two agree to within ~20s, consistent with the
 * screen recording starting a little before the Wi-Fi capture did).
 *
 * Every CLOSE_TRACKING (238) send in that ~3-minute capture — 4 of them —
 * is followed, within 0 to ~1s, by a previously-unlabelled notification,
 * code 8315, with a byte-identical 8-byte body every single time:
 * `08 04 10 02 18 05 20 00`. That decodes cleanly, no residue, as four
 * single-byte protobuf varint fields: 1=4, 2=2, 3=5, 4=0. Code 8315 does
 * not appear anywhere else in this ~66k-packet capture — not near any of
 * the 4 OPEN_TRACKING (217) sends, not near any option-94/237 box write.
 * (The capture's only other 8xxx-range notifications — 8198, 8234, 8248,
 * 8275, 8298, 8334 — were checked too and all cluster around unrelated
 * option reads, nowhere near a tracking state change.) No equivalent
 * notification was found correlating with 217/"tracking turned on" at all.
 *
 * Matching each of those 4 pcap timestamps to the screen recording's own
 * timeline landed on a toast visible on the iPhone's own screen right at
 * each one — "Tracking canceled" for 3 of the 4, "Cancel tracking" for the
 * first (worth flagging honestly rather than smoothing over: that's
 * probably the tap-target button caught a frame or two before the
 * confirmation toast, rather than two different events, but that specific
 * explanation isn't independently confirmed) — and in every case the green
 * corner-bracket "locked on" markers visible on the subject just beforehand
 * are gone in the frames after. That's real, independent visual
 * confirmation that these are genuinely the moments tracking ended, not a
 * coincidental packet landing nearby.
 *
 * Caveat worth being honest about: this capture is of the official Insta360
 * iPhone app talking to the camera, not this desktop app's own traffic —
 * but it's the same UCD2 protocol, same Wi-Fi link, same camera, which is
 * exactly the kind of real traffic this whole project has leaned on for
 * every other candidate (237's own origin included). It's also not a
 * one-off: 8315 is one of the codes that showed up repeatedly, live, in
 * this desktop app's own debug readout during today's earlier live test
 * (the same screenshot that first flagged 8195/8317/8199) — a second,
 * independent sighting outside this pcap, consistent with a real general
 * camera behaviour rather than something specific to the iPhone app.
 *
 * Net: this is the first time anything in this investigation has produced a
 * repeatable, camera-initiated signal tied specifically to tracking being
 * switched off — a real answer to "does the camera tell you tracking
 * stopped," where before today it was a flat no. It's not pinned to a named
 * protocol field: docs/PROTOCOL-GAP.md's two tracking-state leads,
 * `CAMERA_NOTIFICATION_PTZ_TRACK_STATE` and `CAMERA_NOTIFICATION_TRACK_SYNC`,
 * are both plausible fits for what 8315 is, but neither has a recovered
 * number to check against, so this stays "code 8315, strongly correlated
 * with close," not a confirmed identity. describeNotificationCode, below,
 * reflects that — a real, specific lead, not a confident decode.
 *
 * CONFIRMED 2026-10-20, in this app's own traffic: with notification capture
 * left continuously on (Deep Track enabled the whole time, only the "x"
 * tapped per attempt — see CODE_CLOSE_TRACKING_CANDIDATE's own comment),
 * David saw cameraConfirmedTrackingOff flip true on 5 of 6 "x" taps in one
 * session. Capture wasn't the variable that time (see
 * DISABLE_CAPTURE_GRACE_MS in useTracking.ts for the timing bug that *did*
 * explain earlier misses, before capture was left on throughout this
 * session) — this 5/6 is the camera's own behaviour: it doesn't push 8315
 * on every single close, at roughly this rate, in this app, not just the
 * iPhone capture. Still open: whether the 1 miss carried a different,
 * undecoded code instead (useTracking.ts's `notifications` readout would
 * show it, if captured) or nothing arrived at all.
 *
 * This module exists so the experimental overlay (TrackingOverlay.vue, gated
 * behind FEATURES.deepTrackExperiment) can test the same candidates from the
 * real live view, with a real subject in frame, instead of a standalone
 * script. If tracking is abandoned, this file, TrackingOverlay.vue,
 * useTracking.ts, the deepTrackExperiment flag in utils/features.ts, the
 * notification-capture additions to utils/transport.ts and
 * utils/lunaClient.ts, and src-tauri/src/luna.rs's three *_CANDIDATE consts +
 * their is_allowed_command arms, UnmatchedNotification,
 * Session::notify_unmatched, and luna_set_notification_capture are
 * everything that needs to come out — nothing else in the app references
 * any of it.
 *
 * FOUND 2026-10-20, from a controlled retest (toggle off, toggle on, draw one
 * large box, repeat four times in a row): David reported two of the four
 * draws engaged tracking and two didn't, with every send across all four
 * looking identical at the protocol level this file was checking up to that
 * point — code 9 (option 94) sent every time, code 237 sent every time right
 * after it, both acked with a plain 200. The difference was in a field
 * nothing here had read yet: the code-9 reply's own *body*. The two draws
 * that worked came back `08 5e` (field 1 = 94 as a varint — the option
 * number echoed back, i.e. "option 94 applied"); the two that didn't came
 * back with an empty body under that same 200 status. That lines up exactly,
 * both ways, with this session's other two signals: only the two confirmed
 * draws were later followed (4-5s after their 237) by an unmatched code 8317
 * push, and only their later CLOSE_TRACKING (238) was followed by an 8315
 * "tracking stopped" push — consistent with the two unconfirmed draws never
 * having had anything running to close. See `checkBoxWriteConfirmed`, below,
 * and useTracking.ts's `boxWriteConfirmed` for where this is now surfaced —
 * synchronously, at write time, instead of waiting on either later push.
 * Four attempts is still a small sample, and this doesn't explain *why* the
 * camera silently drops the option on some writes (busy? a required prior
 * state this file isn't setting? plain flakiness?) — only that its own reply
 * says so immediately, which nothing here was reading before today.
 *
 * SOLVED 2026-10-20 (later the same day): David found the actual cause by
 * testing it directly, not from any packet capture — it's the camera's own
 * subject detection, nothing this app sends or omits. A face drawn at an
 * angle to the camera gets the empty-body non-confirmation above every
 * time; square-on to the camera gets the `08 5e` confirmation every time,
 * regardless of where in the frame the subject is. That fully accounts for
 * both sessions above (2/4, then 0/2) as pure chance of head angle during
 * hand-held testing, not a timing issue, a missing prerequisite send, or
 * anything flaky in this app's own traffic. Likely explanation: Deep Track
 * is a face-lock feature at heart, and the camera only accepts a box as a
 * valid lock target when its own detector finds a clear frontal face inside
 * it — but that's this file's inference, not something confirmed from the
 * protocol; David's result is the confirmed part. TrackingOverlay.vue's
 * "camera did not confirm" message now suggests this.
 */

/** code 217, body `08 01` — candidate OPEN_TRACKING. In the first (Oct-18)
 * capture this clustered near where box-position writes began, which this
 * file originally read as "opens right before each drag." The second
 * capture's real per-packet timestamps (2026-10-19, round two) don't
 * support that: there it fires as a tight cluster of four about 49 seconds
 * *before* any box was drawn, well before any tracking-UI interaction in
 * the screen recording — more consistent with a signal sent once on
 * entering a tracking-capable view than one sent per gesture. See this
 * file's top comment. */
const CODE_OPEN_TRACKING_CANDIDATE = 217;

/** code 238, empty body — candidate CLOSE_TRACKING, i.e. the "x" tap in the
 * top-left corner of the box (confirmed 2026-10-19 by close inspection of
 * the screen recording — an earlier top-right description was wrong; that
 * is how the real app's tracking is actually turned off, not a toggle
 * switch). Fired four times in the second capture, each one ending an
 * OPEN_TRACKING_CANDIDATE (217, not 237 — see this file's top comment for
 * that earlier mix-up) cycle — corrected 2026-10-19 (round two,
 * real per-packet timestamps) from an earlier, undercounted "once mid-
 * session and once as the last frame." One of the four was independently
 * verified against the screen recording's own on-screen "Tracking
 * canceled" label — see this file's top comment.
 *
 * CONFIRMED 2026-10-20, in THIS app (not just the iPhone-app capture
 * above): David reported every tap of TrackingOverlay.vue's own amber "x"
 * — this candidate, via useTracking.ts's cancel() — closed the box and
 * stopped tracking, every time. This is the clearest physical confirmation
 * yet that this candidate alone is enough to actually stop tracking; it's
 * a separate question from whether the camera's own 8315 acknowledgment
 * (useTracking.ts's cameraConfirmedTrackingOff) gets *observed* every
 * time, which that same session caught 5/6 — see DISABLE_CAPTURE_GRACE_MS
 * in useTracking.ts for why those two don't have to track each other:
 * cancel() only waits for *this* command's own reply, not the later,
 * separate 8315 push. */
const CODE_CLOSE_TRACKING_CANDIDATE = 238;

const CODE_SET_PHOTOGRAPHY_OPTIONS = 9;

/** code 237 — candidate PHONE_COMMAND_TRACK_USER_OPS. Body is field 1
 * (varint) = a millisecond Unix epoch timestamp, then fields 2-5
 * (fixed32/float) = x, y, w, h — see this file's top comment, "CANDIDATE 237
 * IMPLEMENTED", for how that was confirmed from four real captured sends and
 * why it's built fresh here instead of spliced from a template like option
 * 94. The one candidate so far with a measured (if small-sample) physical
 * correlation. */
const CODE_TRACK_USER_OPS_CANDIDATE = 237;

/** code 244 — the Tracking Framing "preset tracking point" write: which of
 * the 3x3 points the tracked subject should be centred on. Seen once per pick
 * (nine picks, nine frames) in Tracking_points_Full.pcapng, 2026-10-21; body
 * is the same layout as 237 (timestamp varint + x/y/w/h floats), with x/y the
 * box's TOP-LEFT corner. Full writeup in app/utils/trackingFraming.ts's top
 * comment. Confirmed as what the iPhone app sends; NOT yet confirmed to move
 * the gimbal when sent from this app. */
const CODE_SET_TRACKING_FRAMING_CANDIDATE = 244;

/**
 * req 96 from Tracking_Enable_Disable.pcapng, byte-for-byte. Deliberately
 * NOT reconstructed field-by-field from the schema: PhotographyOptionType 94
 * is not in app/assets/luna-protocol-schema.json (the enum jumps
 * 91 DEEP_TRACK -> 98 PANO_ASPECT), and the submessage carries four other
 * fields (20, 21, 31, 88) of unknown purpose ahead of field 94 that a
 * from-scratch rebuild would drop. Replaying the exact bytes and splicing
 * only the floats known to vary keeps every byte this project doesn't yet
 * understand exactly as the real app sent it.
 *
 * `08 01` = field1 state=1. `15 <f32> 1d <f32>` = fields 2,3 = x, y
 * (centre of the box, normalised 0..1, left-to-right / top-to-bottom).
 * `25 <f32> 2d <f32>` = fields 4,5 = w, h — 0.1581 x 0.2811 in every write of
 * the one capture this is built from, which only ever repositioned a
 * fixed-size box. Varying them here (as TrackingOverlay.vue's drag-to-size
 * box does) is a further experiment that capture never ran.
 */
const CAPTURED_SET_OPTIONS_94_TEMPLATE_HEX =
  "0a015e1225a20100aa0100f80101c00501f20516080115dff6ea3e1db30f0c3d2555ef213e2d2ff18f3e1807";
const X_OFFSET = 23;
const Y_OFFSET = 28;
const W_OFFSET = 33;
const H_OFFSET = 38;

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function writeFloatLE(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer).setFloat32(offset, value, true);
}

/**
 * Protobuf unsigned LEB128 varint encoding, by repeated division rather than
 * bit-shifting — `>>>`/`&` in JS coerce their operand through ToUint32/
 * ToInt32 first, which would silently truncate a millisecond epoch timestamp
 * (comfortably past 2^32) to garbage. Division keeps the full value exact up
 * to Number.MAX_SAFE_INTEGER, which a millisecond timestamp won't approach
 * for centuries. (`& 0x7f` for the low 7 bits is fine even at this size —
 * 2^32 is a multiple of 128, so ToInt32's modulo-2^32 truncation never
 * touches those low bits — but the shift to get the *next* 7 bits has to be
 * done with real division, not `>>>=`.)
 */
function writeVarint(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining & 0x7f);
  return bytes;
}

/** One protobuf field: tag byte(s) (field number << 3 | wire type) + a
 * varint value. Wire type 0. */
function fieldVarint(fieldNumber: number, value: number): number[] {
  return [...writeVarint(fieldNumber << 3), ...writeVarint(value)];
}

/** One protobuf field: tag byte(s) + a little-endian 4-byte float. Wire type
 * 5 (fixed32) — same encoding option 94's embedded x/y/w/h floats use. */
function fieldFloat(fieldNumber: number, value: number): number[] {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setFloat32(0, value, true);
  return [...writeVarint((fieldNumber << 3) | 5), ...bytes];
}

export interface TrackingBox {
  /** Box centre, normalised 0..1, left-to-right / top-to-bottom. */
  x: number;
  y: number;
  /** Box size, normalised 0..1. Omit to replay the captured 0.1581 x 0.2811 untouched. */
  w?: number;
  h?: number;
}

function buildTrackingBoxBody(box: TrackingBox): Uint8Array {
  const body = hexToBytes(CAPTURED_SET_OPTIONS_94_TEMPLATE_HEX);
  writeFloatLE(body, X_OFFSET, box.x);
  writeFloatLE(body, Y_OFFSET, box.y);
  if (box.w !== undefined) writeFloatLE(body, W_OFFSET, box.w);
  if (box.h !== undefined) writeFloatLE(body, H_OFFSET, box.h);
  return body;
}

/** Fallback box size when a caller omits w/h — the same 0.1581 x 0.2811
 * literal the option-94 template above carries, not anything captured for
 * 237 specifically (every real 237 capture had its own, different w/h — see
 * this file's top comment). In practice TrackingOverlay.vue always supplies
 * w/h from the drawn drag, so this only matters for other callers. */
const FALLBACK_W = 0.1581;
const FALLBACK_H = 0.2811;

/** code 237 body, built fresh (not spliced from a captured template — see
 * this file's top comment, "CANDIDATE 237 IMPLEMENTED", for why there's no
 * unexplained residue here worth preserving): field 1 = now, as a
 * millisecond Unix epoch varint; fields 2-5 = x, y, w, h as floats. */
function buildTrackUserOpsBody(box: TrackingBox): Uint8Array {
  return new Uint8Array([
    ...fieldVarint(1, Date.now()),
    ...fieldFloat(2, box.x),
    ...fieldFloat(3, box.y),
    ...fieldFloat(4, box.w ?? FALLBACK_W),
    ...fieldFloat(5, box.h ?? FALLBACK_H),
  ]);
}

/** Candidate "open tracking" signal — code 217, body `08 01`. */
export function sendOpenTrackingCandidate(): Promise<Uint8Array> {
  return getCameraTransport().command(CODE_OPEN_TRACKING_CANDIDATE, new Uint8Array([0x08, 0x01]));
}

/** Candidate "set the tracking box" write — SET_PHOTOGRAPHY_OPTIONS, option 94. */
export function sendTrackingBoxCandidate(box: TrackingBox): Promise<Uint8Array> {
  return getCameraTransport().command(CODE_SET_PHOTOGRAPHY_OPTIONS, buildTrackingBoxBody(box));
}

/**
 * Whether the camera's own reply to a code-9 (option 94) box write actually
 * confirmed it — see this file's top comment, "FOUND 2026-10-20" entry.
 * CONFIRMED 2026-10-20, from a 4-attempt controlled retest in this app: the
 * two draws David saw engage tracking got this reply back; the two that
 * didn't got an empty body under that same 200 status instead. Field 1 as a
 * *varint* (`08 5e`) is the option number 94 echoed back — contrast
 * CAPTURED_SET_OPTIONS_94_TEMPLATE_HEX's own field 1, a length-delimited
 * submessage (`0a 01 5e`) carrying the same number out; the request and its
 * ack don't share an encoding for that field, so this checks the ack's exact
 * two bytes, not a generic "field 1 == 94".
 */
export function checkBoxWriteConfirmed(response: Uint8Array): boolean {
  return response.length === 2 && response[0] === 0x08 && response[1] === 0x5e;
}

/** Candidate "close/cancel tracking" — code 238, empty body (the "x" tap). */
export function sendCloseTrackingCandidate(): Promise<Uint8Array> {
  return getCameraTransport().command(CODE_CLOSE_TRACKING_CANDIDATE, new Uint8Array(0));
}

/** Tracking Framing — code 244, see CODE_SET_TRACKING_FRAMING_CANDIDATE above.
 * `rect` is top-left origin (x, y, w, h normalised 0..1), exactly as the
 * iPhone app sent it. Reuses 237's body builder because the captured layout is
 * identical; it writes whatever x/y it is given, so the centre-vs-top-left
 * convention is entirely the caller's. */
export function sendSetTrackingFramingCandidate(rect: {
  x: number;
  y: number;
  w: number;
  h: number;
}): Promise<Uint8Array> {
  return getCameraTransport().command(
    CODE_SET_TRACKING_FRAMING_CANDIDATE,
    buildTrackUserOpsBody(rect),
  );
}

/** Candidate PHONE_COMMAND_TRACK_USER_OPS — code 237, timestamp + box. The
 * one candidate with a measured physical correlation so far; see this file's
 * top comment and useTracking.ts's `sendTrackUserOps`. */
export function sendTrackUserOpsCandidate(box: TrackingBox): Promise<Uint8Array> {
  return getCameraTransport().command(CODE_TRACK_USER_OPS_CANDIDATE, buildTrackUserOpsBody(box));
}

/**
 * A short label for a camera-initiated notification code the debug readout
 * has seen, for codes this file happens to know about — never a claim about
 * what the code *means*. Everything here is either independently confirmed
 * elsewhere (8302, per docs/PROTOCOL-GAP.md) or just "seen once before, on
 * this date" (8317, 8199 — see this file's top comment, "NEW NOTIFICATION
 * CODES"); neither of those two has been decoded. Returns null for anything
 * not in this short list, which TrackingOverlay.vue falls back to showing as
 * a bare code number, same as before this existed.
 */
/** code 8315 — strong candidate for the camera's own "tracking stopped"
 * acknowledgment; see this file's top comment, "CODE 8315 = TRACK CLOSE/
 * CANCEL SIGNAL". What this file treats as confirmed is the *code*, not the
 * body — matching on the code alone still catches it if whatever those four
 * fields encode turns out to vary in a case this project hasn't seen yet. */
const CODE_TRACK_CLOSED_NOTIFICATION = 8315;

/** The body every real capture of code 8315 has carried so far — four
 * single-byte protobuf varint fields (1=4, 2=2, 3=5, 4=0), lowercase hex, no
 * residue. Not yet known to ever vary (only 4 samples, all identical) — see
 * "CODE 8315" in this file's top comment for where these came from.
 * `checkTrackClosedNotification` below reports whether a real notification's
 * body matches this exactly, separately from whether its code matches, so a
 * body that turns out to differ is visible rather than silently ignored. */
const TRACK_CLOSED_BODY_HEX = "0804100218052000";

export interface TrackClosedCheck {
  /** code === 8315, the signal this file's confidence is actually based on. */
  isCandidate: boolean;
  /** Whether the body is byte-identical to every real capture seen so far.
   * Only meaningful when `isCandidate` is true; a mismatch here on a real
   * notification would be a genuinely new, worth-recording data point, not
   * a reason to distrust `isCandidate`. */
  matchesKnownBody: boolean;
}

/** Checks a camera-initiated notification against the "tracking stopped"
 * signal documented in this file's top comment, "CODE 8315 = TRACK CLOSE/
 * CANCEL SIGNAL" — found by correlating four CLOSE_TRACKING (238) sends in
 * Tracking Data Small.pcapng against their matching iPhone screen recording.
 * useTracking.ts calls this on every notification that arrives while the
 * experiment is enabled, to set `cameraConfirmedTrackingOff` — the first
 * real camera-reported tracking status this investigation has had, as
 * opposed to DEEP_TRACK's confirmed-unreliable readback or no signal at all.
 *
 * NOT YET confirmed against this desktop app's *own* traffic — the capture
 * behind this is of the official iPhone app talking to the camera, plus one
 * live sighting of code 8315 in this app's own debug readout that wasn't a
 * byte-exact capture. The next real test of this is simply using the app:
 * if `cameraConfirmedTrackingOff` actually flips to true after a cancel
 * during a live session, that's the confirmation this still needs. */
export function checkTrackClosedNotification(code: number, bodyHex: string): TrackClosedCheck {
  return {
    isCandidate: code === CODE_TRACK_CLOSED_NOTIFICATION,
    matchesKnownBody: bodyHex.toLowerCase() === TRACK_CLOSED_BODY_HEX,
  };
}

export function describeNotificationCode(code: number): string | null {
  switch (code) {
    case 8302:
      return "PTZ_STATE (confirmed, see docs/PROTOCOL-GAP.md) — not decoded further here";
    case 8315:
      return 'strong candidate for a TRACK CLOSE/CANCEL ack — see trackingCandidates.ts\'s "CODE 8315" note';
    case 8317:
      return "unknown — first seen 2026-10-19 live test, not decoded";
    case 8199:
      return "unknown — first seen 2026-10-19 live test, not decoded";
    default:
      return null;
  }
}
