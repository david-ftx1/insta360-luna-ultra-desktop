//! Live preview transport.
//!
//! Asks the camera to start a preview stream over the control session that
//! already exists, then re-serves the resulting elementary stream on an
//! ephemeral localhost port. The frontend consumes that with `fetch` and
//! decodes via WebCodecs, which keeps video-rate traffic off the Tauri IPC
//! bridge and avoids the `blob:` URL decoding limitation in WKWebView.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::luna::{
    wire_field_varint, LunaState, Session, CODE_SET_VIEW_MODE, CODE_START_LIVE_STREAM,
    CODE_STOP_LIVE_STREAM, CODE_UNKNOWN_17, CODE_UNKNOWN_85, VIEW_MODE_CAMERA, VIEW_MODE_FILE,
};
#[cfg(target_os = "macos")]
use crate::hevc_decode;
#[cfg(target_os = "macos")]
use tokio::sync::broadcast::Sender as BroadcastSender;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);

/// StartLiveStream body, byte-for-byte from a real capture of the genuine
/// iOS app (2026-10-16, iPhone mirrored over USB via `rvictl`/`rvi0`,
/// control channel on TCP 6666 to 192.168.42.1, decoded by hand against this
/// file's own UCD2/file-command framing). The previous guessed body (fields
/// 2/6/7/8/9/10, modelled on `insta360.messages.StartLiveStream`) made the
/// stream play but left the gimbal/lens parked; the capture showed no
/// separate gimbal/PTZ command anywhere in the session, so on this firmware
/// waking the gimbal appears to be a side effect of this exact body, not a
/// distinct command. Field numbers below are only the wire positions
/// observed in the capture, not confirmed proto names:
///   2 enableVideo=1, 4=48000, 7=43, 10=14, 12=1
/// Values are deliberately identical to that capture so that a failure here
/// means the camera disagrees, not that we guessed.
fn build_start_live_stream_body() -> Vec<u8> {
    let mut body = wire_field_varint(2, 1);
    body.extend(wire_field_varint(4, 48000));
    body.extend(wire_field_varint(7, 43));
    body.extend(wire_field_varint(10, 14));
    body.extend(wire_field_varint(12, 1));
    body
}

/// Body shared by `CODE_UNKNOWN_17` and `CODE_UNKNOWN_85`: wire field 1 = 1
/// (`08 01`), identical in every real capture. See the constants in `luna.rs`
/// for how these two were found.
fn tiny_flag_body() -> Vec<u8> {
    wire_field_varint(1, 1)
}

fn response_head() -> Vec<u8> {
    concat!(
        "HTTP/1.1 200 OK\r\n",
        "Content-Type: application/octet-stream\r\n",
        "Cache-Control: no-store\r\n",
        "Access-Control-Allow-Origin: *\r\n",
        "Connection: close\r\n\r\n"
    )
    .as_bytes()
    .to_vec()
}

/// Counters so a failed run explains itself instead of showing a blank canvas.
#[derive(Default)]
struct Stats {
    bytes: AtomicU64,
    frames: AtomicU64,
    first_bytes: StdMutex<Vec<u8>>,
    started: StdMutex<Option<Instant>>,
}

#[derive(Default)]
pub struct LiveViewState {
    inner: Mutex<Option<Running>>,
}

struct Running {
    port: u16,
    stats: Arc<Stats>,
    server: JoinHandle<()>,
    recorder: JoinHandle<()>,
    /// Native VideoToolbox decode pipeline (see `hevc_decode.rs`) — `/frames`
    /// clients subscribe to this directly. `None` means either a non-macOS
    /// target or a session that hasn't decoded anything yet; either way
    /// `/frames` just serves nothing and the frontend's existing WebCodecs/
    /// software-decode fallback stays in charge.
    #[cfg(target_os = "macos")]
    frames: BroadcastSender<Arc<hevc_decode::DecodedFrame>>,
}

impl Drop for Running {
    fn drop(&mut self) {
        self.server.abort();
        self.recorder.abort();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveViewInfo {
    pub url: String,
    pub port: u16,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LiveViewStats {
    pub bytes: u64,
    pub frames: u64,
    pub first_bytes_hex: String,
    pub seconds: f64,
}

/// Pack one decoded picture for `/frames`: a fixed 8-byte little-endian
/// header (`width`, `height`, each `u32`), immediately followed by
/// `width * height * 4` bytes of RGBA8 — already converted in
/// `hevc_decode.rs` (matching `app/utils/yuv.ts`'s fixed-point Rec.709
/// output exactly), so the frontend can hand this straight to a canvas with
/// no JS-side pixel math. That conversion used to happen here-ish (in JS,
/// after this endpoint shipped raw NV12 planes) and cost ~128ms per 720p
/// frame on the browser's main thread alone — the actual reason native
/// decode looked choppy even once it was producing frames correctly.
#[cfg(target_os = "macos")]
fn pack_frame(frame: &hevc_decode::DecodedFrame) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + frame.rgba.len());
    out.extend_from_slice(&frame.width.to_le_bytes());
    out.extend_from_slice(&frame.height.to_le_bytes());
    out.extend_from_slice(&frame.rgba);
    out
}

/// Serve the elementary stream, or (macOS only) natively-decoded frames on
/// `/frames`, to whichever client connects. Each connection gets its own
/// subscription, so a page reload simply picks up the live edge.
async fn serve(
    listener: TcpListener,
    session: Arc<Session>,
    #[cfg(target_os = "macos")] frames: BroadcastSender<Arc<hevc_decode::DecodedFrame>>,
) {
    loop {
        let Ok((mut socket, _)) = listener.accept().await else { break };
        let session = Arc::clone(&session);
        #[cfg(target_os = "macos")]
        let frames = frames.clone();
        tokio::spawn(async move {
            // Just enough of the request to read its path; real browser
            // requests for any route are well under this.
            let mut scratch = [0u8; 1024];
            let read = match socket.read(&mut scratch).await {
                Ok(n) => n,
                Err(_) => return,
            };
            let request_line = String::from_utf8_lossy(&scratch[..read]);
            let path = request_line
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1))
                .unwrap_or("/stream")
                .to_string();

            if path.starts_with("/frames") {
                #[cfg(target_os = "macos")]
                {
                    let mut receiver = frames.subscribe();
                    if socket.write_all(&response_head()).await.is_err() {
                        return;
                    }
                    loop {
                        match receiver.recv().await {
                            Ok(frame) => {
                                if socket.write_all(&pack_frame(&frame)).await.is_err() {
                                    break;
                                }
                            }
                            Err(RecvError::Lagged(_)) => continue,
                            Err(RecvError::Closed) => break,
                        }
                    }
                }
                #[cfg(not(target_os = "macos"))]
                {
                    let _ = socket
                        .write_all(b"HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n")
                        .await;
                }
                return;
            }

            let mut receiver = session.subscribe_stream();
            if socket.write_all(&response_head()).await.is_err() {
                return;
            }
            loop {
                match receiver.recv().await {
                    Ok(payload) => {
                        if socket.write_all(&payload).await.is_err() {
                            break;
                        }
                    }
                    // A slow client drops frames and keeps going
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => break,
                }
            }
        });
    }
}

#[tauri::command]
pub async fn luna_liveview_start(
    luna: State<'_, LunaState>,
    live: State<'_, LiveViewState>,
) -> Result<LiveViewInfo, String> {
    start_stream(luna, live, true).await
}

/// Restart the elementary stream alone — no CODE_SET_VIEW_MODE(CAMERA), no
/// CODE_UNKNOWN_17/85 telemetry. `luna_liveview_start` sends those because
/// it may be *entering* camera view for the first time; this assumes the
/// camera is already there (the only caller, `luna_liveview_pause`, never
/// left) and would otherwise be redundant.
///
/// Exists because CODE_SET_VIEW_MODE is what parks/wakes the gimbal (see the
/// module doc comment and `CODE_SET_VIEW_MODE`'s own doc comment in
/// `luna.rs`), not the stream commands themselves — confirmed by a user
/// report of the gimbal visibly parking and reopening around a resolution
/// change that paused and resumed the stream via the full start/stop pair.
/// A caller that only needs the stream out of the way for a moment (e.g. a
/// resolution write the camera refuses with a stream attached) gets that
/// without the gimbal move that was never the point.
#[tauri::command]
pub async fn luna_liveview_resume(
    luna: State<'_, LunaState>,
    live: State<'_, LiveViewState>,
) -> Result<LiveViewInfo, String> {
    start_stream(luna, live, false).await
}

async fn start_stream(
    luna: State<'_, LunaState>,
    live: State<'_, LiveViewState>,
    send_view_mode: bool,
) -> Result<LiveViewInfo, String> {
    let session = luna
        .session()
        .await
        .ok_or_else(|| "camera is not connected".to_string())?;

    let mut guard = live.inner.lock().await;
    if let Some(running) = guard.as_ref() {
        return Ok(LiveViewInfo {
            url: format!("http://127.0.0.1:{}/stream", running.port),
            port: running.port,
        });
    }

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("cannot open the local stream port: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("cannot read the local stream port: {e}"))?
        .port();

    let stats = Arc::new(Stats::default());
    *stats.started.lock().unwrap() = Some(Instant::now());

    // Count independently of whether a client is attached, so "the camera
    // sent nothing" and "the browser never connected" stay distinguishable.
    let recorder_stats = Arc::clone(&stats);
    let mut recorder_rx = session.subscribe_stream();
    let recorder = tokio::spawn(async move {
        loop {
            match recorder_rx.recv().await {
                Ok(payload) => {
                    recorder_stats.bytes.fetch_add(payload.len() as u64, Ordering::Relaxed);
                    recorder_stats.frames.fetch_add(1, Ordering::Relaxed);
                    let mut first = recorder_stats.first_bytes.lock().unwrap();
                    if first.is_empty() {
                        *first = payload.iter().copied().take(64).collect();
                    }
                }
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => break,
            }
        }
    });

    // Independent subscription, decoded in this process (not the WKWebView —
    // see hevc_decode.rs for why) and handed to /frames clients separately
    // from the raw /stream relay above. macOS only: VideoToolbox doesn't
    // exist anywhere else, and the WKWebView restriction this works around
    // is itself macOS-specific.
    #[cfg(target_os = "macos")]
    let frames_sender = hevc_decode::spawn(session.subscribe_stream());

    #[cfg(target_os = "macos")]
    let server = tokio::spawn(serve(listener, Arc::clone(&session), frames_sender.clone()));
    #[cfg(not(target_os = "macos"))]
    let server = tokio::spawn(serve(listener, Arc::clone(&session)));

    if send_view_mode {
        // CODE_UNKNOWN_17/85: constant-body commands the genuine app always
        // sends right before START_LIVE_STREAM on entering camera view,
        // never otherwise — likely just UI telemetry (their body never
        // changes), but sent for fidelity since the app always sends them
        // here too. Logged rather than fatal: not confirmed the camera
        // requires them.
        let flag_body = tiny_flag_body();
        if let Err(e) = session.send_command(CODE_UNKNOWN_17, &flag_body, COMMAND_TIMEOUT).await {
            log::warn!("CODE_UNKNOWN_17 (pre-live-view) failed: {e}");
        }
        for _ in 0..2 {
            if let Err(e) = session.send_command(CODE_UNKNOWN_85, &flag_body, COMMAND_TIMEOUT).await {
                log::warn!("CODE_UNKNOWN_85 (pre-live-view) failed: {e}");
            }
        }

        // CODE_SET_VIEW_MODE(CAMERA): unlike 17/85 above, this one's body
        // value *is* the state transition (file view = 1, camera view = 5),
        // confirmed across two independent real captures. The strongest
        // candidate yet for what actually tells the camera it's now in
        // camera view — fatal, since there is little point starting the
        // stream if the camera never agreed it's in that mode. It is also
        // what parks/wakes the gimbal, which is exactly why `send_view_mode`
        // exists: `luna_liveview_resume` skips this because the camera never
        // left camera view in the first place.
        session
            .send_command(CODE_SET_VIEW_MODE, &wire_field_varint(1, VIEW_MODE_CAMERA), COMMAND_TIMEOUT)
            .await
            .map_err(|e| format!("camera rejected CODE_SET_VIEW_MODE(camera): {e}"))?;
    }

    session
        .send_command(CODE_START_LIVE_STREAM, &build_start_live_stream_body(), COMMAND_TIMEOUT)
        .await
        .map_err(|e| format!("camera rejected START_LIVE_STREAM: {e}"))?;

    #[cfg(target_os = "macos")]
    {
        *guard = Some(Running { port, stats, server, recorder, frames: frames_sender });
    }
    #[cfg(not(target_os = "macos"))]
    {
        *guard = Some(Running { port, stats, server, recorder });
    }
    Ok(LiveViewInfo { url: format!("http://127.0.0.1:{port}/stream"), port })
}

#[tauri::command]
pub async fn luna_liveview_stop(
    luna: State<'_, LunaState>,
    live: State<'_, LiveViewState>,
) -> Result<(), String> {
    stop_stream(luna, live, true).await
}

/// Stop the elementary stream alone — no CODE_SET_VIEW_MODE(FILE). The other
/// half of `luna_liveview_resume`: the camera is told to leave the stream,
/// never told it left camera view, so the gimbal has no reason to park. See
/// `luna_liveview_resume`'s doc comment for the full story.
#[tauri::command]
pub async fn luna_liveview_pause(
    luna: State<'_, LunaState>,
    live: State<'_, LiveViewState>,
) -> Result<(), String> {
    stop_stream(luna, live, false).await
}

async fn stop_stream(
    luna: State<'_, LunaState>,
    live: State<'_, LiveViewState>,
    send_view_mode: bool,
) -> Result<(), String> {
    // Drop the server first so the socket closes even if the camera is gone
    live.inner.lock().await.take();
    if let Some(session) = luna.session().await {
        let _ = session.send_command(CODE_STOP_LIVE_STREAM, &[], COMMAND_TIMEOUT).await;
        if send_view_mode {
            // CODE_SET_VIEW_MODE(FILE): the real app sends this right after
            // STOP_LIVE_STREAM in every real capture — the other half of the
            // transition CODE_SET_VIEW_MODE(CAMERA) opens in start_stream.
            // Best-effort: the stream is already torn down either way.
            let _ = session
                .send_command(
                    CODE_SET_VIEW_MODE,
                    &wire_field_varint(1, VIEW_MODE_FILE),
                    COMMAND_TIMEOUT,
                )
                .await;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn luna_liveview_stats(live: State<'_, LiveViewState>) -> Result<LiveViewStats, String> {
    let guard = live.inner.lock().await;
    let Some(running) = guard.as_ref() else { return Ok(LiveViewStats::default()) };
    let first = running.stats.first_bytes.lock().unwrap().clone();
    let seconds = running
        .stats
        .started
        .lock()
        .unwrap()
        .map(|at| at.elapsed().as_secs_f64())
        .unwrap_or_default();
    Ok(LiveViewStats {
        bytes: running.stats.bytes.load(Ordering::Relaxed),
        frames: running.stats.frames.load(Ordering::Relaxed),
        first_bytes_hex: first.iter().map(|b| format!("{b:02x}")).collect(),
        seconds,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The body must match the 2026-10-16 iPhone/rvictl capture byte for
    /// byte: field2=1, field4=48000, field7=43, field10=14, field12=1.
    #[test]
    fn start_live_stream_body_matches_known_capture() {
        let expected: Vec<u8> = vec![
            0x10, 0x01, 0x20, 0x80, 0xf7, 0x02, 0x38, 0x2b, 0x50, 0x0e, 0x60, 0x01,
        ];
        assert_eq!(build_start_live_stream_body(), expected);
    }

    /// Shared body for CODE_UNKNOWN_17/85: wire field 1 = 1, i.e. `08 01`,
    /// matching every real capture.
    #[test]
    fn tiny_flag_body_matches_known_capture() {
        assert_eq!(tiny_flag_body(), vec![0x08, 0x01]);
    }

    /// CODE_SET_VIEW_MODE's two observed values, byte for byte from both real
    /// captures: `08 05` entering camera view, `08 01` back to file view.
    #[test]
    fn view_mode_bodies_match_known_capture() {
        assert_eq!(wire_field_varint(1, VIEW_MODE_CAMERA), vec![0x08, 0x05]);
        assert_eq!(wire_field_varint(1, VIEW_MODE_FILE), vec![0x08, 0x01]);
    }

    #[test]
    fn http_response_head_declares_a_streaming_body() {
        let head = String::from_utf8(response_head()).unwrap();
        assert!(head.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(head.contains("Content-Type: application/octet-stream"));
        assert!(head.contains("Access-Control-Allow-Origin: *"));
        assert!(head.ends_with("\r\n\r\n"));
    }
}
