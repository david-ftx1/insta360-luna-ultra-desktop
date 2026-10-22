import { JOYSTICK_MAX, sendJoystick, sendRecentre } from "~/utils/gimbalControl";

/** The phone repeats the held position continuously; ~25 a second is plenty. */
const SEND_INTERVAL_MS = 40;
/** An arrow key moves the gimbal at half speed; Shift + arrow at full speed. */
const KEY_SPEED = JOYSTICK_MAX / 2;

/**
 * Position messages go out on a fixed beat and never wait for the camera's reply
 * before the next one, as the phone does. An earlier version sent one at a time
 * and waited for each reply; one lost or late reply (the app waits up to 10 s
 * for it) then froze the gimbal until it timed out. Now a reply that has not
 * come within REPLY_GRACE_MS stops counting against MAX_OUTSTANDING, which is
 * only a safety cap against a camera that has stopped answering altogether —
 * at one message per 40 ms the grace period never gets near it.
 */
const REPLY_GRACE_MS = 300;
const MAX_OUTSTANDING = 16;

const ARROWS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

// One stick for the whole app, however many components ask for it.
let timer: ReturnType<typeof setInterval> | null = null;
let outstanding = 0;
let heldKey: string | null = null;

const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable);

/**
 * Gimbal joystick (added 2026-10-22; wire format in app/utils/gimbalControl.ts).
 * `enabled` is the on/off switch in the camera page header; nothing here moves the
 * gimbal while it is off — the on-screen pad, the arrow keys and the recentre
 * button all check it.
 */
export function useGimbalJoystick() {
  const { isConnected } = useCamera();
  const { enabled: trackingEnabled, toggle: toggleTracking } = useTracking();

  const enabled = useState<boolean>("gimbal-joystick-enabled", () => false);
  /** Where the stick is now: -64..64, + is up / right. Both 0 when let go. */
  const vertical = useState<number>("gimbal-joystick-vertical", () => 0);
  const horizontal = useState<number>("gimbal-joystick-horizontal", () => 0);

  function tick() {
    if (outstanding >= MAX_OUTSTANDING) return;
    outstanding++;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      outstanding--;
    };
    setTimeout(settle, REPLY_GRACE_MS);
    void sendJoystick(vertical.value, horizontal.value)
      .catch(() => {})
      .finally(settle);
  }

  /** Let go: stop repeating and tell the camera the stick is centred. */
  function release() {
    if (timer) clearInterval(timer);
    timer = null;
    const wasMoving = vertical.value !== 0 || horizontal.value !== 0;
    vertical.value = 0;
    horizontal.value = 0;
    if (wasMoving && isConnected.value) void sendJoystick(0, 0).catch(() => {});
  }

  function setAxes(v: number, h: number) {
    if (!enabled.value || !isConnected.value) return;
    const nextV = Math.max(-JOYSTICK_MAX, Math.min(JOYSTICK_MAX, Math.round(v)));
    const nextH = Math.max(-JOYSTICK_MAX, Math.min(JOYSTICK_MAX, Math.round(h)));
    if (nextV === 0 && nextH === 0) {
      release();
      return;
    }
    vertical.value = nextV;
    horizontal.value = nextH;
    if (!timer) {
      tick();
      timer = setInterval(tick, SEND_INTERVAL_MS);
    }
  }

  function toggle() {
    if (enabled.value) {
      heldKey = null;
      release();
    }
    enabled.value = !enabled.value;
  }

  /**
   * Swing the gimbal back to centre. Only while the joystick is on. The phone
   * sends close-tracking (238) first, so tracking is released the same way.
   */
  async function recentre() {
    if (!enabled.value || !isConnected.value) return;
    heldKey = null;
    release();
    if (trackingEnabled.value) await toggleTracking();
    await sendRecentre().catch(() => {});
  }

  /** Arrow keys, one at a time. Hold to move, let go to stop. */
  function onKeyDown(event: KeyboardEvent) {
    if (!enabled.value || !ARROWS.has(event.key)) return;
    if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
    event.preventDefault();
    if (heldKey !== null) return; // one at a time; also swallows auto-repeat
    heldKey = event.key;
    const speed = event.shiftKey ? JOYSTICK_MAX : KEY_SPEED;
    if (event.key === "ArrowUp") setAxes(speed, 0);
    else if (event.key === "ArrowDown") setAxes(-speed, 0);
    else if (event.key === "ArrowLeft") setAxes(0, -speed);
    else setAxes(0, speed);
  }

  function onKeyUp(event: KeyboardEvent) {
    if (event.key !== heldKey) return;
    heldKey = null;
    release();
  }

  /** Window lost focus, or the page is going away: never leave the gimbal moving. */
  function releaseAll() {
    heldKey = null;
    release();
  }

  return {
    enabled,
    vertical,
    horizontal,
    toggle,
    setAxes,
    release,
    recentre,
    onKeyDown,
    onKeyUp,
    releaseAll,
  };
}
