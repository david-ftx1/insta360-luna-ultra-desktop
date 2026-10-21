import type { CameraInfo, CameraStatus, MediaItem } from "~/types/media";
import { getCameraTransport } from "~/utils/transport";
import { armCameraHealth, disarmCameraHealth, FAILURE_THRESHOLD } from "~/utils/cameraHealth";
import { forgetCachedMedia } from "~/utils/mediaCache";
import { rawPreviewKey } from "~/utils/rawPreviewCache";

const DEFAULT_HOST = "192.168.42.1";
const HOST_STORAGE_KEY = "luna-camera-host";

/** Reconnect backoff schedule; the last delay repeats until reconnected. */
const RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 15000];

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let networkWatcherInstalled = false;
let syncingLibrary = false;

export function useCamera() {
  const status = useState<CameraStatus>("camera-status", () => "disconnected");
  const info = useState<CameraInfo | null>("camera-info", () => null);
  const library = useState<MediaItem[]>("camera-library", () => []);
  const host = useState<string>("camera-host", () => {
    if (import.meta.client) {
      // Trim on read as well as on write: a blank stored value is treated as
      // absent so it falls back to the default instead of an empty address.
      const stored = localStorage.getItem(HOST_STORAGE_KEY)?.trim();
      if (stored) return stored;
    }
    return DEFAULT_HOST;
  });
  const error = useState<string | null>("camera-error", () => null);
  const loadingLibrary = useState<boolean>("camera-library-loading", () => false);
  /** True from a successful manual connect until a manual disconnect */
  const wantConnection = useState<boolean>("camera-want-connection", () => false);
  const retryAttempt = useState<number>("camera-retry-attempt", () => 0);

  // Persisted so the home page can ship a bare Connect button: a user on a
  // non-default gateway should not have to retype it every launch.
  if (import.meta.client) {
    watch(host, (value) => {
      localStorage.setItem(HOST_STORAGE_KEY, value.trim());
    });
  }

  const isConnected = computed(() => status.value === "connected");
  const isBusy = computed(() => status.value === "connecting");
  const available = computed(() => getCameraTransport().available);

  let disconnectUnlisten: (() => void) | null = null;

  function clearRetryTimer() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  async function tryReconnect() {
    if (!wantConnection.value || isConnected.value || isBusy.value) return;
    status.value = "connecting";
    try {
      info.value = await getCameraTransport().connect(host.value);
      status.value = "connected";
      error.value = null;
      retryAttempt.value = 0;
      armCameraHealth(
        () => {
          void forceDisconnect();
        },
        () => getCameraTransport().probe(host.value),
      );
      await refreshLibrary();
    } catch {
      status.value = "disconnected";
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (retryTimer || !wantConnection.value) return;
    const delay = RETRY_DELAYS_MS[Math.min(retryAttempt.value, RETRY_DELAYS_MS.length - 1)]!;
    retryAttempt.value += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void tryReconnect();
    }, delay);
  }

  /** Retry immediately when the OS reports the network came back (Wi-Fi rejoin, etc.). */
  function watchNetwork() {
    if (networkWatcherInstalled || !import.meta.client) return;
    networkWatcherInstalled = true;
    window.addEventListener("online", () => {
      if (!wantConnection.value || isConnected.value) return;
      clearRetryTimer();
      retryAttempt.value = 0;
      void tryReconnect();
    });
  }

  async function watchDisconnect() {
    const transport = getCameraTransport();
    if (!transport.available || disconnectUnlisten) return;
    disconnectUnlisten = await transport.onDisconnect(() => {
      status.value = "disconnected";
      info.value = null;
      library.value = [];
      error.value = "Lost connection to the camera. Reconnecting…";
      retryAttempt.value = 0;
      // This is a known socket close, not a silently-unresponsive camera: disarm the
      // health detector so its failure count can't race scheduleReconnect() below and
      // trigger forceDisconnect(), which would cancel this reconnect. It re-arms itself
      // once tryReconnect() succeeds again.
      disarmCameraHealth();
      scheduleReconnect();
    });
  }

  async function refreshLibrary() {
    if (!isConnected.value) return;
    loadingLibrary.value = true;
    error.value = null;
    try {
      library.value = await getCameraTransport().listMedia(host.value);
    } catch (e) {
      error.value = e instanceof Error ? e.message : "Failed to read the media library.";
    } finally {
      loadingLibrary.value = false;
    }
  }

  async function connect() {
    if (isConnected.value || isBusy.value) return;
    error.value = null;
    if (!getCameraTransport().available) {
      error.value =
        "Camera control requires the desktop app. Run the packaged Luna Ultra app to connect.";
      return;
    }
    status.value = "connecting";
    try {
      await watchDisconnect();
      watchNetwork();
      info.value = await getCameraTransport().connect(host.value);
      status.value = "connected";
      // Auto-reconnect only after a session the user established succeeds
      wantConnection.value = true;
      armCameraHealth(
        () => {
          void forceDisconnect();
        },
        () => getCameraTransport().probe(host.value),
      );
      retryAttempt.value = 0;
      await refreshLibrary();
    } catch (e) {
      status.value = "disconnected";
      info.value = null;
      error.value = e instanceof Error ? e.message : "Could not connect to the camera.";
    }
  }

  /**
   * Tear down the session without touching `wantConnection`. Shared by the
   * user-initiated disconnect and the health-detector disconnect.
   */
  async function teardown() {
    clearRetryTimer();
    disarmCameraHealth();
    await getCameraTransport().disconnect();
    status.value = "disconnected";
    info.value = null;
    library.value = [];
  }

  async function disconnect() {
    wantConnection.value = false;
    await teardown();
    error.value = null;
  }

  /**
   * The camera stopped answering. Drop the session and leave it dropped:
   * clearing `wantConnection` keeps the backoff reconnect loop dormant so it
   * cannot immediately undo this. The user reconnects deliberately.
   */
  async function forceDisconnect() {
    wantConnection.value = false;
    await teardown();
    error.value = `Lost contact with the camera. Disconnected after ${FAILURE_THRESHOLD} failed requests and a failed health check.`;
  }

  /** Remove items locally after the camera confirms deletion. */
  function removeFromLibrary(cameraPaths: string[]) {
    const removing = new Set(cameraPaths);
    library.value = library.value.filter((item) => !removing.has(item.cameraPath));
  }

  /**
   * Drop cached thumbnails for files that no longer exist on the camera, by
   * every cache key a tile could have stored one under (see CameraImage.vue,
   * VideoThumb.vue, and RawImage.vue/rawPreviewCache.ts for where each key
   * comes from). Pushing all three per item is harmless — forgetting a key
   * that was never cached is a no-op — and avoids having to track which
   * component actually rendered each item.
   *
   * Deliberately skips `previewUrl` (the RAW+JPEG sibling-preview case): that
   * URL is the sibling JPEG's own `srcUrl`, cached under its own `img:` key,
   * and that sibling MediaItem may still exist independently of this one.
   */
  function forgetThumbnails(removed: MediaItem[]) {
    const keys: string[] = [];
    for (const item of removed) {
      keys.push(`img:${item.srcUrl}`);
      keys.push(`vthumb:${item.srcUrl}`);
      keys.push(rawPreviewKey(item.srcUrl, { maxBytes: 2_000_000, prefer: "smallest" }));
    }
    forgetCachedMedia(keys);
  }

  /**
   * Quietly refresh the library against the camera's current file list:
   * append files that appeared since the last load, and drop (and forget
   * the thumbnails of) files that no longer exist. Unlike `refreshLibrary`,
   * this never toggles `loadingLibrary` or surfaces a fetch failure — it's a
   * background freshness check, not the primary load path, so a slow or
   * failed round-trip here should be invisible rather than flashing a
   * skeleton or an error the user didn't ask for.
   *
   * Existing item objects are kept (not replaced) for files still present,
   * so in-place annotations a tile sets once it decodes — `width`/`height`/
   * `panoramic` (see gallery.vue's `annotateDimensions`) — survive the sync.
   *
   * The camera's GET_FILE_LIST protocol has no incremental/delta mode, so
   * this still re-walks the whole list; "quick" describes the UI behaviour
   * (no loading flash, no wholesale replace) rather than the network cost.
   */
  async function syncLibrary() {
    if (!isConnected.value || syncingLibrary) return;
    syncingLibrary = true;
    try {
      const fresh = await getCameraTransport().listMedia(host.value);
      const freshIds = new Set(fresh.map((item) => item.id));
      const previousById = new Map(library.value.map((item) => [item.id, item]));

      const removed = library.value.filter((item) => !freshIds.has(item.id));
      const gainedNewItem = fresh.some((item) => !previousById.has(item.id));
      if (removed.length === 0 && !gainedNewItem) return;

      library.value = fresh.map((item) => previousById.get(item.id) ?? item);
      if (removed.length > 0) forgetThumbnails(removed);
    } catch {
      // Background check — the manual refresh button is still there if the
      // camera round-trip actually needs retrying.
    } finally {
      syncingLibrary = false;
    }
  }

  return {
    status,
    info,
    library,
    host,
    error,
    loadingLibrary,
    isConnected,
    isBusy,
    available,
    connect,
    disconnect,
    refreshLibrary,
    syncLibrary,
    removeFromLibrary,
  };
}
