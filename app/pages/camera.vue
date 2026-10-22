<script setup lang="ts">
import { optionLabel } from "~/utils/cameraLabels";
import { FEATURES } from "~/utils/features";
import { containRect } from "~/utils/trackingFraming";

const { isConnected } = useCamera();
const { device, settings, loading, error, load } = useCameraSettings();
const { active, starting, error: liveError, start, stop } = useLiveView();
const { recording, elapsedLabel } = useCameraCapture();
// Scrolling over the picture is the desktop way to zoom; the dial is a readout
// you can also drag. Both drive the same gesture state.
const { onWheel } = useCameraZoom();
const {
  enabled: trackingEnabled,
  toggle: toggleTracking,
  locked: trackingLocked,
  cancel: cancelTracking,
  framingPickerOpen,
} = useTracking();

/**
 * Gimbal joystick (switch in the header, arrow keys, on-screen stick, recentre)
 * and double-click-to-focus, added 2026-10-22 — see app/utils/gimbalControl.ts.
 */
const {
  enabled: joystickEnabled,
  toggle: toggleJoystick,
  onKeyDown,
  onKeyUp,
  releaseAll: releaseJoystick,
} = useGimbalJoystick();
const { focusAt } = useTapFocus();

onMounted(() => {
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", releaseJoystick);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("keyup", onKeyUp);
  window.removeEventListener("blur", releaseJoystick);
  releaseJoystick();
});

/**
 * REDESIGNED 2026-10-20: one button now does all three jobs David asked
 * for, instead of this toggle plus TrackingOverlay.vue's own "x" (removed —
 * see that file's top comment). Off -> on arms the experiment exactly as
 * `toggleTracking` always did; while armed but not yet locked, clicking
 * again still gives up the same way. Locked (useTracking.ts's `locked`,
 * which the button also now colours green for — see the template below) is
 * the new case: clicking then calls `cancelTracking` instead, releasing the
 * lock without leaving the experiment armed, so a new box can be drawn
 * right away without re-enabling first.
 */
function handleTrackingClick() {
  if (trackingLocked.value) {
    void cancelTracking();
  } else {
    void toggleTracking();
  }
}

useHead({ title: "Camera" });

/** So TrackingOverlay can map a drawn box back onto the decoded frame's own
 * resolution instead of this element's CSS size — see LiveView.vue's
 * getIntrinsicSize comment. Left for Vue to infer from LiveView's own
 * defineExpose rather than given an explicit (and non-Element) generic. */
const liveView = useTemplateRef("liveView");

/**
 * Double-click anywhere on the picture to focus there. Clicks on the controls
 * laid over it (buttons, the zoom dial, the bottom bar — marked `data-no-focus`)
 * and on the letterbox bars are ignored, and so is any click while the Tracking
 * Framing picker is open.
 */
function onStageDoubleClick(event: MouseEvent) {
  if (!active.value || framingPickerOpen.value) return;
  const target = event.target;
  if (
    target instanceof Element &&
    target.closest("button, a, input, select, textarea, [data-no-focus]")
  )
    return;
  const stage = event.currentTarget;
  if (!(stage instanceof HTMLElement)) return;
  const box = stage.getBoundingClientRect();
  const frame = liveView.value?.getIntrinsicSize() ?? null;
  const content = frame ? containRect(box.width, box.height, frame.width, frame.height) : null;
  const area = content ?? { left: 0, top: 0, width: box.width, height: box.height };
  const x = (event.clientX - box.left - area.left) / area.width;
  const y = (event.clientY - box.top - area.top) / area.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;
  focusAt(x, y);
}

/** The deep settings live in a slide-over, so the viewfinder never scrolls. */
const settingsOpen = ref(false);

/**
 * Opening the page should feel like picking up a camera: the preview starts on
 * its own as soon as we are connected, and stops when the connection drops.
 */
watch(
  isConnected,
  (connected) => {
    if (connected) void start();
    else void stop();
  },
  { immediate: true },
);

/**
 * MOVED 2026-10-20 (later the same day): the "losing the camera switches
 * Deep Track off" watcher used to live here. David found it didn't survive
 * a disconnect done from somewhere other than this page — he confirmed
 * "disconnect" means the Disconnect button on index.vue/settings.vue, and
 * this component (and the watch below it was) is unmounted the entire time
 * someone is sitting on that page, so nothing was listening. It now lives
 * in useTracking.ts itself, installed once in a detached effect scope that
 * outlives any one page — see that file's own comment for the full story.
 * `trackingEnabled` stays imported here only for the navbar button's own
 * colour, below.
 */

/**
 * The preview holds the camera's single HTTP connection. Release it *before*
 * navigating away and wait for it to close — otherwise the next page (e.g. the
 * gallery, which reads media over that same connection) races the tear-down,
 * its requests fail, and the health detector force-disconnects the camera.
 */
onBeforeRouteLeave(async () => {
  await stop();
});

const battery = computed(() => {
  const status = device.value.battery_status as Record<string, unknown> | undefined;
  return typeof status?.battery_level === "number" ? status.battery_level : null;
});

const batteryClass = computed(() => {
  if (battery.value === null) return "";
  if (battery.value <= 20) return "text-red-400";
  if (battery.value <= 40) return "text-amber-300";
  return "";
});

const storage = computed(() => {
  const state = device.value.storage_state as Record<string, unknown> | undefined;
  if (typeof state?.free_space !== "number") return null;
  return state.free_space / 1e9;
});

/** The camera reports remaining recording time in seconds. */
const remaining = computed(() => {
  const seconds = settings.value.remaining_time;
  if (typeof seconds !== "number" || seconds <= 0) return null;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h${minutes}m` : `${minutes}m`;
});

/**
 * RES_3840_2160P30 reads as "3840×2160 · 30p" — the way a camera prints it,
 * rather than the enum name with its underscores swapped for spaces.
 */
const resolution = computed(() => {
  const raw = settings.value.record_resolution;
  if (!raw) return null;
  const match = /^RES_(\d+)_(\d+)P(\d+)$/.exec(String(raw));
  if (!match) return String(raw).replace("RES_", "").replace(/_/g, " ");
  return `${match[1]}×${match[2]} · ${match[3]}p`;
});

/** The look that is being baked into the recording, worth knowing at a glance. */
const activeFilter = computed(() => {
  const filter = settings.value.gamma_mode;
  if (!filter || String(filter) === "FILTER_NONE") return null;
  return optionLabel(String(filter));
});

const colorMode = computed(() =>
  settings.value.color_mode ? optionLabel(String(settings.value.color_mode)) : null,
);

/** One quiet line at the top of the stage, so errors never reflow the layout. */
const topError = computed(() => liveError.value ?? error.value ?? null);
</script>

<template>
  <UDashboardPanel id="camera">
    <template #header>
      <UDashboardNavbar title="Camera">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <UButton
            icon="i-lucide-refresh-cw"
            color="neutral"
            variant="ghost"
            :loading
            :disabled="!isConnected"
            aria-label="Reload settings"
            @click="() => load()"
          />
          <UButton
            v-if="FEATURES.allSettings"
            icon="i-lucide-sliders-horizontal"
            color="neutral"
            variant="ghost"
            :disabled="!isConnected"
            aria-label="Camera settings"
            @click="settingsOpen = true"
          />
          <UButton
            icon="i-lucide-gamepad-2"
            :color="joystickEnabled ? 'success' : 'neutral'"
            variant="ghost"
            :disabled="!isConnected"
            :aria-label="
              joystickEnabled ? 'Switch off gimbal joystick' : 'Switch on gimbal joystick'
            "
            :title="
              joystickEnabled
                ? 'Gimbal joystick on — arrow keys move the gimbal'
                : 'Gimbal joystick'
            "
            @click="toggleJoystick"
          />
          <UButton
            v-if="FEATURES.deepTrackExperiment"
            icon="i-lucide-scan-face"
            :color="trackingLocked ? 'success' : trackingEnabled ? 'warning' : 'neutral'"
            variant="ghost"
            :disabled="!isConnected"
            :aria-label="trackingLocked ? 'Cancel Deep Track lock' : 'Deep Track (experimental)'"
            @click="handleTrackingClick"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div
        v-if="!isConnected"
        class="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center"
      >
        <UIcon name="i-lucide-video-off" class="size-8 text-dimmed" />
        <div class="space-y-1">
          <p class="font-medium text-highlighted">No camera connected</p>
          <p class="max-w-sm text-sm text-muted">
            Join the Luna Ultra's Wi-Fi network and connect, and the viewfinder starts here.
          </p>
        </div>
        <UButton label="Connect" icon="i-lucide-plug" to="/" />
      </div>

      <div v-else class="flex min-h-0 flex-1 flex-col gap-3">
        <!-- Viewfinder: the hero. Everything else floats over it. -->
        <div
          class="relative min-h-0 flex-1 overflow-hidden rounded-2xl bg-black"
          @wheel="onWheel"
          @dblclick="onStageDoubleClick"
        >
          <LiveView ref="liveView" class="absolute inset-0" />

          <!--
            Deep Track overlay — experimental, see TrackingOverlay.vue. Sits
            above everything else in the stage (z-30) so it can capture the
            drag gesture, but is pointer-events-none and draws nothing of its
            own when the toggle above is off.
          -->
          <TrackingOverlay
            v-if="FEATURES.deepTrackExperiment"
            :get-intrinsic-size="() => liveView?.getIntrinsicSize() ?? null"
            class="absolute inset-0 z-30"
          />

          <!--
            Tracking Framing — the 3x3 preset-point picker, shown only while
            Deep Track is locked. Above the overlay (z-40) but click-through
            except for its own controls. See TrackingFramingPicker.vue: nothing
            it picks is sent to the camera yet.
          -->
          <!-- Yellow box where the camera was last asked to focus -->
          <FocusBox
            :get-intrinsic-size="() => liveView?.getIntrinsicSize() ?? null"
            class="absolute inset-0 z-30"
          />

          <TrackingFramingPicker
            v-if="FEATURES.deepTrackExperiment"
            :get-intrinsic-size="() => liveView?.getIntrinsicSize() ?? null"
            class="absolute inset-0 z-40"
          />

          <!-- Starting / stopped state, centred over the black stage -->
          <div
            v-if="!active"
            class="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/60"
          >
            <template v-if="starting">
              <UIcon name="i-lucide-loader-circle" class="size-6 animate-spin" />
              <span class="text-sm">Starting preview…</span>
            </template>
            <UButton
              v-else
              icon="i-lucide-play"
              color="neutral"
              variant="subtle"
              label="Start preview"
              @click="start"
            />
          </div>

          <!--
            Frame marks. A viewfinder shows you the bounds of what it is
            recording, and the brackets are how every camera says it. They also
            give the black stage a job when the preview has not started.
          -->
          <div class="pointer-events-none absolute inset-4 z-10">
            <span class="absolute left-0 top-0 size-5 border-l border-t border-white/25" />
            <span class="absolute right-0 top-0 size-5 border-r border-t border-white/25" />
            <span class="absolute bottom-0 left-0 size-5 border-b border-l border-white/25" />
            <span class="absolute bottom-0 right-0 size-5 border-b border-r border-white/25" />
          </div>

          <!--
            One scrim carries every readout, instead of each getting its own
            pill. Camera markings are engraved onto the finder, not stuck on it.
          -->
          <div
            class="pointer-events-none absolute inset-x-0 top-0 z-10 bg-gradient-to-b from-black/70 via-black/30 to-transparent pb-8"
          >
            <div
              class="flex items-start justify-between gap-4 p-4 pr-14 font-mono text-[11px] text-white/70"
            >
              <div class="flex items-center gap-3">
                <!--
                  Red appears exactly once in this interface, and it means
                  recording. Anything else wearing it would dilute the one
                  signal you must never misread.
                -->
                <span v-if="recording" class="flex items-center gap-1.5 text-white">
                  <span class="size-2 rounded-full bg-red-500 motion-safe:animate-pulse" />
                  <span class="tabular-nums tracking-wider">{{ elapsedLabel }}</span>
                </span>
                <span v-if="remaining" class="tracking-wider">{{ remaining }} left</span>
                <span v-if="storage" class="tracking-wider">{{ storage.toFixed(1) }} GB</span>
              </div>

              <!--
                The readouts keep their single line; the histogram hangs below
                them on the same right rail, clear of the zoom dial's column.
              -->
              <div class="flex flex-col items-end gap-2 text-right">
                <div class="flex items-center gap-3">
                  <span v-if="activeFilter" class="tracking-wider text-white">{{
                    activeFilter
                  }}</span>
                  <span v-if="colorMode" class="tracking-wider">{{ colorMode }}</span>
                  <span v-if="resolution" class="tracking-wider">{{ resolution }}</span>
                  <span
                    v-if="battery !== null"
                    class="flex items-center gap-1 tabular-nums tracking-wider"
                    :class="batteryClass"
                  >
                    <UIcon name="i-lucide-battery" class="size-3.5" />
                    {{ battery }}%
                  </span>
                </div>

                <CameraHistogram />
              </div>
            </div>
          </div>

          <!--
            The zoom dial hugs the right edge, clear of the readout rail above
            and the pro bar below, so a drag never lands on another control.
          -->
          <div class="absolute inset-y-20 right-2 z-20 flex items-center" data-no-focus>
            <CameraZoomDial />
          </div>

          <!-- Gimbal: recentre button, and the stick while the joystick is on -->
          <GimbalJoystickPad />

          <!-- Errors sit below the readout rail, so neither ever moves -->
          <div v-if="topError" class="absolute inset-x-0 top-14 z-20 flex justify-center px-4">
            <span
              class="flex items-center gap-1.5 rounded-lg bg-warning/90 px-3 py-1.5 text-xs text-white shadow-lg backdrop-blur-md"
            >
              <UIcon name="i-lucide-triangle-alert" class="size-3.5 shrink-0" />
              {{ topError }}
            </span>
          </div>

          <!-- Quick exposure bar + gear, along the bottom of the viewfinder -->
          <div
            class="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/70 via-black/40 to-transparent p-2 pr-12 pt-10"
            data-no-focus
          >
            <CameraProBar @open-settings="settingsOpen = true" />
          </div>
        </div>

        <!-- Mode strip + shutter -->
        <CameraCaptureBar />
      </div>

      <!-- Portals to the document body, so it lives here without disturbing the panel slots -->
      <USlideover
        v-model:open="settingsOpen"
        title="Camera settings"
        description="Everything the camera exposes."
      >
        <template #body>
          <CameraSettings />
        </template>
      </USlideover>
    </template>
  </UDashboardPanel>
</template>
