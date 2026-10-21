/// <reference lib="webworker" />
import { HEVCDecoder } from "@hevcjs/core";
import type { HEVCFrame } from "@hevcjs/core";
import { yuvToRgba } from "../utils/yuv";
import type { YuvFrame } from "../utils/yuv";

/**
 * Software HEVC decode, off the main thread, for the one platform where the
 * native path is a dead end: WKWebView refuses `VideoDecoder.configure()` for
 * every HEVC parameter combination the camera's Live View stream can produce
 * (see LiveView.vue), independent of codec string, description bytes, or
 * hardware-acceleration mode. `@hevcjs/core` decodes the same Annex-B bytes
 * entirely in WASM, bypassing VideoToolbox/WebCodecs altogether.
 */

export type HevcSoftwareRequest =
  | { type: "init"; wasmJsUrl: string; wasmBinaryUrl: string }
  /** Recreate the decoder from the next keyframe, mirroring resetDecoderState(). */
  | { type: "reset" }
  /** `chunk` is one or more complete Annex-B NAL units, start-code framed. */
  | { type: "feed"; chunk: ArrayBuffer }
  | { type: "destroy" };

export type HevcSoftwareResponse =
  | { type: "ready" }
  /**
   * Posted once, right before the first "ready", from a microbenchmark that
   * touches no real decode data at all — see `runSelfTest()` below. Tells
   * apart two very different explanations for yuvToRgba() costing ~190ms at
   * 720p: either this worker's JS execution is slow across the board (e.g.
   * an optimizing JIT tier that never engages here), in which case even this
   * trivial loop costs about the same; or it's specific to that function's
   * own code shape, in which case this stays fast.
   */
  | {
      type: "selftest";
      scalarMs: number;
      typedArrayMs: number;
      nestedNoDivMs: number;
      nestedOneReadMs: number;
      flatMathMs: number;
      threeReadsNoMathMs: number;
      oneReadWithMathMs: number;
      roundedMs: number;
      fixedPointMs: number;
      realFunctionMs: number;
      checksum: number;
    }
  | { type: "frame"; rgba: ArrayBuffer; width: number; height: number }
  /** One per "feed" request, once feed()+drain() for it have both returned —
   * lets the client measure how far the worker's own message queue has
   * fallen behind, regardless of how many (if any) frames that unit produced.
   * A first decode/convert split put ~190ms of the ~230ms total at 720p in
   * "convert" — far more than a per-pixel loop over ~920,000 pixels should
   * ever cost once JIT-optimized. Split further into the three things
   * `postFrame()` actually does, summed across every frame this feed() call
   * produced, so it's clear which one is actually slow: `allocMs` (a fresh
   * `Uint8ClampedArray` per frame), `mathMs` (the `yuvToRgba()` loop itself),
   * `postMs` (`postMessage()` with the transferred buffer — WebKit's
   * transfer path is not guaranteed to be the zero-copy pointer move the
   * spec allows). */
  | {
      type: "fed";
      decodeMs: number;
      allocMs: number;
      mathMs: number;
      postMs: number;
      frameCount: number;
    }
  | { type: "error"; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

let decoder: HEVCDecoder | null = null;
let wasmJsUrl: string | null = null;
let wasmBinaryUrl: string | null = null;

/**
 * `@hevcjs/core`'s WASM glue file (wasm/hevc-decode.js) is a classic
 * Emscripten UMD build with no ESM `export` statement — dynamically
 * `import()`-ing it yields an empty namespace object, and `importScripts()`
 * (the normal fix) is unavailable in a `type: "module"` worker. Fetching its
 * source and running it with indirect eval executes it in global scope, so
 * its top-level `var HEVCDecoderModule = ...` attaches to this worker's own
 * `self`, exactly as a classic `<script>` tag would.
 */
let glueLoaded: Promise<void> | null = null;

function loadGlue(wasmJsUrl: string): Promise<void> {
  glueLoaded ??= (async () => {
    const response = await fetch(wasmJsUrl);
    if (!response.ok) throw new Error(`hevc-decode.js fetch failed: ${response.status}`);
    const source = await response.text();
    // Indirect eval (the `(0, eval)` form) runs in global scope rather than
    // this function's — required for the var declaration to land on `self`.
    // tauri.conf.json sets `security.csp: null`, so this is not CSP-blocked.
    (0, eval)(source);
  })().catch((cause: unknown) => {
    glueLoaded = null;
    throw cause;
  });
  return glueLoaded;
}

async function createDecoder(): Promise<HEVCDecoder> {
  await loadGlue(wasmJsUrl!);
  // Passing wasmBinaryUrl explicitly overrides Emscripten's own
  // scriptDirectory-relative lookup, which — reached via eval rather than
  // importScripts()/<script> — would otherwise resolve against this worker's
  // own bundled chunk location instead of the public /hevc/ asset directory.
  return await HEVCDecoder.create({ wasmBinaryUrl: wasmBinaryUrl! });
}

/** Accumulates the three-way timing split across every frame one "feed" produced. */
interface PostFrameTiming {
  allocMs: number;
  mathMs: number;
  postMs: number;
}

function postFrame(frame: HEVCFrame, timing: PostFrameTiming) {
  const allocStartedAt = performance.now();
  const rgba = new Uint8ClampedArray(frame.width * frame.height * 4);
  timing.allocMs += performance.now() - allocStartedAt;

  const mathStartedAt = performance.now();
  yuvToRgba(frame, rgba);
  timing.mathMs += performance.now() - mathStartedAt;

  const postStartedAt = performance.now();
  const response: HevcSoftwareResponse = {
    type: "frame",
    rgba: rgba.buffer,
    width: frame.width,
    height: frame.height,
  };
  scope.postMessage(response, [rgba.buffer]);
  timing.postMs += performance.now() - postStartedAt;
}

/**
 * See the "selftest" response variant above. `n`/width/height match one
 * 720p 4:2:0 frame so every number here is directly comparable to a real
 * `yuvToRgba()` call (~190-200ms observed). A first round (scalar,
 * typedArray, nestedNoDiv, realFunction) showed scalar/typedArray fast
 * (4-10ms) but nestedNoDiv already ~150ms — nearly as slow as the real
 * function (~217ms) despite swapping its one division for a bit shift, so
 * the division wasn't the cost. nestedNoDiv differs from typedArray in two
 * ways at once though (nested row/col loop *and* 3 reads + full Rec.709
 * arithmetic) — these two more isolate which one actually is:
 *   nestedOneRead  — the nested row/col loop shape, but back to one array
 *                    read and a trivial write like typedArray. Isolates
 *                    whether nesting itself costs anything.
 *   flatMath       — the flat single loop like typedArray, but with the 3
 *                    reads and full Rec.709 arithmetic added back (reading
 *                    cb/cr at the same index as y, i.e. 4:4:4 — the point is
 *                    the reads+math, not real chroma subsampling). Isolates
 *                    whether that's the cost regardless of loop shape.
 *   realFunction   — yuvToRgba() itself, called on synthetic 4:2:0 data
 *                    instead of real camera output — isolates whether real
 *                    pixel values (vs. code shape) are what's slow.
 * `checksum` folds every loop's output into the return value so none of
 * them is provably dead code an optimizer could discard outright.
 */
function runSelfTest(): {
  scalarMs: number;
  typedArrayMs: number;
  nestedNoDivMs: number;
  nestedOneReadMs: number;
  flatMathMs: number;
  threeReadsNoMathMs: number;
  oneReadWithMathMs: number;
  roundedMs: number;
  fixedPointMs: number;
  realFunctionMs: number;
  checksum: number;
} {
  const width = 1280;
  const height = 720;
  const n = width * height;
  const chromaWidth = width / 2;
  const chromaHeight = height / 2;

  let acc = 0;
  const scalarStartedAt = performance.now();
  for (let i = 0; i < n; i++) {
    acc += (i % 255) * 1.1644 - 16;
  }
  const scalarMs = performance.now() - scalarStartedAt;

  const src = new Uint16Array(n);
  for (let i = 0; i < n; i++) src[i] = i & 0x3ff;
  const dst = new Uint8ClampedArray(n * 4);
  const typedArrayStartedAt = performance.now();
  for (let i = 0; i < n; i++) {
    const v = src[i]!;
    const outOffset = i * 4;
    dst[outOffset] = v;
    dst[outOffset + 1] = v;
    dst[outOffset + 2] = v;
    dst[outOffset + 3] = 255;
  }
  const typedArrayMs = performance.now() - typedArrayStartedAt;

  // Same Rec.709 constants and per-pixel arithmetic as yuv.ts, so this is a
  // fair comparison — the only deliberate difference is `>> 1` here where
  // yuv.ts does `(col / chromaStepX) | 0` (always 2 for 4:2:0, so these are
  // equivalent in value, not just in cost).
  const Y_SCALE = 1.1644;
  const CR_TO_R = 1.7927;
  const CB_TO_G = -0.2132;
  const CR_TO_G = -0.5329;
  const CB_TO_B = 2.1124;
  const y = new Uint16Array(n);
  const cb = new Uint16Array(chromaWidth * chromaHeight);
  const cr = new Uint16Array(chromaWidth * chromaHeight);
  for (let i = 0; i < y.length; i++) y[i] = i & 0xff;
  for (let i = 0; i < cb.length; i++) {
    cb[i] = i & 0xff;
    cr[i] = i & 0xff;
  }
  const nestedOut = new Uint8ClampedArray(n * 4);
  const nestedNoDivStartedAt = performance.now();
  for (let row = 0; row < height; row++) {
    const chromaRow = row >> 1;
    const yRowOffset = row * width;
    const chromaRowOffset = chromaRow * chromaWidth;
    let outOffset = yRowOffset * 4;
    for (let col = 0; col < width; col++) {
      const chromaCol = col >> 1;
      const yVal = y[yRowOffset + col]! - 16;
      const cbVal = cb[chromaRowOffset + chromaCol]! - 128;
      const crVal = cr[chromaRowOffset + chromaCol]! - 128;
      const luma = Y_SCALE * yVal;
      nestedOut[outOffset] = luma + CR_TO_R * crVal;
      nestedOut[outOffset + 1] = luma + CB_TO_G * cbVal + CR_TO_G * crVal;
      nestedOut[outOffset + 2] = luma + CB_TO_B * cbVal;
      nestedOut[outOffset + 3] = 255;
      outOffset += 4;
    }
  }
  const nestedNoDivMs = performance.now() - nestedNoDivStartedAt;

  // nestedNoDiv bundles two changes from typedArray at once (nested row/col
  // loop *and* 3 reads + full arithmetic) — these two isolate which one
  // actually costs the time. nestedOneRead keeps the nested loop shape but
  // drops back to one read and a trivial write, like typedArray. flatMath
  // keeps the flat single loop but adds the 3 reads and full arithmetic
  // back, reading cb/cr at the same index as y (4:4:4, not 4:2:0 — the point
  // here is reads+math, not real subsampling).
  const nestedOneReadOut = new Uint8ClampedArray(n * 4);
  const nestedOneReadStartedAt = performance.now();
  for (let row = 0; row < height; row++) {
    const rowOffset = row * width;
    let outOffset = rowOffset * 4;
    for (let col = 0; col < width; col++) {
      const v = y[rowOffset + col]!;
      nestedOneReadOut[outOffset] = v;
      nestedOneReadOut[outOffset + 1] = v;
      nestedOneReadOut[outOffset + 2] = v;
      nestedOneReadOut[outOffset + 3] = 255;
      outOffset += 4;
    }
  }
  const nestedOneReadMs = performance.now() - nestedOneReadStartedAt;

  const yFull = new Uint16Array(n);
  const cbFull = new Uint16Array(n);
  const crFull = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    yFull[i] = i & 0xff;
    cbFull[i] = i & 0xff;
    crFull[i] = i & 0xff;
  }
  const flatMathOut = new Uint8ClampedArray(n * 4);
  const flatMathStartedAt = performance.now();
  for (let i = 0; i < n; i++) {
    const yVal = yFull[i]! - 16;
    const cbVal = cbFull[i]! - 128;
    const crVal = crFull[i]! - 128;
    const luma = Y_SCALE * yVal;
    const outOffset = i * 4;
    flatMathOut[outOffset] = luma + CR_TO_R * crVal;
    flatMathOut[outOffset + 1] = luma + CB_TO_G * cbVal + CR_TO_G * crVal;
    flatMathOut[outOffset + 2] = luma + CB_TO_B * cbVal;
    flatMathOut[outOffset + 3] = 255;
  }
  const flatMathMs = performance.now() - flatMathStartedAt;

  // flatMath bundled two more things at once (3 separate array reads *and*
  // the floating-point arithmetic) — split those apart too. threeReadsNoMath
  // keeps the 3 reads but writes trivially (no color math). oneReadWithMath
  // keeps the full arithmetic but reads only one array, reusing that single
  // value as yVal/cbVal/crVal — same flop count, one read instead of three.
  const threeReadsNoMathOut = new Uint8ClampedArray(n * 4);
  const threeReadsNoMathStartedAt = performance.now();
  for (let i = 0; i < n; i++) {
    const yVal = yFull[i]!;
    const cbVal = cbFull[i]!;
    const crVal = crFull[i]!;
    const outOffset = i * 4;
    threeReadsNoMathOut[outOffset] = yVal;
    threeReadsNoMathOut[outOffset + 1] = cbVal;
    threeReadsNoMathOut[outOffset + 2] = crVal;
    threeReadsNoMathOut[outOffset + 3] = 255;
  }
  const threeReadsNoMathMs = performance.now() - threeReadsNoMathStartedAt;

  const oneReadWithMathOut = new Uint8ClampedArray(n * 4);
  const oneReadWithMathStartedAt = performance.now();
  for (let i = 0; i < n; i++) {
    const raw = yFull[i]!;
    const yVal = raw - 16;
    const cbVal = raw - 128;
    const crVal = raw - 128;
    const luma = Y_SCALE * yVal;
    const outOffset = i * 4;
    oneReadWithMathOut[outOffset] = luma + CR_TO_R * crVal;
    oneReadWithMathOut[outOffset + 1] = luma + CB_TO_G * cbVal + CR_TO_G * crVal;
    oneReadWithMathOut[outOffset + 2] = luma + CB_TO_B * cbVal;
    oneReadWithMathOut[outOffset + 3] = 255;
  }
  const oneReadWithMathMs = performance.now() - oneReadWithMathStartedAt;

  // Same arithmetic as oneReadWithMath, but each channel is forced to an
  // integer with `(x + 0.5) | 0` before the store — isolates whether storing
  // a non-integer double into a Uint8ClampedArray (which per spec rounds
  // half-to-even on write, not just clamps) is itself the expensive part,
  // separately from computing the double in the first place. Correctness
  // isn't a concern for out-of-range values here: whatever `| 0` produces
  // for a value already outside 0-255, Uint8ClampedArray still clamps it to
  // 0 or 255 the same as it would the unrounded double.
  const roundedOut = new Uint8ClampedArray(n * 4);
  const roundedStartedAt = performance.now();
  for (let i = 0; i < n; i++) {
    const raw = yFull[i]!;
    const yVal = raw - 16;
    const cbVal = raw - 128;
    const crVal = raw - 128;
    const luma = Y_SCALE * yVal;
    const outOffset = i * 4;
    roundedOut[outOffset] = (luma + CR_TO_R * crVal + 0.5) | 0;
    roundedOut[outOffset + 1] = (luma + CB_TO_G * cbVal + CR_TO_G * crVal + 0.5) | 0;
    roundedOut[outOffset + 2] = (luma + CB_TO_B * cbVal + 0.5) | 0;
    roundedOut[outOffset + 3] = 255;
  }
  const roundedMs = performance.now() - roundedStartedAt;

  // Pre-rounding before the store (above) made no real difference — still
  // ~150ms, barely under oneReadWithMath's ~165ms — so it's not the *store*
  // that's slow, it's computing the floating-point expressions themselves.
  // But the scalar test above does float multiply/subtract/add too, at
  // 7-8ms for the same iteration count, so "floating point" alone isn't the
  // answer either — it's specifically this shape: several different
  // expressions, each built from the same few locals, each stored to a
  // different memory location, in the same iteration. video codecs
  // conventionally avoid exactly this by doing the whole conversion in
  // fixed-point integer math instead of floating point — same formula,
  // scaled by 2^12 into integers, descaled with a shift. `fixedPointMath`
  // tests whether that sidesteps whatever's slow about the floating-point
  // version, independent of knowing why the float version is slow.
  const FIX_SHIFT = 12;
  const Y_SCALE_FX = Math.round(Y_SCALE * (1 << FIX_SHIFT));
  const CR_TO_R_FX = Math.round(CR_TO_R * (1 << FIX_SHIFT));
  const CB_TO_G_FX = Math.round(CB_TO_G * (1 << FIX_SHIFT));
  const CR_TO_G_FX = Math.round(CR_TO_G * (1 << FIX_SHIFT));
  const CB_TO_B_FX = Math.round(CB_TO_B * (1 << FIX_SHIFT));
  const fixedPointOut = new Uint8ClampedArray(n * 4);
  const fixedPointStartedAt = performance.now();
  for (let i = 0; i < n; i++) {
    const raw = yFull[i]!;
    const yVal = raw - 16;
    const cbVal = raw - 128;
    const crVal = raw - 128;
    const luma = (Y_SCALE_FX * yVal) >> FIX_SHIFT;
    const outOffset = i * 4;
    fixedPointOut[outOffset] = luma + ((CR_TO_R_FX * crVal) >> FIX_SHIFT);
    fixedPointOut[outOffset + 1] =
      luma + ((CB_TO_G_FX * cbVal) >> FIX_SHIFT) + ((CR_TO_G_FX * crVal) >> FIX_SHIFT);
    fixedPointOut[outOffset + 2] = luma + ((CB_TO_B_FX * cbVal) >> FIX_SHIFT);
    fixedPointOut[outOffset + 3] = 255;
  }
  const fixedPointMs = performance.now() - fixedPointStartedAt;

  const syntheticFrame: YuvFrame = {
    y,
    cb,
    cr,
    width,
    height,
    chromaWidth,
    chromaHeight,
    bitDepth: 8,
  };
  const realOut = new Uint8ClampedArray(n * 4);
  const realFunctionStartedAt = performance.now();
  yuvToRgba(syntheticFrame, realOut);
  const realFunctionMs = performance.now() - realFunctionStartedAt;

  const checksum =
    acc +
    dst[dst.length - 1]! +
    nestedOut[nestedOut.length - 1]! +
    nestedOneReadOut[nestedOneReadOut.length - 1]! +
    flatMathOut[flatMathOut.length - 1]! +
    threeReadsNoMathOut[threeReadsNoMathOut.length - 1]! +
    oneReadWithMathOut[oneReadWithMathOut.length - 1]! +
    roundedOut[roundedOut.length - 1]! +
    fixedPointOut[fixedPointOut.length - 1]! +
    realOut[realOut.length - 1]!;
  return {
    scalarMs,
    typedArrayMs,
    nestedNoDivMs,
    nestedOneReadMs,
    flatMathMs,
    threeReadsNoMathMs,
    oneReadWithMathMs,
    roundedMs,
    fixedPointMs,
    realFunctionMs,
    checksum,
  };
}

function postError(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause);
  scope.postMessage({ type: "error", message } satisfies HevcSoftwareResponse);
}

scope.onmessage = async (event: MessageEvent<HevcSoftwareRequest>) => {
  const message = event.data;
  try {
    switch (message.type) {
      case "init": {
        wasmJsUrl = message.wasmJsUrl;
        wasmBinaryUrl = message.wasmBinaryUrl;
        decoder?.destroy();
        decoder = await createDecoder();
        const selftest = runSelfTest();
        scope.postMessage({ type: "selftest", ...selftest } satisfies HevcSoftwareResponse);
        scope.postMessage({ type: "ready" } satisfies HevcSoftwareResponse);
        break;
      }
      case "reset": {
        decoder?.destroy();
        decoder = null;
        if (wasmJsUrl === null || wasmBinaryUrl === null) break;
        // glueLoaded is already cached from init, so this just
        // re-instantiates the WASM module — cheap relative to the initial
        // fetch+compile.
        decoder = await createDecoder();
        scope.postMessage({ type: "ready" } satisfies HevcSoftwareResponse);
        break;
      }
      case "feed": {
        if (!decoder) throw new Error("hevc software decoder: feed before init");
        const decodeStartedAt = performance.now();
        decoder.feed(new Uint8Array(message.chunk));
        const frames = decoder.drain();
        const decodeMs = performance.now() - decodeStartedAt;
        const timing: PostFrameTiming = { allocMs: 0, mathMs: 0, postMs: 0 };
        for (const frame of frames) postFrame(frame, timing);
        scope.postMessage({
          type: "fed",
          decodeMs,
          allocMs: timing.allocMs,
          mathMs: timing.mathMs,
          postMs: timing.postMs,
          frameCount: frames.length,
        } satisfies HevcSoftwareResponse);
        break;
      }
      case "destroy": {
        decoder?.destroy();
        decoder = null;
        break;
      }
    }
  } catch (cause) {
    postError(cause);
  }
};
