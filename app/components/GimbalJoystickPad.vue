<script setup lang="ts">
/**
 * Bottom-left of the viewfinder: the recentre button, and — while the joystick
 * is switched on — the on-screen stick (added 2026-10-22, from the iPhone app).
 * Drag the knob; the further from the middle, the faster the gimbal. Let go and
 * it stops. The arrow keys do the same from the keyboard (useGimbalJoystick.ts).
 * The recentre button is always drawn but only works while the joystick is on.
 */
import { JOYSTICK_MAX } from "~/utils/gimbalControl";

const { enabled, setAxes, release, recentre } = useGimbalJoystick();
const { isConnected } = useCamera();

/** How far the knob can travel from the middle, in px. */
const TRAVEL = 48;

const pad = useTemplateRef<HTMLDivElement>("pad");
const knob = ref({ x: 0, y: 0 });
let dragging = false;

function update(event: PointerEvent) {
  const el = pad.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  let dx = event.clientX - (rect.left + rect.width / 2);
  let dy = event.clientY - (rect.top + rect.height / 2);
  const distance = Math.hypot(dx, dy);
  if (distance > TRAVEL) {
    dx = (dx * TRAVEL) / distance;
    dy = (dy * TRAVEL) / distance;
  }
  knob.value = { x: dx, y: dy };
  // Screen y grows downward; up is positive on the wire.
  setAxes((-dy / TRAVEL) * JOYSTICK_MAX, (dx / TRAVEL) * JOYSTICK_MAX);
}

function onPointerDown(event: PointerEvent) {
  dragging = true;
  pad.value?.setPointerCapture(event.pointerId);
  update(event);
}

function onPointerMove(event: PointerEvent) {
  if (dragging) update(event);
}

function onPointerUp() {
  if (!dragging) return;
  dragging = false;
  knob.value = { x: 0, y: 0 };
  release();
}

// Switching the joystick off mid-drag must also put the knob back
watch(enabled, (on) => {
  if (!on) {
    dragging = false;
    knob.value = { x: 0, y: 0 };
  }
});
</script>

<template>
  <div class="absolute bottom-20 left-4 z-20 flex items-end gap-3" data-no-focus>
    <UButton
      icon="i-lucide-locate-fixed"
      color="neutral"
      variant="subtle"
      size="lg"
      :disabled="!enabled || !isConnected"
      aria-label="Recentre gimbal"
      title="Recentre gimbal (joystick must be on)"
      @click="recentre"
    />

    <div
      v-if="enabled"
      ref="pad"
      class="relative size-28 touch-none select-none rounded-full border border-white/25 bg-black/40 backdrop-blur-sm"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      <UIcon
        name="i-lucide-chevron-up"
        class="pointer-events-none absolute left-1/2 top-1 size-4 -translate-x-1/2 text-white/40"
      />
      <UIcon
        name="i-lucide-chevron-down"
        class="pointer-events-none absolute bottom-1 left-1/2 size-4 -translate-x-1/2 text-white/40"
      />
      <UIcon
        name="i-lucide-chevron-left"
        class="pointer-events-none absolute left-1 top-1/2 size-4 -translate-y-1/2 text-white/40"
      />
      <UIcon
        name="i-lucide-chevron-right"
        class="pointer-events-none absolute right-1 top-1/2 size-4 -translate-y-1/2 text-white/40"
      />
      <div
        class="pointer-events-none absolute left-1/2 top-1/2 size-8 rounded-full bg-white/90 shadow"
        :style="{
          transform: `translate(calc(-50% + ${knob.x}px), calc(-50% + ${knob.y}px))`,
        }"
      />
    </div>
  </div>
</template>
