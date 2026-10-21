import type { CameraInfo, LiveViewStats, MediaItem } from "~/types/media";
import { lunaClient } from "~/utils/lunaClient";

/**
 * Everything the UI needs from a camera. The desktop app supplies the real
 * TCP/HTTP client; the docs-site demo supplies an in-browser mock. Nothing in
 * `components/` or `composables/` may import a concrete client directly.
 */
export interface CameraTransport {
  readonly available: boolean;
  connect(host: string): Promise<CameraInfo>;
  disconnect(): Promise<void>;
  status(): Promise<CameraInfo | null>;
  listMedia(host: string): Promise<MediaItem[]>;
  deleteFiles(cameraPaths: string[]): Promise<void>;
  command(code: number, body: Uint8Array): Promise<Uint8Array>;
  liveViewStart(): Promise<{ url: string; port: number }>;
  liveViewStop(): Promise<void>;
  /**
   * Restart the stream alone, without the view-mode transition
   * `liveViewStart`/`liveViewStop` send — see `luna_liveview_pause`/`_resume`
   * in `src-tauri/src/liveview.rs` for why that transition exists and why
   * skipping it matters: it's what parks and wakes the camera's gimbal, and
   * a brief stream interruption the app needs for its own reasons (not the
   * user navigating away) shouldn't move it. Optional like `videoThumbnail`:
   * a transport with no Tauri side (the docs-site mock) can omit it and let
   * callers fall back to the ordinary start/stop.
   */
  liveViewPause?(): Promise<void>;
  liveViewResume?(): Promise<{ url: string; port: number }>;
  liveViewStats(): Promise<LiveViewStats>;
  probeOscPreview(host: string): Promise<string | null>;
  /**
   * Decode one frame near the start of a video file natively and return it
   * as JPEG bytes — see `src-tauri/src/video_thumbnail.rs`. Optional, like
   * `noteTransferActivity`: only a Tauri-backed transport can drive
   * AVFoundation, so a transport with no native side (the docs-site mock)
   * can omit it and let `VideoThumb.vue` fall back to its own decode.
   */
  videoThumbnail?(urls: string[]): Promise<Uint8Array>;
  /**
   * Implementations own health reporting for their own transport: nothing
   * outside a `fetch` implementation calls `reportCameraSuccess` or
   * `reportCameraFailure` on its behalf, so a mock that implements `fetch`
   * without reporting leaves the health watchdog armed but permanently deaf.
   */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  probe(host: string): Promise<boolean>;
  onDisconnect(handler: () => void): Promise<() => void>;
  /**
   * A download just received bytes from the camera. Fire-and-forget: the
   * control-channel keepalive uses it to tell a camera busy serving a large
   * file from one that has gone. Optional for transports with no keepalive
   * (the docs-site mock).
   */
  noteTransferActivity?(): void;
  /**
   * Experimental, for the Deep Track overlay only (see
   * app/composables/useTracking.ts). Every inbound control-channel frame
   * that isn't a response to something we sent is normally dropped by the
   * Rust reader loop; this asks it to forward those instead, in case the
   * camera ever pushes an unprompted `CAMERA_NOTIFICATION_TRACK_SYNC` (the
   * named-but-unconfirmed candidate for it reporting its own tracking result
   * back — see docs/PROTOCOL-GAP.md). Optional: only a Tauri-backed
   * transport has a reader loop to toggle (the docs-site mock omits it).
   */
  setNotificationCapture?(enabled: boolean): Promise<void>;
  /**
   * Subscribe to whatever `setNotificationCapture(true)` turns up — raw
   * `{code, requestId, bodyHex}`, undecoded, because what arrives (if
   * anything) and its payload shape are exactly the open questions. Returns
   * an unsubscribe fn. Optional alongside `setNotificationCapture`.
   */
  onTrackingNotification?(
    handler: (notification: { code: number; requestId: number; bodyHex: string }) => void,
  ): Promise<() => void>;
}

/**
 * The real client is the default, so the desktop app behaves identically
 * whether or not anything ever calls `setCameraTransport`.
 *
 * This is process-global, not request-scoped: under SSR every concurrent
 * request reads and writes the same `current`. A consuming app that runs
 * `ssr: true` (unlike this desktop app, which is `ssr: false`) must install
 * its transport from a client-only plugin, never from server-side code —
 * otherwise one request's transport leaks into another's. Note that the
 * composables reading this store their own data in `useState`, which IS
 * request-scoped, so the two layers do not share the same lifetime.
 */
let current: CameraTransport = lunaClient;

export function setCameraTransport(transport: CameraTransport): void {
  current = transport;
}

/** Restore the real client. Used by tests; never called by app code. */
export function resetCameraTransport(): void {
  current = lunaClient;
}

export function getCameraTransport(): CameraTransport {
  return current;
}
