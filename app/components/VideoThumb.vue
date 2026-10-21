<script setup lang="ts">
import { getCameraTransport } from "~/utils/transport";
import { withCameraSlot, CAMERA_PRIORITY, viewportPriority } from "~/utils/cameraQueue";
import { cachedMedia } from "~/utils/mediaCache";

/**
 * Video thumbnail. Two paths, tried in this order:
 *
 * 1. Native: ask the Rust backend to decode one frame via AVFoundation (see
 *    `src-tauri/src/video_thumbnail.rs`) and hand back a small JPEG, which
 *    goes straight into the shared media cache (`~/utils/mediaCache`) and
 *    renders as a plain `<img>` — no `<video>` element, no camera request,
 *    on a cache hit. This is what makes scrolling a tile out of the grid
 *    and back, or revisiting it later in the session, cost no network: the
 *    cache is keyed by URL, same as `CameraImage.vue`'s photos.
 *
 * 2. Fallback: a real `<video>` element on the camera's HTTP URL, seeked to
 *    its first frame. This is the ONLY thing that worked before the native
 *    path existed, and is kept as a fallback rather than removed, for two
 *    reasons: the native path is macOS-only (AVFoundation), and even on
 *    macOS it's new, unverified-by-a-real-build code — if it throws for any
 *    reason, falling back here means a bug in the native path degrades to
 *    "thumbnails re-decode on scroll, like before" rather than "no
 *    thumbnail at all". This path is NOT cacheable the same way: reading a
 *    decoded frame back out of this `<video>` through a `<canvas>` throws a
 *    `SecurityError` in this WKWebView (a cross-origin, non-CORS video
 *    taints the canvas), and `<video src="blob:...">` doesn't decode here
 *    at all — both verified on-device — which is the whole reason the
 *    native path exists in the first place.
 */
const {
  src,
  lrv,
  imgClass = "",
  eager = false,
} = defineProps<{
  /** Full-resolution source (the file that also plays back) */
  src: string;
  /** Optional low-res proxy to try first */
  lrv?: string;
  imgClass?: string;
  eager?: boolean;
}>();

const el = useTemplateRef("el");
const video = useTemplateRef<HTMLVideoElement>("video");
const activeSrc = ref<string | null>(null);
const objectUrl = ref<string | null>(null);
const state = ref<"idle" | "loading" | "loaded" | "loaded-video" | "error">("idle");

let observer: IntersectionObserver | null = null;
let stallTimer: ReturnType<typeof setTimeout> | null = null;
let releaseSlot: (() => void) | null = null;
let disposed = false;
let attempt = 0;

/** LRV proxy first (cheaper to decode), then the full file. */
const sources = computed(() => {
  const list: string[] = [];
  if (lrv && lrv !== src) list.push(lrv);
  list.push(src);
  return list;
});

function clearStall() {
  if (stallTimer) {
    clearTimeout(stallTimer);
    stallTimer = null;
  }
}

/** Free the shared camera slot this tile is holding, if any. */
function settle() {
  clearStall();
  releaseSlot?.();
  releaseSlot = null;
}

function queueAttempt() {
  const source = sources.value[attempt];
  if (!source) {
    state.value = "error";
    return;
  }
  // Hold a camera slot while the <video> fetches metadata + first frame, so a
  // screenful of tiles loads a couple at a time instead of all at once. The
  // slot is released by onReady/onError/stall, not by the media element.
  void withCameraSlot(
    () =>
      new Promise<void>((resolve) => {
        if (disposed) {
          resolve();
          return;
        }
        releaseSlot = resolve;
        activeSrc.value = source;
        clearStall();
        // If WebKit silently never fires loadeddata/seeked/error (e.g. a
        // moov-at-end file), give up the slot and fall to the next source.
        stallTimer = setTimeout(() => {
          if (state.value !== "loaded-video") onError();
        }, 15_000);
      }),
    eager ? CAMERA_PRIORITY.PREVIEW : () => viewportPriority(el.value),
  );
}

function beginVideoFallback() {
  attempt = 0;
  queueAttempt();
}

function onMeta() {
  const v = video.value;
  if (!v) return;
  // Seek a hair off zero — the very first frame is often black.
  try {
    v.currentTime = Math.min(0.1, (v.duration || 1) / 2);
  } catch {
    // Seeking unsupported: the loadeddata frame will have to do.
  }
}

function onReady() {
  settle();
  state.value = "loaded-video";
}

function onError() {
  settle();
  attempt++;
  queueAttempt();
}

async function load() {
  if (state.value !== "idle") return;
  state.value = "loading";

  const transport = getCameraTransport();
  if (transport.videoThumbnail) {
    try {
      const blob = await cachedMedia(`vthumb:${src}`, async () => {
        const bytes = await transport.videoThumbnail!(sources.value);
        if (!bytes.byteLength) throw new Error("empty thumbnail");
        return new Blob([bytes], { type: "image/jpeg" });
      });
      if (blob) {
        objectUrl.value = URL.createObjectURL(blob);
        state.value = "loaded";
        return;
      }
    } catch {
      // Native decode unavailable or failed for this file — fall through to
      // the <video>-element path below rather than showing an error for
      // something the old approach can still render.
    }
  }

  beginVideoFallback();
}

onMounted(() => {
  if (eager || !("IntersectionObserver" in window) || !el.value) {
    void load();
    return;
  }
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer?.disconnect();
        void load();
      }
    },
    { rootMargin: "300px" },
  );
  observer.observe(el.value);
});

onBeforeUnmount(() => {
  disposed = true;
  observer?.disconnect();
  settle();
  if (objectUrl.value) URL.revokeObjectURL(objectUrl.value);
});
</script>

<template>
  <div ref="el" class="relative size-full">
    <!-- Fallback path only: decode-only <video>, invisible until it has a
         frame, never used once the native path (above) produces an image. -->
    <video
      v-if="activeSrc"
      ref="video"
      :key="activeSrc"
      :src="activeSrc"
      muted
      playsinline
      preload="metadata"
      :class="[imgClass, state === 'loaded-video' ? '' : 'invisible']"
      @loadedmetadata="onMeta"
      @seeked="onReady"
      @loadeddata="onReady"
      @error="onError"
    />
    <img
      v-if="state === 'loaded' && objectUrl"
      :src="objectUrl"
      alt=""
      draggable="false"
      :class="imgClass"
      @error="state = 'error'"
    />
    <div
      v-if="state !== 'loaded' && state !== 'loaded-video'"
      class="absolute inset-0 flex items-center justify-center bg-elevated"
    >
      <UIcon v-if="state === 'error'" name="i-lucide-film" class="size-5 text-dimmed" />
      <UIcon v-else name="i-lucide-loader-circle" class="size-5 animate-spin text-dimmed" />
    </div>
  </div>
</template>
