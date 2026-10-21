<script setup lang="ts">
import {
  buildCodecString,
  buildHevcDescription,
  detectCodec,
  drainAccessUnits,
  splitNalUnits,
} from "~/utils/annexB";
import type { NalCodec, NalFraming } from "~/utils/annexB";
import {
  computeHistogram,
  HISTOGRAM_SAMPLE_EVERY,
  HISTOGRAM_SAMPLE_HEIGHT,
  HISTOGRAM_SAMPLE_WIDTH,
} from "~/utils/histogram";
import {
  destroySoftwareHevcDecoder,
  feedSoftwareHevc,
  resetSoftwareHevcDecoder,
  softwareHevcBacklog,
  softwareHevcDecodeStats,
  softwareHevcSupported,
  startSoftwareHevcDecoder,
} from "~/utils/hevcSoftwareClient";
import { consumeNativeFrames } from "~/utils/nativeDecodeClient";

/**
 * How many un-acknowledged feeds the software decoder may have outstanding
 * before we stop adding more and resync at the next keyframe instead. Picked
 * to tolerate brief, normal jitter without letting a sustained shortfall
 * between decode speed and the camera's frame rate grow latency for the rest
 * of the session.
 */
const SOFTWARE_DECODE_BACKLOG_LIMIT = 3;

// The page owns starting and stopping the stream; this component is just the
// decoding surface for whatever the live-view composable is currently serving.
const { active, transport, streamUrl, error, note, stop } = useLiveView();

/**
 * TEMPORARY DIAGNOSTIC — mirrors every diagnostic line to the Safari Web
 * Inspector console (via console.log) as well as the in-app diagnostics
 * panel. console.log is the fallback ground truth: it shows up even if the
 * diagnostics `<details>` panel on the Camera tab isn't being checked, isn't
 * rendering, or this component never got a chance to call `note()` at all.
 */
function log(line: string) {
  console.log("[liveview]", line);
  note(line);
}

// A VideoFrame is only readable between decode and close, so the histogram is
// sampled here and pushed out, rather than the composable reaching in for it.
const { sampling, publish: publishHistogram } = useHistogram();

const canvas = useTemplateRef<HTMLCanvasElement>("canvas");
const img = useTemplateRef<HTMLImageElement>("img");

/** Offscreen scratch the frame is subsampled into before it is binned. */
let sampleCanvas: HTMLCanvasElement | null = null;
let sampleContext: CanvasRenderingContext2D | null = null;
let frameIndex = 0;

/**
 * Bin a decoded frame for the viewfinder histogram.
 *
 * The frame is drawn into a small scratch canvas with smoothing *off*. That
 * matters: scaling 1280x960 down with the browser's default smoothing averages
 * neighbouring pixels, so a blown highlight next to a mid-grey one lands near
 * 200 instead of 255 and the clipping you needed to see disappears. Nearest
 * neighbour takes real pixel values, and 128x96 of them is plenty of sample to
 * hold the shape of a scene.
 */
function sampleHistogram(frame: VideoFrame) {
  if (frameIndex++ % HISTOGRAM_SAMPLE_EVERY !== 0) return;

  if (!sampleCanvas) {
    sampleCanvas = document.createElement("canvas");
    sampleCanvas.width = HISTOGRAM_SAMPLE_WIDTH;
    sampleCanvas.height = HISTOGRAM_SAMPLE_HEIGHT;
    sampleContext = sampleCanvas.getContext("2d", { willReadFrequently: true });
    if (sampleContext) sampleContext.imageSmoothingEnabled = false;
  }
  if (!sampleContext) return;

  sampleContext.drawImage(frame, 0, 0, HISTOGRAM_SAMPLE_WIDTH, HISTOGRAM_SAMPLE_HEIGHT);
  const { data } = sampleContext.getImageData(
    0,
    0,
    HISTOGRAM_SAMPLE_WIDTH,
    HISTOGRAM_SAMPLE_HEIGHT,
  );
  publishHistogram(computeHistogram(data));
}
let decoder: VideoDecoder | null = null;
let abort: AbortController | null = null;
let nativeAbort: AbortController | null = null;

/** Bytes that arrived mid-NAL and must be prepended to the next chunk. */
let carry = new Uint8Array(0);
/** Complete NAL units not yet proven to form a finished picture. */
let pendingUnits: Uint8Array[] = [];
let codec: NalCodec | null = null;
let configured = false;
let seenKeyframe = false;
/** Set once backlog has forced a skip-ahead; cleared at the next keyframe. */
let skippingToKeyframe = false;
let timestamp = 0;
/** How access-unit data must be packed for the currently-configured decoder. */
let framing: NalFraming = "annexb";

/**
 * Set once native HEVC decode is proven unsupported (WKWebView on macOS
 * refuses every codec-string/description/hardwareAcceleration combination —
 * see the double-failure branch below). Sticky for the component's lifetime:
 * once known, every later reconfigure (e.g. after a decode-error resync)
 * skips straight to software decode instead of repeating two doomed native
 * attempts and flashing an error banner each time.
 */
let nativeHevcUnsupported = false;
/** True once the software decoder is the one actually producing frames. */
let softwareMode = false;

/**
 * TEMPORARY DIAGNOSTIC — direct measurement of where the software-decode
 * frame rate is actually going: is the WASM decoder itself slow (feed stats
 * below), or is a decoder that's keeping up just being starved by the
 * backlog/skip logic because the camera's keyframe interval is long (the
 * interval/engagement counters)? Remove once the real bottleneck is found.
 */
let lastKeyframeAt: number | null = null;
let skipEngagements = 0;
let feedsSincePerfLog = 0;

function logSoftwarePerf() {
  const stats = softwareHevcDecodeStats();
  log(
    `[perf] software decode: ${stats.feedCount} feeds, ` +
      `decode avg ${stats.avgDecodeMs.toFixed(1)}ms/max ${stats.maxDecodeMs.toFixed(1)}ms, ` +
      `alloc avg ${stats.avgAllocMs.toFixed(1)}ms/max ${stats.maxAllocMs.toFixed(1)}ms, ` +
      `math avg ${stats.avgMathMs.toFixed(1)}ms/max ${stats.maxMathMs.toFixed(1)}ms, ` +
      `post avg ${stats.avgPostMs.toFixed(1)}ms/max ${stats.maxPostMs.toFixed(1)}ms, ` +
      `${stats.framesOutCount} frames out, ` +
      `${skipEngagements} backlog-skips engaged, current backlog ${softwareHevcBacklog()}`,
  );
}

/** Reused across calls so the hot path doesn't allocate a new frame every time. */
let softwareSampleBuffer: Uint8ClampedArray | null = null;

/**
 * Bin a software-decoded frame for the viewfinder histogram. Same nearest-
 * neighbour subsampling as sampleHistogram() above, done by striding the RGBA
 * buffer directly rather than through a canvas — there is no VideoFrame here
 * for drawImage() to scale down, and the buffer is already in hand.
 */
function sampleHistogramFromRgba(rgba: Uint8ClampedArray, width: number, height: number) {
  if (frameIndex++ % HISTOGRAM_SAMPLE_EVERY !== 0) return;
  softwareSampleBuffer ??= new Uint8ClampedArray(
    HISTOGRAM_SAMPLE_WIDTH * HISTOGRAM_SAMPLE_HEIGHT * 4,
  );
  const stepX = width / HISTOGRAM_SAMPLE_WIDTH;
  const stepY = height / HISTOGRAM_SAMPLE_HEIGHT;
  let outOffset = 0;
  for (let row = 0; row < HISTOGRAM_SAMPLE_HEIGHT; row++) {
    const srcRow = Math.min(height - 1, (row * stepY) | 0);
    const rowOffset = srcRow * width * 4;
    for (let col = 0; col < HISTOGRAM_SAMPLE_WIDTH; col++) {
      const srcOffset = rowOffset + Math.min(width - 1, (col * stepX) | 0) * 4;
      softwareSampleBuffer[outOffset] = rgba[srcOffset]!;
      softwareSampleBuffer[outOffset + 1] = rgba[srcOffset + 1]!;
      softwareSampleBuffer[outOffset + 2] = rgba[srcOffset + 2]!;
      softwareSampleBuffer[outOffset + 3] = 255;
      outOffset += 4;
    }
  }
  publishHistogram(computeHistogram(softwareSampleBuffer));
}

/** TEMPORARY DIAGNOSTIC — logged once so the perf numbers above have a resolution to go with. */
let loggedSoftwareResolution = false;

/** Paint surface for the software decoder's output — an RGBA buffer, not a VideoFrame. */
function paintSoftwareFrame(rgba: Uint8ClampedArray, width: number, height: number) {
  if (!loggedSoftwareResolution) {
    loggedSoftwareResolution = true;
    log(`[perf] software decoder output resolution: ${width}x${height}`);
  }
  const element = canvas.value;
  if (!element) return;
  if (element.width !== width) element.width = width;
  if (element.height !== height) element.height = height;
  const context = element.getContext("2d");
  if (!context) return;
  context.putImageData(new ImageData(rgba, width, height), 0, 0);
  if (sampling.value) sampleHistogramFromRgba(rgba, width, height);
}

/**
 * Engage the software decoder after native HEVC decode has just failed twice
 * (bare, then with an explicit description). Called at most once per
 * component lifetime per se — once `softwareMode` is true, later
 * reconfigures just reset the existing worker's decoder instance instead
 * (see resetDecoderState()).
 */
async function engageSoftwareDecoder() {
  framing = "annexb"; // the WASM decoder wants raw Annex-B NAL chunks.
  try {
    if (!softwareHevcSupported()) {
      throw new Error("software HEVC decoder is unavailable in this environment");
    }
    await startSoftwareHevcDecoder({
      onFrame: paintSoftwareFrame,
      onError: (message) => log(`Software decoder error: ${message}`),
      onSelfTest: (result) => {
        log(
          `[perf] worker self-test (no real decode data, same pixel count as one 720p frame): ` +
            `scalar ${result.scalarMs.toFixed(1)}ms, typed-array ${result.typedArrayMs.toFixed(1)}ms, ` +
            `nested-no-div ${result.nestedNoDivMs.toFixed(1)}ms, nested-one-read ${result.nestedOneReadMs.toFixed(1)}ms, ` +
            `flat-with-math ${result.flatMathMs.toFixed(1)}ms, three-reads-no-math ${result.threeReadsNoMathMs.toFixed(1)}ms, ` +
            `one-read-with-math ${result.oneReadWithMathMs.toFixed(1)}ms, rounded-before-store ${result.roundedMs.toFixed(1)}ms, ` +
            `fixed-point-math ${result.fixedPointMs.toFixed(1)}ms, real yuvToRgba() on synthetic data ${result.realFunctionMs.toFixed(1)}ms`,
        );
      },
    });
    softwareMode = true;
    log("Native HEVC decode is unsupported on this platform; using the software decoder instead.");
  } catch (cause) {
    error.value = `Software HEVC decoder failed to start: ${
      cause instanceof Error ? cause.message : String(cause)
    }`;
    log(error.value);
  }
}

function paint(frame: VideoFrame) {
  const element = canvas.value;
  if (!element) {
    frame.close();
    return;
  }
  if (element.width !== frame.displayWidth) element.width = frame.displayWidth;
  if (element.height !== frame.displayHeight) element.height = frame.displayHeight;
  element.getContext("2d")?.drawImage(frame, 0, 0);
  // Sample before closing: after this the frame's pixels are gone. Guarded so
  // a hidden histogram costs nothing at all.
  if (sampling.value) sampleHistogram(frame);
  frame.close();
}

/**
 * Try the Rust backend's native VideoToolbox decode (`/frames`, see
 * `hevc_decode.rs`) before falling back to this component's WebCodecs/
 * software chain. That decode happens outside the WKWebView entirely — the
 * whole point of this path — so if it works at all, it works from the very
 * first frame; there is nothing to configure or retry on this side.
 *
 * Returns `true` once at least one native frame has been painted, meaning
 * this call owns the rest of the stream's lifetime (it only returns when the
 * stream ends or `reset()` aborts it) and the caller should not also start
 * `consumeAnnexB()`. Returns `false` if no frame arrived within the timeout
 * or the endpoint errored — e.g. a non-macOS build, or a stream that turned
 * out not to be HEVC — in which case nothing was painted and the caller
 * should proceed exactly as before.
 */
async function tryNativeDecode(streamUrl: string): Promise<boolean> {
  const framesUrl = streamUrl.replace(/\/stream$/, "/frames");
  nativeAbort = new AbortController();
  let gotFrame = false;
  const giveUp = setTimeout(() => {
    if (!gotFrame) nativeAbort?.abort();
  }, 4000);

  try {
    await consumeNativeFrames(
      framesUrl,
      {
        onFrame: (rgba, width, height) => {
          if (!gotFrame) {
            gotFrame = true;
            clearTimeout(giveUp);
            log("Native VideoToolbox decode is active; WebCodecs is not needed on this stream.");
          }
          paintSoftwareFrame(rgba, width, height);
        },
      },
      nativeAbort.signal,
    );
  } catch (cause) {
    if (!gotFrame && (cause as Error)?.name !== "AbortError") {
      log(
        `Native decode unavailable, falling back: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
  } finally {
    clearTimeout(giveUp);
  }
  return gotFrame;
}

async function consumeAnnexB(url: string) {
  log(`[capture] starting fetch of ${url}`);
  abort = new AbortController();
  const response = await fetch(url, { signal: abort.signal });
  const reader = response.body?.getReader();
  if (!reader) throw new Error("the local stream returned no body");

  await readAnnexBLoop(reader);
}

async function readAnnexBLoop(reader: ReadableStreamDefaultReader<Uint8Array>) {
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;

    const merged = new Uint8Array(carry.length + value.length);
    merged.set(carry);
    merged.set(value, carry.length);

    const units = splitNalUnits(merged);
    if (units.length === 0) {
      carry = merged;
      continue;
    }
    // The last unit may be cut mid-NAL; hold its bytes back for the next read.
    const tail = units.at(-1)!;
    carry = new Uint8Array(4 + tail.length);
    carry.set([0, 0, 0, 1]);
    carry.set(tail, 4);
    // Copy, so these views do not pin the whole merged buffer in memory
    for (const unit of units.slice(0, -1)) pendingUnits.push(unit.slice());
    if (pendingUnits.length === 0) continue;

    codec ??= detectCodec(pendingUnits);
    if (!codec) continue;

    if (!configured) {
      const codecString = buildCodecString(pendingUnits, codec);
      if (!codecString) continue;
      log(`Detected ${codec}, codec string ${codecString}.`);

      if (softwareMode) {
        // The worker and its WASM decoder are already running —
        // resetDecoderState() already reset the existing software session.
        // Nothing left to configure.
      } else if (nativeHevcUnsupported && codec === "h265") {
        // Known broken on this platform from an earlier stream in this same
        // component lifetime — skip straight past the two doomed native
        // attempts below rather than repeating them on every reconnect.
        await engageSoftwareDecoder();
      } else {
        const decoderInit: VideoDecoderInit = {
          output: paint,
          error: (cause) => {
            // A decode error — a garbled or dropped frame after a while, or an
            // HEVC frame the platform choked on — used to abort the whole stream
            // and end the preview for good. Instead drop just the decode pipeline
            // and keep reading: the loop reconfigures a fresh decoder from the
            // next keyframe, so a glitch is a brief blip rather than the end.
            log(`Decoder error, resyncing at next keyframe: ${cause.message}`);
            resetDecoderState();
          },
        };

        // Built once up front so the describe-retry below doesn't need to
        // recompute it.
        const description = codec === "h265" ? buildHevcDescription(pendingUnits) : null;

        // Try all three hardwareAcceleration values against the real
        // decoder rather than just "prefer-software": on some platforms
        // "no-preference" (the platform's own default pick) or
        // "prefer-hardware" succeeds where "prefer-software" alone does not.
        // Each gets both the bare attempt and (if available) the described
        // retry, one pass per acceleration mode.
        const accelerationsToTry = ["prefer-software", "no-preference", "prefer-hardware"] as const;
        let configuredOk = false;
        let lastBareCause: unknown = null;
        let lastDescribedCause: unknown = null;
        for (const hardwareAcceleration of accelerationsToTry) {
          try {
            decoder?.close();
          } catch {
            // Already closed, or never configured; nothing to do.
          }
          decoder = new VideoDecoder(decoderInit);
          try {
            decoder.configure({
              codec: codecString,
              optimizeForLatency: true,
              hardwareAcceleration,
            });
            framing = "annexb";
            configuredOk = true;
            log(
              `"${codecString}" configured natively with hardwareAcceleration="${hardwareAcceleration}".`,
            );
            break;
          } catch (bareConfigCause) {
            lastBareCause = bareConfigCause;
          }

          if (!description) continue;

          // A fresh VideoDecoder for the retry, not the one above: a decoder
          // whose configure() call threw may already be in a "closed" state in
          // some implementations, which makes every further call on it fail
          // with the same generic error regardless of the new config's
          // validity — indistinguishable from the description itself being
          // rejected unless this is ruled out.
          try {
            decoder?.close();
          } catch {
            // Already closed; nothing to do.
          }
          decoder = new VideoDecoder(decoderInit);
          try {
            decoder.configure({
              codec: codecString,
              description,
              optimizeForLatency: true,
              hardwareAcceleration,
            });
            framing = "length4";
            configuredOk = true;
            log(
              `"${codecString}" needed an explicit HEVC description; configured with one (hardwareAcceleration="${hardwareAcceleration}").`,
            );
            break;
          } catch (describedConfigCause) {
            lastDescribedCause = describedConfigCause;
          }
        }

        if (!configuredOk) {
          const message = description
            ? `VideoDecoder rejected "${codecString}" under every hardwareAcceleration value tried, bare and with an explicit description: ${
                lastDescribedCause instanceof Error
                  ? lastDescribedCause.message
                  : String(lastDescribedCause)
              }`
            : `VideoDecoder rejected "${codecString}" under every hardwareAcceleration value tried: ${
                lastBareCause instanceof Error ? lastBareCause.message : String(lastBareCause)
              }`;
          // Every native attempt failed. On every platform tested outside
          // this app's own WKWebView (a standalone Safari tab, including
          // against this exact stream's bytes) configure() succeeds, so this
          // is treated as a platform-level restriction rather than a bad
          // parameter — worth falling back from, not erroring out of, but
          // only for HEVC: there is no software fallback decoder for
          // anything else.
          if (codec === "h265") {
            log(message);
            nativeHevcUnsupported = true;
            await engageSoftwareDecoder();
          } else {
            error.value = message;
            log(error.value);
            return;
          }
        }
      }
      configured = true;
    }

    const { access, pending } = drainAccessUnits(pendingUnits, codec, framing);
    pendingUnits = pending;

    for (const unit of access) {
      if (softwareMode) {
        // Feeding delta frames before the first keyframe guarantees garbage
        // output from the WASM decoder too, same as the native path below.
        if (!unit.key && !seenKeyframe) continue;
        if (unit.key) {
          const now = performance.now();
          if (lastKeyframeAt !== null) {
            log(`[perf] keyframe interval ${(now - lastKeyframeAt).toFixed(0)}ms`);
          }
          lastKeyframeAt = now;
          seenKeyframe = true;
          skippingToKeyframe = false;
        }
        if (skippingToKeyframe) continue;
        if (!unit.key && softwareHevcBacklog() > SOFTWARE_DECODE_BACKLOG_LIMIT) {
          // The worker's own message queue — not just this loop — has fallen
          // behind the camera's frame rate. `postMessage` gives no way to
          // cancel what's already queued there, so stop adding to it until
          // the next keyframe. Unlike the native path's decode-error resync
          // below, there is no actual decoder corruption here — the WASM
          // decoder's own state is still valid, our outgoing queue is just
          // ahead of what it's finished — so this deliberately does NOT call
          // resetSoftwareHevcDecoder(): recreating the decoder on every
          // catch-up cycle risks costing more time than the backlog it's
          // meant to bound, especially if that recreation itself is slow.
          skippingToKeyframe = true;
          skipEngagements++;
          log(
            `[perf] backlog exceeded limit (${softwareHevcBacklog()}); skipping to next keyframe`,
          );
          continue;
        }
        feedSoftwareHevc(unit.data);
        if (++feedsSincePerfLog >= 30) {
          feedsSincePerfLog = 0;
          logSoftwarePerf();
        }
        continue;
      }
      // The decoder may have just been reset (e.g. after an error). Stop
      // feeding this batch and let the next keyframe reconfigure it, rather
      // than ending the read loop.
      if (decoder?.state !== "configured") break;
      // Feeding delta frames before the first keyframe guarantees a failure
      if (!unit.key && !seenKeyframe) continue;
      if (unit.key) seenKeyframe = true;
      decoder.decode(
        new EncodedVideoChunk({
          type: unit.key ? "key" : "delta",
          timestamp: timestamp,
          data: unit.data,
        }),
      );
      timestamp += 33333; // ~30fps in microseconds
    }
  }
}

function reset() {
  abort?.abort();
  abort = null;
  nativeAbort?.abort();
  nativeAbort = null;
  resetDecoderState();
  carry = new Uint8Array(0);
  timestamp = 0;
  frameIndex = 0;
  lastKeyframeAt = null;
  skipEngagements = 0;
  feedsSincePerfLog = 0;
  loggedSoftwareResolution = false;
}

/**
 * Tear down only the decode pipeline, leaving the fetch running. This is what
 * lets a decoder error recover: the read loop keeps pulling bytes and builds a
 * fresh decoder from the next keyframe's parameter sets. `carry` and
 * `timestamp` are deliberately left intact so timestamps never jump backwards.
 */
function resetDecoderState() {
  try {
    decoder?.close();
  } catch {
    // Already closed; nothing to do
  }
  decoder = null;
  pendingUnits = [];
  codec = null;
  configured = false;
  seenKeyframe = false;
  framing = "annexb";
  if (softwareMode) {
    // Recreate just the worker's decoder instance (cheap — the WASM glue and
    // binary are already loaded and cached) rather than tearing the worker
    // down; `nativeHevcUnsupported` already means every future reconfigure
    // in this component's lifetime goes straight back to software mode
    // anyway, so there is nothing to gain by discarding the worker too.
    resetSoftwareHevcDecoder().catch((cause) => {
      log(
        `Failed to reset software decoder: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    });
  }
}

watch([active, transport, streamUrl], async ([on, kind, url]) => {
  if (!on || kind !== "annexb" || !url) {
    reset();
    return;
  }
  reset();
  try {
    const handledNatively = await tryNativeDecode(url);
    if (handledNatively) return;
    await consumeAnnexB(url);
  } catch (cause) {
    if ((cause as Error)?.name === "AbortError") return;
    error.value = cause instanceof Error ? cause.message : String(cause);
    log(`Stream read failed: ${error.value}`);
  }
});

onBeforeUnmount(() => {
  reset();
  void stop();
  destroySoftwareHevcDecoder();
});

/**
 * The decoded frame's own pixel resolution — not this element's CSS size.
 * `object-contain` means the two differ whenever the container's aspect
 * ratio doesn't match the video's, which is normally true, so anything
 * outside this component that needs to map a point on screen back onto the
 * video (currently just TrackingOverlay.vue's box-draw) needs this to
 * account for the letterboxing. Only in-progress consumer today is that
 * experimental overlay; remove this and the `img` ref above if it goes.
 */
function getIntrinsicSize(): { width: number; height: number } | null {
  if (transport.value === "mjpeg") {
    const element = img.value;
    if (!element?.naturalWidth) return null;
    return { width: element.naturalWidth, height: element.naturalHeight };
  }
  const element = canvas.value;
  if (!element?.width) return null;
  return { width: element.width, height: element.height };
}

defineExpose({ getIntrinsicSize });
</script>

<template>
  <div class="size-full">
    <img
      v-if="active && transport === 'mjpeg' && streamUrl"
      ref="img"
      :src="streamUrl"
      class="size-full object-contain"
    />
    <canvas
      v-show="active && transport === 'annexb'"
      ref="canvas"
      class="size-full object-contain"
    />
  </div>
</template>
