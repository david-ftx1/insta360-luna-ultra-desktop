/**
 * Frontend side of the native VideoToolbox decode pipeline (see
 * `src-tauri/src/hevc_decode.rs`). The Rust backend already decoded the
 * camera's HEVC stream — WKWebView itself refuses to (see LiveView.vue's
 * native-decode diagnostic) — AND already converted it to RGBA8, so this
 * module's only job is to read `/frames` and hand the bytes to the canvas.
 *
 * YUV→RGBA used to happen here, reusing the same fixed-point Rec.709
 * converter built for the software-decode fallback (`yuvToRgba` in
 * `~/utils/yuv.ts`). Moved to Rust (`convert_nv12_to_rgba` in
 * `hevc_decode.rs`, replicating that same matrix/fixed-point math exactly)
 * because running it here, on the main thread, cost ~128ms per 720p frame
 * in isolation — capping native decode under 8fps regardless of how fast
 * the hardware decoder itself ran, and the real cause of it looking choppy
 * even once the crash/freeze/format-description bugs were fixed.
 *
 * Wire format, one frame after another, no separators needed because every
 * size is derivable from the fixed header (see `pack_frame()` in
 * `hevc_decode.rs`/`liveview.rs` for the Rust side of this contract):
 *
 *   u32 width, u32 height   (little-endian)
 *   width * height * 4 bytes   (RGBA8, already colour-converted)
 */

const HEADER_BYTES = 8;

export interface NativeFrameHandlers {
  /** One call per decoded frame, already converted to RGBA. */
  onFrame: (rgba: Uint8ClampedArray, width: number, height: number) => void;
}

function parseFrame(bytes: Uint8Array, handlers: NativeFrameHandlers): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);

  // Zero-copy view over this chunk's own buffer, not a module-level scratch
  // buffer — there's no JS-side math to reuse a scratch allocation across,
  // just this reinterpretation. `onFrame` is expected to consume it
  // synchronously, same contract `rgbaScratch` used to carry: `carry` below
  // is a fresh slice each read, so nothing overwrites this view out from
  // under a caller that paints before returning.
  const rgba = new Uint8ClampedArray(
    bytes.buffer,
    bytes.byteOffset + HEADER_BYTES,
    width * height * 4,
  );
  handlers.onFrame(rgba, width, height);
}

/**
 * Read `/frames` until `signal` aborts or the stream ends. Resolves
 * normally on a clean end (camera stopped); throws on a transport error so
 * the caller can decide whether that means "fall back to WebCodecs" (first
 * read never arrived) or "the stream just ended" (it did).
 */
export async function consumeNativeFrames(
  url: string,
  handlers: NativeFrameHandlers,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) {
    throw new Error(`native frame stream responded ${response.status}`);
  }
  const reader = response.body.getReader();
  let carry = new Uint8Array(0);

  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    if (!value) continue;

    const merged = new Uint8Array(carry.length + value.length);
    merged.set(carry);
    merged.set(value, carry.length);

    // A single read() can carry more than one complete frame — paint every
    // one found in this chunk, in order.
    //
    // This used to instead keep only the newest frame per chunk and drop
    // the rest, added when native frames still carried raw NV12 and
    // painting meant running `yuvToRgba` on the main thread first — ~128ms
    // per 720p frame (see this file's header comment), so even a 2-3 frame
    // burst in one read() was over 300ms of uninterrupted main-thread work,
    // which is what actually froze the UI and produced the torn/ghosted
    // frame (two slow paints landing close enough together that the canvas
    // never settled between them). Now that `/frames` ships pre-converted
    // RGBA and painting is just `putImageData`, that coalescing had no
    // freeze left to prevent — it was just discarding real frames on every
    // read() that happened to batch more than one, which silently capped
    // displayed FPS well below the camera's actual rate. The Rust side's
    // broadcast channel (capacity 4, oldest-dropped) already bounds how far
    // `/frames` can fall behind real time, so there's no unbounded-backlog
    // case left for this loop to guard against.
    let offset = 0;
    while (offset + HEADER_BYTES <= merged.length) {
      const view = new DataView(merged.buffer, merged.byteOffset + offset, HEADER_BYTES);
      const width = view.getUint32(0, true);
      const height = view.getUint32(4, true);
      const frameLen = HEADER_BYTES + width * height * 4;
      if (offset + frameLen > merged.length) break; // frame not fully arrived yet
      parseFrame(merged.subarray(offset, offset + frameLen), handlers);
      offset += frameLen;
    }
    carry = merged.slice(offset);
  }
}
