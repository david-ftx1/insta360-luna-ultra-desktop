<script setup lang="ts">
/**
 * The yellow box that marks where the camera was asked to focus (added
 * 2026-10-22, like the iPhone app's). It draws whatever `useTapFocus` last
 * sent — same size and place the camera was given — and goes away by itself.
 * Click-through: it never takes the mouse.
 */
import { containRect } from "~/utils/trackingFraming";

const { getIntrinsicSize } = defineProps<{
  /** Same contract as TrackingOverlay's prop: the decoded frame's size, so the
   * box lands on the picture and not on the letterbox bars. */
  getIntrinsicSize: () => { width: number; height: number } | null;
}>();

const { focusBox } = useTapFocus();

const root = useTemplateRef<HTMLDivElement>("root");
const size = ref({ width: 0, height: 0 });
let observer: ResizeObserver | null = null;

function measure() {
  const rect = root.value?.getBoundingClientRect();
  if (rect) size.value = { width: rect.width, height: rect.height };
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

const style = computed(() => {
  const box = focusBox.value;
  if (!box) return null;
  const frame = getIntrinsicSize();
  const content = frame
    ? containRect(size.value.width, size.value.height, frame.width, frame.height)
    : null;
  const area = content ?? { left: 0, top: 0, width: size.value.width, height: size.value.height };
  return {
    left: `${area.left + box.x * area.width}px`,
    top: `${area.top + box.y * area.height}px`,
    width: `${box.w * area.width}px`,
    height: `${box.h * area.height}px`,
  };
});
</script>

<template>
  <div ref="root" class="pointer-events-none absolute inset-0">
    <div v-if="style" class="absolute border-2 border-yellow-300" :style />
  </div>
</template>
