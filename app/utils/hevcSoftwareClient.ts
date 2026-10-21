import type { HevcSoftwareRequest, HevcSoftwareResponse } from "~/workers/hevcSoftware.worker";

/**
 * Main-thread wrapper around the software HEVC decode worker — the fallback
 * for the platform (WKWebView on macOS) where `VideoDecoder.configure()`
 * refuses every HEVC parameter combination the camera's Live View stream can
 * produce, hardware or software `hardwareAcceleration` mode alike. See
 * LiveView.vue for where native decode is attempted first.
 *
 * One worker for the component's lifetime, same lifecycle shape as
 * watermarkClient.ts: lazily created, permanently retired on an unrecoverable
 * failure (no Worker support, the worker script itself failing to start)
 * rather than retried, since nothing about retrying would make a WASM module
 * that failed to load succeed next time.
 */

export interface SoftwareHevcHandlers {
  /** One call per decoded frame, already converted to RGBA by the worker. */
  onFrame: (rgba: Uint8ClampedArray, width: number, height: number) => void;
  /** A decode error from the worker. Does not end the session by itself. */
  onError: (message: string) => void;
  /**
   * Fired once per `startSoftwareHevcDecoder()` call, from a microbenchmark
   * that runs no real decode data — see the worker's "selftest" response for
   * what it's isolating. Optional: tests and any other caller that doesn't
   * care about this diagnostic can omit it.
   */
  onSelfTest?: (result: {
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
  }) => void;
}

let worker: Worker | null = null;
let workerUnusable = false;
let handlers: SoftwareHevcHandlers | null = null;
/** Resolved/rejected by the next "ready"/"error" message — init and reset both wait on this. */
let readyWaiters: Array<{ resolve: () => void; reject: (cause: Error) => void }> = [];
/**
 * Feed requests sent to the worker but not yet acknowledged with "fed".
 * `postMessage` has no built-in backpressure, and the WASM decoder can be
 * slower than the camera's frame rate on this platform — without something
 * tracking how far behind the worker's own queue has fallen, every access
 * unit gets piled on regardless, and latency only ever grows for the rest of
 * the session. LiveView.vue reads this via softwareHevcBacklog() to decide
 * when to stop feeding and resync at the next keyframe instead.
 */
let outstandingFeeds = 0;

/**
 * Rolling decode-time stats, reset whenever the decoder is (re)created. A
 * first decode-vs-convert split showed ~190ms of the ~230ms total at 720p
 * was in "convert" — the plain-JS YUV→RGBA step — not the WASM decoder.
 * This second split breaks that down into what `postFrame()` in the worker
 * actually does, summed across every frame one `feed()` call produced:
 * allocating the output buffer, the pixel-math loop itself, and the
 * `postMessage()` transfer back to this thread.
 */
let feedCount = 0;
let decodeTotalMs = 0;
let decodeMaxMs = 0;
let allocTotalMs = 0;
let allocMaxMs = 0;
let mathTotalMs = 0;
let mathMaxMs = 0;
let postTotalMs = 0;
let postMaxMs = 0;
let framesOutCount = 0;

function recordFeedStat(
  decodeMs: number,
  allocMs: number,
  mathMs: number,
  postMs: number,
  frameCount: number,
) {
  feedCount++;
  decodeTotalMs += decodeMs;
  if (decodeMs > decodeMaxMs) decodeMaxMs = decodeMs;
  allocTotalMs += allocMs;
  if (allocMs > allocMaxMs) allocMaxMs = allocMs;
  mathTotalMs += mathMs;
  if (mathMs > mathMaxMs) mathMaxMs = mathMs;
  postTotalMs += postMs;
  if (postMs > postMaxMs) postMaxMs = postMs;
  framesOutCount += frameCount;
}

function resetFeedStats() {
  feedCount = 0;
  decodeTotalMs = 0;
  decodeMaxMs = 0;
  allocTotalMs = 0;
  allocMaxMs = 0;
  mathTotalMs = 0;
  mathMaxMs = 0;
  postTotalMs = 0;
  postMaxMs = 0;
  framesOutCount = 0;
}

/**
 * Snapshot of decode-time stats since the decoder was last (re)created, all
 * per `feed()` call (one call per access unit fed from LiveView.vue):
 * `avgDecodeMs`/`maxDecodeMs` is the WASM `feed()`+`drain()` alone.
 * `avgAllocMs`/`maxAllocMs` is allocating a fresh `Uint8ClampedArray` per
 * produced frame. `avgMathMs`/`maxMathMs` is the `yuvToRgba()` loop itself.
 * `avgPostMs`/`maxPostMs` is `postMessage()` with the transferred buffer —
 * high here would mean WebKit isn't taking the zero-copy transfer path the
 * spec allows.
 */
export function softwareHevcDecodeStats(): {
  feedCount: number;
  avgDecodeMs: number;
  maxDecodeMs: number;
  avgAllocMs: number;
  maxAllocMs: number;
  avgMathMs: number;
  maxMathMs: number;
  avgPostMs: number;
  maxPostMs: number;
  framesOutCount: number;
} {
  return {
    feedCount,
    avgDecodeMs: feedCount ? decodeTotalMs / feedCount : 0,
    maxDecodeMs: decodeMaxMs,
    avgAllocMs: feedCount ? allocTotalMs / feedCount : 0,
    maxAllocMs: allocMaxMs,
    avgMathMs: feedCount ? mathTotalMs / feedCount : 0,
    maxMathMs: mathMaxMs,
    avgPostMs: feedCount ? postTotalMs / feedCount : 0,
    maxPostMs: postMaxMs,
    framesOutCount,
  };
}

function settleWaiters(cause: Error | null) {
  const waiters = readyWaiters;
  readyWaiters = [];
  for (const waiter of waiters) {
    if (cause) waiter.reject(cause);
    else waiter.resolve();
  }
}

/** Give up on the worker for the rest of the session. */
function retireWorker(cause: Error) {
  workerUnusable = true;
  worker?.terminate();
  worker = null;
  settleWaiters(cause);
  handlers?.onError(cause.message);
}

function ensureWorker(): Worker | null {
  if (workerUnusable) return null;
  if (worker) return worker;
  if (typeof Worker === "undefined") {
    workerUnusable = true;
    return null;
  }
  try {
    worker = new Worker(new URL("../workers/hevcSoftware.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent<HevcSoftwareResponse>) => {
      const data = event.data;
      if (data.type === "ready") {
        settleWaiters(null);
      } else if (data.type === "selftest") {
        handlers?.onSelfTest?.({
          scalarMs: data.scalarMs,
          typedArrayMs: data.typedArrayMs,
          nestedNoDivMs: data.nestedNoDivMs,
          nestedOneReadMs: data.nestedOneReadMs,
          flatMathMs: data.flatMathMs,
          threeReadsNoMathMs: data.threeReadsNoMathMs,
          oneReadWithMathMs: data.oneReadWithMathMs,
          roundedMs: data.roundedMs,
          fixedPointMs: data.fixedPointMs,
          realFunctionMs: data.realFunctionMs,
        });
      } else if (data.type === "frame") {
        handlers?.onFrame(new Uint8ClampedArray(data.rgba), data.width, data.height);
      } else if (data.type === "fed") {
        outstandingFeeds = Math.max(0, outstandingFeeds - 1);
        recordFeedStat(data.decodeMs, data.allocMs, data.mathMs, data.postMs, data.frameCount);
      } else {
        const cause = new Error(data.message);
        handlers?.onError(data.message);
        settleWaiters(cause);
      }
    };
    worker.onerror = () => retireWorker(new Error("hevc software decoder worker failed to start"));
  } catch {
    // Bundlers or platforms that reject module workers land here.
    workerUnusable = true;
    worker = null;
    return null;
  }
  return worker;
}

/** Root-relative; base-prefixed wherever the app is served under a subpath. */
function hevcAssetUrl(name: string): string {
  return `${useRuntimeConfig().app.baseURL}hevc/${name}`;
}

/** Whether the software decoder could plausibly work in this environment. */
export function softwareHevcSupported(): boolean {
  return typeof Worker !== "undefined" && !workerUnusable;
}

/**
 * Start (or restart) the worker and load the WASM decoder. Resolves once the
 * worker reports "ready"; rejects if Worker/module-worker support is missing
 * or the WASM module fails to load.
 */
export function startSoftwareHevcDecoder(settings: SoftwareHevcHandlers): Promise<void> {
  handlers = settings;
  resetFeedStats();
  const active = ensureWorker();
  if (!active) {
    return Promise.reject(new Error("software HEVC decoder is unavailable in this environment"));
  }
  return new Promise((resolve, reject) => {
    readyWaiters.push({ resolve, reject });
    const request: HevcSoftwareRequest = {
      type: "init",
      wasmJsUrl: hevcAssetUrl("hevc-decode.js"),
      wasmBinaryUrl: hevcAssetUrl("hevc-decode.wasm"),
    };
    active.postMessage(request);
  });
}

/**
 * Feed one Annex-B-framed access unit. `chunk` is copied onto a tightly-sized
 * buffer before transfer — it is typically a view over a larger shared
 * buffer, and transferring its `.buffer` directly would hand over more than
 * this access unit and detach memory other code may still hold a view into.
 */
export function feedSoftwareHevc(chunk: Uint8Array): void {
  if (!worker) return;
  const owned = chunk.slice();
  const request: HevcSoftwareRequest = { type: "feed", chunk: owned.buffer };
  outstandingFeeds++;
  worker.postMessage(request, [owned.buffer]);
}

/**
 * How many fed access units the worker has not yet finished processing.
 * Grows when the WASM decoder can't keep up with the incoming frame rate;
 * LiveView.vue polls this before feeding another delta frame so backlog
 * stays bounded instead of growing for the rest of the session.
 */
export function softwareHevcBacklog(): number {
  return outstandingFeeds;
}

/**
 * Recreate the decoder from the next keyframe — the software-decode
 * equivalent of LiveView.vue's `resetDecoderState()`, used after a decode
 * error so a glitch is a brief blip rather than the end of the preview.
 */
export function resetSoftwareHevcDecoder(): Promise<void> {
  if (!worker) return Promise.resolve();
  const active = worker;
  outstandingFeeds = 0;
  resetFeedStats();
  return new Promise((resolve, reject) => {
    readyWaiters.push({ resolve, reject });
    active.postMessage({ type: "reset" } satisfies HevcSoftwareRequest);
  });
}

/** Tear down the worker entirely — called when the Live View session ends. */
export function destroySoftwareHevcDecoder(): void {
  handlers = null;
  outstandingFeeds = 0;
  settleWaiters(new Error("software HEVC decoder destroyed"));
  if (!worker) return;
  try {
    worker.postMessage({ type: "destroy" } satisfies HevcSoftwareRequest);
  } catch {
    // Worker may already be gone; nothing to do.
  }
  worker.terminate();
  worker = null;
}
