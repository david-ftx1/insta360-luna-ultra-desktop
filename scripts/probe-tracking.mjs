#!/usr/bin/env node
// Test the Deep Track / subject-tracking candidates found in a 2026-10-18
// packet capture of the genuine Insta360 app turning tracking on and off
// (Tracking_Enable_Disable.pcapng, captured over USB via rvictl while the
// app drove the camera — see docs/PROTOCOL-GAP.md's "Subject tracking"
// section for why this needed a capture rather than GET/SET_OPTIONS probing).
//
// Three candidates came out of that capture, all previously unseen. What was
// actually done on the phone during the capture (per David, after the fact):
// tracking was turned ON by drawing a box around his face on the live
// preview, and turned OFF by tapping a small "x" in the box's top-right
// corner — not a simple toggle switch. That account lines up with the byte
// evidence better than a plain on/off would:
//
//   - PhotographyOptionType 94 (not in our schema — DEEP_TRACK is 91) written
//     via ordinary SET_PHOTOGRAPHY_OPTIONS, five times in a row, each body
//     `state=1` + 4 floats. The first two floats (x, y) moved between writes;
//     the last two (w, h) stayed byte-for-byte IDENTICAL at 0.1581/0.2811
//     across all five. A box with a FIXED size whose position is repeatedly
//     resent while the finger is still moving matches "draw/position a box
//     around a face" far better than a free-drag resize would (a drag that
//     actually resized the box would move w/h too) — this reads as the app
//     repositioning a fixed-size target reticle as the tap/drag lands.
//     TOP CANDIDATE for the actual enable — "open tracking with this rect" —
//     and it rides the exact write mechanism (SET_PHOTOGRAPHY_OPTIONS) this
//     app already drives successfully for ISO/colour/etc. Try this FIRST.
//   - code 217 (phone->camera, body `08 01` — a single varint field = 1),
//     fired once right before the option-94 cluster began, and three more
//     times clustered where the continuous rect pushes (below) start. Could
//     be a companion "enable" signal sent alongside the box, or unrelated —
//     try this if set-box alone doesn't visibly start tracking.
//   - code 237 (phone->camera, body = a millisecond epoch timestamp + 4
//     floats), fired 6 times, ALL FOUR floats moving each time (unlike
//     option 94's fixed-size writes) — consistent with continuous telemetry
//     of a box that is now actively following a moving face, i.e. tracking
//     already engaged and reporting back. Not something to send to turn
//     tracking on; more likely what the real app sends/receives *while*
//     Deep Track is running. Low priority to replay deliberately.
//   - code 238 (phone->camera, empty body), fired once mid-session (req 125)
//     and once as the very last frame of the whole capture (req 130). A
//     single clean empty-body command matches "tap one x button" far better
//     than a continuous push does — STRONG CANDIDATE for the close/cancel
//     tap. The mid-session one may be an earlier, undone attempt — David
//     described "eventually" finding the right x button, implying some
//     trial and error before the one that stuck (req 130, end of capture).
//
// Nothing here is confirmed — this script exists to test each candidate
// against the real camera and watch what the camera's own screen does, the
// same bar every other control in this project had to clear (see
// FEATURES.md's "How something moves from WIP to shipped", step 2).
//
// Three isolated, beep-synced, filmed runs (open alone, close held apart
// from the park by several seconds) all showed ZERO physical effect from
// any candidate. Before reading that as "these codes are wrong", consider:
// none of those runs had anyone in frame. Per David, the real app's own
// tracking refuses to engage against an indistinct scene (same as the
// physical camera's one-button auto-detect failing against a blank wall) —
// so a clean negative against an empty desk may just mean there was nothing
// to lock onto, not that open/set-box/close are the wrong commands. The
// settle/wait/post-close delays below were lengthened specifically so a
// person has time to get in frame and move around during each window —
// that is now as important as which candidate gets sent.
//
// Usage (camera must be connected over Wi-Fi, no other control session open —
// our own app's connection, if any, must be disconnected first). set-box and
// close, tried alone with live view properly up, left DEEP_TRACK's status
// frozen through both — neither candidate moved it on its own. TRY THIS NEXT:
//   node scripts/probe-tracking.mjs all [--x 0.46] [--y 0.3]
//                                                            # open (code 217),
//                                                            # set-box (option
//                                                            # 94), wait 5s,
//                                                            # close (code 238)
//                                                            # — the real
//                                                            # capture's own
//                                                            # order, code 217
//                                                            # always fired
//                                                            # before the box
//                                                            # writes began.
//                                                            # x/y (0..1, left
//                                                            # to right / top
//                                                            # to bottom) is
//                                                            # where to aim
//                                                            # the box; point
//                                                            # it at a face.
// The three can still be run individually to isolate which step (if any)
// actually moves DEEP_TRACK's status:
//   node scripts/probe-tracking.mjs open                   # just code 217
//   node scripts/probe-tracking.mjs set-box [--x 0.46] [--y 0.3]
//                                                            # just option 94
//   node scripts/probe-tracking.mjs close                  # just code 238
//
// Every line of output is timestamped (this machine's local clock,
// HH:MM:SS.mmm). Three delay flags, all lengthened to give a person time to
// get in frame and move around, not just let the gimbal settle:
//   --settle MS (default 6000) — before the first tracking send. Originally
//     just to let the gimbal's wake transition finish (a filmed run without
//     this pause showed the gimbal re-park and re-open a few seconds in);
//     now also the window to get in frame, facing the camera, roughly
//     centered — that's where the box (x=0.46, y=0.3 by default) lands.
//   --wait-before-close MS (default 8000) — after set-box, before close.
//     Move side to side here: a subject that stays still and centered gives
//     a working tracker nothing to visibly follow.
//   --post-close MS (default 6000) — see below.
//
// Clock-based correlation against a filmed run did not hold up: the video
// file's own embedded timestamp came back about 90s off from this script's
// log (phone/camera clocks drift — not unusual, just not usable here). So
// the script now also beeps (ASCII BEL) at the moments that matter: a fast
// 4-beep burst right as the settle delay starts — GET IN FRAME NOW — then
// slow, discrete dings counting the step: once right before open/set-box,
// twice right before close, three times right before exitLiveView's park.
// The fast burst is rhythmically distinct from the slow dings on purpose,
// so it can't be miscounted as a 4th "step" beep when listening back. Turn
// the terminal's audible bell on first —
// Terminal.app: Settings > Profiles > Advanced > Bell > "Audible bell";
// iTerm2: Preferences > Profiles > Terminal > Bell > "Audible bell" — and a
// phone recording the camera will pick the beep(s) up on its own microphone,
// giving a sync marker in the recording itself that doesn't depend on any
// clock lining up. This worked well in the first filmed run that used it:
// audio put open/set-box and close within a couple hundred ms of where the
// log said they'd be. It also exposed a real gap, though — close() and the
// park (exitLiveView's SET_VIEW_MODE(file), already-confirmed behaviour)
// fired only ~30ms apart, and the one clear gimbal movement in that run
// landed right in between, so it could not be credited to close() with any
// confidence. --post-close MS (default 6000) now holds the gimbal in the
// post-close state for several seconds, with its own 3-beep marker, before
// the park happens — so close()'s own effect, if it has one, gets a clean
// window to show up in before the unrelated park confounds it. Keep moving
// during this window too, for the same reason as --wait-before-close.
//
// Watch the camera's own screen after each step — that is the bar, per
// FEATURES.md's "How something moves from WIP to shipped" step 2: a write
// the camera accepts and echoes back is not evidence by itself.
//
// The capture this is built from was taken in FUNCTION_MODE_NORMAL_VIDEO
// (Video mode); test from that same mode first, since this project has
// already found at least one other photography option (RECORD_RESOLUTION)
// whose acceptance depends on which capture mode the camera is in.
//
// The camera's own little screen goes dark/locked while a Wi-Fi control
// session is active, so it cannot be used to confirm any of this. Two other
// ways to confirm, neither needing that screen:
//
//   1. This script reads DEEP_TRACK (PhotographyOptionType 91 — the field
//      PROTOCOL-GAP.md already confirmed is a live read-only status mirror,
//      with a nested `state` that flips 2 <-> 5 as tracking goes off/on)
//      before and after every action, automatically. No visual check needed
//      — if a candidate is right, the printed state changes.
//   2. Deep Track drives the gimbal to keep the subject framed. If a write
//      actually starts tracking, the camera body itself should visibly
//      pan/tilt to follow a face moved around in front of it — watch the
//      camera, not its screen.
//
// IMPORTANT, found the hard way: a first run against a bare control
// connection (no live view started) left DEEP_TRACK's state frozen at the
// same value (3) before, during and after every candidate — no movement at
// all. In Tracking_Enable_Disable.pcapng, START_LIVE_STREAM fired well
// before any tracking write; Deep Track almost certainly cannot do anything
// — gimbal included — while the camera is not actually in live/camera view.
// So this script now opens live view itself first (the same
// CODE_UNKNOWN_17/85 + CODE_SET_VIEW_MODE(camera) + START_LIVE_STREAM
// sequence `src-tauri/src/liveview.rs` sends, byte-for-byte from the same
// capture) before touching any tracking candidate, and closes it the same
// way afterwards so the camera is not left straddling a half-open session.
// The gimbal opening when this script's live view starts, and parking again
// when it ends, is expected — that part is confirmed, not a candidate.

import { CODE, LunaSession, fieldVarint } from "./lib/ucd2.mjs";
import { decodeRaw } from "./lib/protobuf.mjs";

const SET_PHOTOGRAPHY_OPTIONS = CODE.SET_PHOTOGRAPHY_OPTIONS; // 9
const GET_PHOTOGRAPHY_OPTIONS = CODE.GET_PHOTOGRAPHY_OPTIONS; // 10
const START_LIVE_STREAM = CODE.START_LIVE_STREAM; // 1
const STOP_LIVE_STREAM = CODE.STOP_LIVE_STREAM; // 2
const CODE_UNKNOWN_17 = 17;
const CODE_UNKNOWN_85 = 85;
const CODE_SET_VIEW_MODE = 118;
const VIEW_MODE_FILE = 1;
const VIEW_MODE_CAMERA = 5;
const CODE_OPEN_TRACKING_CANDIDATE = 217;
// Unused here (kept for reference; the live app sends 237) — underscore keeps oxlint quiet.
const _CODE_TRACK_USER_OPS_CANDIDATE = 237;
const CODE_CLOSE_TRACKING_CANDIDATE = 238;
const DEEP_TRACK_OPTION = 91; // readable, but its "state" claim is retracted — see readDeepTrack's comment

/** Same tiny_flag_body() as liveview.rs: wire field 1 = 1, i.e. `08 01`. */
const TINY_FLAG_BODY = fieldVarint(1, 1);
/** wire_field_varint(1, VIEW_MODE_CAMERA) / (..., VIEW_MODE_FILE) from liveview.rs's own tests. */
const viewModeBody = (mode) => fieldVarint(1, mode);
/**
 * build_start_live_stream_body() from liveview.rs, byte-for-byte — this is
 * literally req 78's body from Tracking_Enable_Disable.pcapng, the same
 * capture the tracking candidates came from, so it's known to work against
 * this exact camera/firmware.
 */
const START_LIVE_STREAM_BODY = Buffer.from("10012080f702382b500e6001", "hex");

const args = process.argv.slice(2);
const sub = args.find((a) => !a.startsWith("--")) ?? "help";
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : fallback;
};

const HOST = process.env.LUNA_HOST ?? "192.168.42.1";
const X = flag("x", undefined); // captured range was ~0.46-0.48; omit to replay the exact captured byte
const Y = flag("y", undefined); // captured range was ~0.03-0.11; omit to replay the exact captured byte
// How long to sit idle after live view comes up (gimbal wake included) before
// sending the first tracking candidate. Originally just to let the gimbal's
// wake transition finish (a filmed run without this showed it briefly
// re-park and re-open a few seconds in, for reasons that couldn't be pinned
// on any specific command). Bumped from 3000 to 6000: three clean, isolated
// runs all showed zero physical effect from open/set-box/close, and the
// likeliest explanation isn't that the commands are wrong — it's that there
// was nothing in front of the lens for the camera to lock onto (the real
// app's own tracking refuses to engage against an indistinct scene, same as
// the physical camera's one-button auto-detect does against a blank wall).
// That means a person now needs to actually get in frame before each send,
// which needs more lead time than "finish a gimbal transition" did.
const SETTLE_MS = flag("settle", 6000);
// How long to wait after set-box, before close(238) fires. Was a hardcoded
// 5000ms; now a flag, bumped to 8000 default — enough time to get in frame
// AND move side to side, since a subject that stays centered and still gives
// a working tracker nothing to visibly follow (gimbal pan is the only
// oracle that's held up so far, and it only shows up if the subject moves).
const WAIT_BEFORE_CLOSE_MS = flag("wait-before-close", 8000);
// How long to wait after close(238)'s response, before exitLiveView() parks
// the gimbal (SET_VIEW_MODE(file) — already-confirmed, unrelated behaviour).
// Added because a filmed run showed close() and the park landing only ~30ms
// apart in the log, with the one clear gimbal movement in that run sitting
// right in that gap — impossible to credit to close() without first ruling
// the park out. This pause (with its own 3-beep marker before the park)
// gives close() room to show an effect on its own, if it has one at all.
// Bumped from 4000 to 6000 for the same move-around reason as above.
const POST_CLOSE_MS = flag("post-close", 6000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** HH:MM:SS.mmm on THIS MACHINE'S clock. Fixed from an earlier version of
 * this script that used toISOString(), which is UTC — mislabelled "local
 * clock" in a comment, which would have made the printed times look ~1h off
 * from a wall clock/phone during BST/IST. Still not synced to the camera or
 * to whatever clock a phone's video file gets timestamped with (a filmed run
 * came back with the video's own embedded creation time about 90s off from
 * this script's log — camera/phone clocks drift and that is normal) — see
 * beep() below for a sync method that sidesteps clocks entirely. */
function ts() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** console.log with a timestamp prefix on every line, so a filmed run can be
 * correlated frame-exact afterwards instead of guessed from gimbal motion. */
function log(...args) {
  console.log(`[${ts()}]`, ...args);
}

/**
 * Rings the terminal's audible bell (ASCII BEL) `times` times, `gapMs` apart
 * (default 150ms — slow, discrete dings). If the terminal's audible bell is
 * turned on — Terminal.app: Settings > Profiles > Advanced > Bell > "Audible
 * bell"; iTerm2: Preferences > Profiles > Terminal > Bell > "Audible bell" —
 * a phone recording the camera during a run will also pick the beep(s) up on
 * its own microphone. That gives a sync marker in the actual recording that
 * does not depend on any clock lining up — not this script's, not the
 * camera's, not the phone's — which matters, since clock-based correlation
 * did not hold up last time. Used as a simple code: 1 slow beep marks the
 * open/set-box moment, 2 marks close, 3 marks the park — so which one just
 * happened is audible in the recording itself, not just inferred from
 * timing. getInFrameBeep() below reuses this with a fast gap for a cue
 * that's rhythmically distinct from all three, instead of overloading the
 * count (a 4th slow beep would be easy to miscount against the 3-beep park
 * cue when listening back).
 */
async function beep(times, gapMs = 150) {
  for (let i = 0; i < times; i++) {
    process.stdout.write("\x07");
    if (i < times - 1) await sleep(gapMs);
  }
}

/**
 * The "get in frame" cue: a fast burst, rhythmically distinct from the slow,
 * discrete 1/2/3-beep markers (open/close/park) so it can't be confused with
 * any of them on playback. Fires right as the settle delay begins — i.e. as
 * early as possible — so there's as much of that window as possible left to
 * actually get in position after hearing it.
 */
async function getInFrameBeep() {
  await beep(4, 80);
}

function floatLE(value) {
  const buf = Buffer.alloc(4);
  buf.writeFloatLE(value, 0);
  return buf;
}

/**
 * req 96 from Tracking_Enable_Disable.pcapng, byte-for-byte — the real app's
 * actual SET_PHOTOGRAPHY_OPTIONS write, captured live. This is deliberately
 * NOT reconstructed field-by-field: the submessage carries four other fields
 * (20, 21 — both empty; 31 and 88 — both varint 1) ahead of field 94, of
 * unknown purpose, that a from-scratch rebuild would have dropped. Replaying
 * the exact bytes and splicing only the two floats that are known to vary
 * (x, y at byte offsets 23 and 28) keeps every byte we don't understand
 * exactly as the real app sent it, which matters when so much of this body
 * is still unexplained.
 *
 * `08 01` = field1 state=1. `15 <f32> 1d <f32>` = fields 2,3 = x, y
 * (fixed32/float, the ones that moved across the five captured writes).
 * `25 55ef213e 2d 2ff18f3e` = fields 4,5 = w=0.1581, h=0.2811 — identical
 * across every captured write, left untouched here.
 */
const CAPTURED_SET_OPTIONS_94_TEMPLATE = Buffer.from(
  "0a015e1225a20100aa0100f80101c00501f20516080115dff6ea3e1db30f0c3d2555ef213e2d2ff18f3e1807",
  "hex",
);
const X_OFFSET = 23;
const Y_OFFSET = 28;

function buildTrackingBoxBody(x, y) {
  const body = Buffer.from(CAPTURED_SET_OPTIONS_94_TEMPLATE); // copy
  if (x !== undefined) floatLE(x).copy(body, X_OFFSET);
  if (y !== undefined) floatLE(y).copy(body, Y_OFFSET);
  return body;
}

function report(label, frame) {
  if (!frame) {
    log(`${label}: no response (timed out)`);
    return;
  }
  log(`${label}: ${frame.body.length}B  ${frame.body.toString("hex")}`);
  for (const record of decodeRaw(frame.body)) {
    const value =
      record.value instanceof Buffer
        ? `${record.value.length}B 0x${record.value.toString("hex")}`
        : record.value;
    console.log(`  field ${record.field} (wire ${record.wire}) = ${value}`);
  }
}

/** Recursively decodes length-delimited fields too, since a GET_PHOTOGRAPHY_OPTIONS
 * response nests the requested option inside at least one wrapper message. */
function decodeNested(buffer, indent = 1, depth = 0) {
  if (depth > 3) return;
  const pad = "  ".repeat(indent);
  for (const record of decodeRaw(buffer)) {
    if (record.value instanceof Buffer) {
      const flag = record.field === DEEP_TRACK_OPTION ? "  <-- DEEP_TRACK" : "";
      console.log(
        `${pad}field ${record.field} (wire ${record.wire}) = ${record.value.length}B 0x${record.value.toString("hex")}${flag}`,
      );
      decodeNested(record.value, indent + 1, depth + 1);
    } else {
      console.log(`${pad}field ${record.field} (wire ${record.wire}) = ${record.value}`);
    }
  }
}

/**
 * Reads DEEP_TRACK (option 91) and prints its nested fields. RETRACTED as a
 * verification oracle: FEATURES.md claimed this field's nested `state`
 * flips 2 <-> 5 as Deep Track goes off/on, but checking that against
 * Tracking_Enable_Disable.pcapng disproved it. The real app itself read
 * this field 16 times before tracking started, and every single read came
 * back byte-for-byte identical (fields 2,2,3,3) — it never changed, not
 * even once, including right up to the moment tracking actually began. The
 * app also switched to polling a *different* field (99, a repeated
 * sub-message carrying two {counter, small-int} pairs) continuously once
 * tracking was active — and across 6 of those reads spanning the whole
 * active window, in the SAME real capture, that came back identical too.
 * So neither of this camera's apparent "tracking status" fields moves at
 * all in the one capture we have ground truth for, even during confirmed
 * genuine use. A static reading here is not evidence a candidate failed —
 * it is not evidence of anything. Kept only for visibility into the raw
 * bytes; DO NOT read "unchanged" as "the write did nothing." The gimbal is
 * the only confirmed-reliable signal this project has found so far (see
 * `enterLiveView`'s doc comment) — watch the camera body, not these numbers.
 */
async function readDeepTrack(session, label) {
  log(
    `\n-- DEEP_TRACK (option 91) raw bytes (not a reliable live indicator — see comment): ${label} --`,
  );
  const frame = await session.send(GET_PHOTOGRAPHY_OPTIONS, Buffer.from("0a015b1007", "hex"));
  if (!frame) {
    console.log("  no response (timed out)");
    return;
  }
  console.log(`  ${frame.body.length}B  ${frame.body.toString("hex")}`);
  decodeNested(frame.body);
}

/**
 * Mirrors `start_stream(..., send_view_mode: true)` in src-tauri/src/liveview.rs:
 * CODE_UNKNOWN_17 once, CODE_UNKNOWN_85 twice (constant-body telemetry the
 * real app always sends first), then CODE_SET_VIEW_MODE(CAMERA) — the call
 * that actually wakes the gimbal — then CODE_START_LIVE_STREAM. Needed
 * before any tracking candidate: DEEP_TRACK's status never moved at all in
 * a first run that skipped this.
 */
async function enterLiveView(session) {
  log("\n-- entering live view (CODE_UNKNOWN_17/85, SET_VIEW_MODE(camera), START_LIVE_STREAM) --");
  await session.send(CODE_UNKNOWN_17, TINY_FLAG_BODY);
  await session.send(CODE_UNKNOWN_85, TINY_FLAG_BODY);
  await session.send(CODE_UNKNOWN_85, TINY_FLAG_BODY);
  const viewModeFrame = await session.send(CODE_SET_VIEW_MODE, viewModeBody(VIEW_MODE_CAMERA));
  report("SET_VIEW_MODE(camera) response", viewModeFrame);
  const streamFrame = await session.send(START_LIVE_STREAM, START_LIVE_STREAM_BODY);
  report("START_LIVE_STREAM response", streamFrame);
  log(
    "the gimbal opening now is expected — watch for that as confirmation live view is actually up.",
  );
}

/** Mirrors `stop_stream(..., send_view_mode: true)`: STOP_LIVE_STREAM then CODE_SET_VIEW_MODE(FILE). */
async function exitLiveView(session) {
  log("\n-- leaving live view (STOP_LIVE_STREAM, SET_VIEW_MODE(file)) --");
  await session.send(STOP_LIVE_STREAM, Buffer.alloc(0));
  await session.send(CODE_SET_VIEW_MODE, viewModeBody(VIEW_MODE_FILE));
}

async function openTracking(session) {
  log(`\n-- code ${CODE_OPEN_TRACKING_CANDIDATE} (candidate: OPEN_TRACKING) --`);
  const frame = await session.send(CODE_OPEN_TRACKING_CANDIDATE, fieldVarint(1, 1));
  report("response", frame);
}

async function setBox(session) {
  log(
    `\n-- SET_PHOTOGRAPHY_OPTIONS, option 94 (candidate: track box), x=${X ?? "(captured)"} y=${Y ?? "(captured)"} --`,
  );
  const body = buildTrackingBoxBody(X, Y);
  console.log(`  request body: ${body.toString("hex")}`);
  const frame = await session.send(SET_PHOTOGRAPHY_OPTIONS, body);
  report("response", frame);
}

async function closeTracking(session) {
  log(`\n-- code ${CODE_CLOSE_TRACKING_CANDIDATE} (candidate: CLOSE_TRACKING) --`);
  const frame = await session.send(CODE_CLOSE_TRACKING_CANDIDATE, Buffer.alloc(0));
  report("response", frame);
}

async function main() {
  if (sub === "help" || !["open", "set-box", "close", "all"].includes(sub)) {
    console.log(
      "usage: node scripts/probe-tracking.mjs <open|set-box|close|all> [--x N] [--y N] [--settle MS] [--wait-before-close MS] [--post-close MS]",
    );
    process.exit(sub === "help" ? 0 : 1);
  }

  const session = new LunaSession(HOST);
  session.onUnsolicited = (frame) => {
    // frame.code is undefined for non-FILE-type frames — once live view is up,
    // that is almost entirely the H.264 elementary stream itself arriving
    // over the same TCP connection (confirmed: a first run flooded the
    // output with hundreds of these the moment START_LIVE_STREAM succeeded).
    // Not interesting here, so only log frames that carry an actual message
    // code — a real unsolicited notification from the camera.
    if (frame.code === undefined) return;
    log(`\n(unsolicited) code ${frame.code} req ${frame.requestId ?? "?"}`);
  };
  log(`connecting to ${HOST}:6666 ...`);
  await session.connect();
  log("connected. The camera's own screen is dark/locked during a Wi-Fi session, and the");
  console.log(
    "DEEP_TRACK status this script prints is confirmed NOT reliable (it never changed even",
  );
  console.log(
    "in the real app's own capture, during genuine tracking use) — so the only check that has",
  );
  console.log(
    "actually held up so far is physical: watch whether the camera body pans/tilts to follow",
  );
  console.log(
    "a face. If you can, film the camera with another phone/camera during this run so you can",
  );
  console.log(
    "review it afterwards — it moves fast and there's a lot of terminal output to read at the same time.",
  );
  console.log(
    "Every line below is timestamped (this machine's clock) — but if you're correlating against a",
  );
  console.log(
    "phone video, trust the beeps over the clocks: the camera/phone's own timestamp can drift from",
  );
  console.log(
    "this machine's by a surprising amount. Make sure the terminal's audible bell is on so the",
  );
  console.log(
    "beeps actually make a sound your phone's mic can pick up: fast beep-beep-beep-beep = get in",
  );
  console.log(
    "frame NOW, then slow dings count the step — 1 = open/set-box, 2 = close, 3 = about to park",
  );
  console.log("(that one's the already-known behaviour, not new evidence).");
  console.log(
    "IMPORTANT: be in frame, facing the camera, before the 1-beep moment — the last three runs",
  );
  console.log(
    "showed no effect from any candidate, most likely because there was nothing in front of the",
  );
  console.log("lens to lock onto, not because the commands are wrong. Move around when told to.");
  console.log(
    `Settle before first tracking send: ${SETTLE_MS}ms (--settle). Wait before close: ${WAIT_BEFORE_CLOSE_MS}ms (--wait-before-close).`,
  );
  console.log(`Pause after close, before park: ${POST_CLOSE_MS}ms (--post-close).`);

  await enterLiveView(session);

  // Give the gimbal time to finish its wake transition (and the camera's own
  // Wi-Fi/session bookkeeping time to settle) before anything tracking-related
  // goes out. A filmed run without this pause showed the gimbal briefly
  // re-park and re-open a few seconds after SET_VIEW_MODE(camera)/
  // START_LIVE_STREAM, for reasons that couldn't be tied to any specific
  // command — most likely the candidates landed while that transition was
  // still in progress. This removes that ambiguity from the next run.
  log(
    `\n-- settling ${SETTLE_MS}ms before the first tracking send (let the gimbal finish opening) --`,
  );
  log("(audio cue: fast beep-beep-beep-beep — GET IN FRAME NOW; distinct rhythm from the slow");
  log("1/2/3-beep markers below so it can't be confused with them)");
  await getInFrameBeep();
  log("Face the camera, roughly centered, a little above the middle of frame — that's where the");
  log("box (x=0.46, y=0.3 by default) will land. Nothing to lock onto is the likeliest reason the");
  log("last three runs showed no effect at all, not that the commands are wrong.");
  await sleep(SETTLE_MS);

  await readDeepTrack(session, "before");

  // set-box and close, tried in isolation (with live view now properly up),
  // left DEEP_TRACK's status frozen at the same value through both — neither
  // candidate alone moved it. The one combination not yet tried is the real
  // capture's own order: code 217 fired before every cluster of box-position
  // writes, every time. "all" now replays that full order — open, set-box,
  // wait, close — instead of skipping "open" as it used to.
  if (sub === "open" || sub === "all") {
    log("(audio cue: 1 beep — marks the open/set-box moment; listen for it in your recording)");
    await beep(1);
    await openTracking(session);
    await readDeepTrack(session, "after open");
  }
  if (sub === "set-box" || sub === "all") {
    await setBox(session);
    await readDeepTrack(session, "after set-box");
  }
  if (sub === "all") {
    log(`\nwaiting ${WAIT_BEFORE_CLOSE_MS}ms before closing — MOVE: step side to side now.`);
    log(
      "A subject that stays still and centered gives a working tracker nothing to visibly follow —",
    );
    log(
      "the gimbal pan is the only oracle that's held up so far, and it only shows up on movement.",
    );
    await sleep(WAIT_BEFORE_CLOSE_MS);
  }
  if (sub === "close" || sub === "all") {
    log("(audio cue: 2 beeps — marks the close moment; listen for it in your recording)");
    await beep(2);
    await closeTracking(session);
    await readDeepTrack(session, "after close");

    // The last filmed run put close() and exitLiveView()'s park only ~30ms
    // apart in the log — far too close to tell apart on video, and the one
    // clear gimbal movement in that run landed right in that 30ms gap. Since
    // SET_VIEW_MODE(FILE) parking the gimbal is already confirmed, separate
    // behaviour, that movement cannot be credited to close(238) without first
    // ruling the park out — hence this pause, with its own 3-beep marker, so
    // any effect from close() alone has room to show up well before the park
    // that was already going to happen regardless of what close() did.
    log(
      `\nwaiting ${POST_CLOSE_MS}ms before parking (watch for ANY movement in this window — it can only be close(238), the park hasn't happened yet)...`,
    );
    await sleep(POST_CLOSE_MS);
    log(
      "(audio cue: 3 beeps — marks the park moment, i.e. the already-known SET_VIEW_MODE(file) behaviour; movement from here on is NOT new evidence)",
    );
    await beep(3);
  }

  await exitLiveView(session);
  session.close();
  log("\ndone.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
