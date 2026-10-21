<script setup lang="ts">
/**
 * Tracking Framing picker — the iPhone app's 3x3 "preset tracking point"
 * screen, added 2026-10-21. Read app/utils/trackingFraming.ts first: it has the
 * capture-confirmed command (code 244, box top-left x/y + w/h) and what is
 * still unverified (that sending it from this app moves the gimbal).
 *
 * Behaviour copied from the real app: a small icon sits near the top-left of
 * the live view, shown ONLY while tracking is on (here: `locked`, the camera-
 * confirmed lock — see useTracking.ts). Tapping it opens a dimmed overlay with
 * nine white boxes over the picture. Tapping one selects it, highlights it
 * green and sends it; the overlay STAYS OPEN so several points can be tried
 * in a row, as in the iPhone app's recording, and closes with the X. The
 * chosen point is remembered and shown as a small chip once closed.
 *
 * Mounted by app/pages/camera.vue above TrackingOverlay (z-40 vs z-30). The
 * root is pointer-events-none so the draw-a-box surface underneath still gets
 * its drags; only the trigger button, the chip and the open overlay take
 * pointer events themselves.
 */

import { containRect, FRAMING_POINTS, FRAMING_SENDS_TO_CAMERA } from "~/utils/trackingFraming";

const { getIntrinsicSize } = defineProps<{
  /** Same contract as TrackingOverlay's prop: the live view's decoded frame
   * size, so the nine boxes land on the picture rather than on the letterbox
   * bars. Null until a frame has decoded. */
  getIntrinsicSize: () => { width: number; height: number } | null;
}>();

const {
  locked,
  framingIndex,
  framingPickerOpen,
  framingNote,
  openFramingPicker,
  closeFramingPicker,
  selectFraming,
} = useTracking();

const root = useTemplateRef<HTMLDivElement>("root");

/** Container size, kept reactive so the boxes re-lay-out on window resize. */
const size = ref({ width: 0, height: 0 });
let observer: ResizeObserver | null = null;

function measure() {
  const el = root.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  size.value = { width: rect.width, height: rect.height };
}

onMounted(() => {
  measure();
  if (root.value && typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(measure);
    observer.observe(root.value);
  }
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
});

/** Pixel position of each box's centre inside `root`. Reads
 * `framingPickerOpen` so it re-evaluates each time the overlay opens, which is
 * when the intrinsic frame size is most likely to have changed since last time
 * (`getIntrinsicSize` itself isn't reactive). */
const boxes = computed(() => {
  void framingPickerOpen.value;
  const frame = getIntrinsicSize();
  const content = frame
    ? containRect(size.value.width, size.value.height, frame.width, frame.height)
    : null;
  // No decoded frame yet: fall back to the whole container rather than
  // showing nothing — the nine positions are still meaningful as fractions.
  const area = content ?? { left: 0, top: 0, width: size.value.width, height: size.value.height };
  return FRAMING_POINTS.map((point) => ({
    ...point,
    left: `${area.left + point.x * area.width}px`,
    top: `${area.top + point.y * area.height}px`,
    // The iPhone app's boxes are square on the picture (w x h is 0.0605 x
    // 0.1075 of a 16:9 frame); floor the size so they stay tappable when the
    // viewfinder is small.
    width: `${Math.max(24, point.rect.w * area.width)}px`,
    height: `${Math.max(24, point.rect.h * area.height)}px`,
  }));
});

const chosen = computed(() =>
  framingIndex.value === null ? null : (FRAMING_POINTS[framingIndex.value] ?? null),
);
</script>

<template>
  <div ref="root" class="pointer-events-none absolute inset-0">
    <template v-if="locked">
      <!-- Trigger: only exists while tracking is locked, like the real app's icon. -->
      <div v-if="!framingPickerOpen" class="absolute left-4 top-12 flex items-center gap-2">
        <UButton
          class="pointer-events-auto"
          icon="i-lucide-focus"
          color="neutral"
          variant="subtle"
          size="sm"
          aria-label="Tracking framing"
          @click="openFramingPicker()"
        />
        <span
          v-if="chosen"
          class="pointer-events-none rounded-md bg-black/60 px-2 py-1 font-mono text-[11px] text-white/80"
          :title="framingNote ?? undefined"
        >
          Framing: {{ chosen.label }}<template v-if="framingNote"> · not sent</template>
        </span>
      </div>

      <!-- Picker: dimmed overlay, nine boxes, tap one to choose. -->
      <div
        v-if="framingPickerOpen"
        class="pointer-events-auto absolute inset-0 bg-black/45"
        @click.self="closeFramingPicker()"
      >
        <div class="pointer-events-none absolute left-4 top-12 max-w-xs space-y-1 text-white">
          <p class="text-sm font-medium">Tracking Framing</p>
          <p class="text-xs text-white/70">Select a preset tracking point.</p>
        </div>

        <UButton
          class="absolute right-4 top-12"
          icon="i-lucide-x"
          color="neutral"
          variant="subtle"
          size="sm"
          aria-label="Close tracking framing"
          @click="closeFramingPicker()"
        />

        <button
          v-for="box in boxes"
          :key="box.index"
          type="button"
          class="absolute -translate-x-1/2 -translate-y-1/2 rounded-md border-2 transition-colors"
          :class="
            box.index === framingIndex
              ? 'border-green-400 bg-green-400/30'
              : 'border-white/80 bg-white/10 hover:bg-white/30'
          "
          :style="{ left: box.left, top: box.top, width: box.width, height: box.height }"
          :aria-label="`Frame subject ${box.label}`"
          :aria-pressed="box.index === framingIndex"
          @click.stop="selectFraming(box.index)"
        />

        <p
          class="pointer-events-none absolute inset-x-0 bottom-16 text-center text-[11px] text-white/60"
        >
          {{
            FRAMING_SENDS_TO_CAMERA
              ? "Experimental — sent to the camera as in the iPhone app; not yet verified here."
              : "Experimental — your choice is not sent to the camera."
          }}
        </p>
      </div>
    </template>
  </div>
</template>
