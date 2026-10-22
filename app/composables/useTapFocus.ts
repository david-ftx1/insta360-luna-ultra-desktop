import { type FocusRect, focusRectAround, sendFocus } from "~/utils/gimbalControl";

/** How long the yellow box stays on the picture, as on the phone. */
const SHOW_MS = 1500;

let hideTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Tap to focus (added 2026-10-22; wire format in app/utils/gimbalControl.ts).
 * `focusAt` takes a point on the picture, 0..1 left-to-right / top-to-bottom,
 * puts the camera's focus box there and shows the yellow box.
 */
export function useTapFocus() {
  const { isConnected } = useCamera();
  const { mode } = useCameraSettings();

  const focusBox = useState<FocusRect | null>("tap-focus-box", () => null);

  function focusAt(x: number, y: number) {
    if (!isConnected.value) return;
    const rect = focusRectAround(x, y);
    focusBox.value = rect;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      focusBox.value = null;
      hideTimer = null;
    }, SHOW_MS);
    void sendFocus(rect, mode.value).catch(() => {});
  }

  return { focusBox, focusAt };
}
