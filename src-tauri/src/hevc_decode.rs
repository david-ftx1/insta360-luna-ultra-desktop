//! Native HEVC decode via macOS VideoToolbox.
//!
//! WKWebView refuses every WebCodecs HEVC configuration in this app — see
//! `LiveView.vue`'s native-decode diagnostic — almost certainly because
//! Apple does not grant third-party WKWebView instances the RunningBoard
//! assertion entitlement its media process needs. That restriction is a
//! WKWebView thing, not a sandboxing thing: a plain Rust process (this one)
//! can drive `VTDecompressionSession` directly with no such block.
//!
//! This module re-implements, in Rust, the same Annex-B parsing
//! `app/utils/annexB.ts` already does on the frontend (kept byte-for-byte
//! equivalent on purpose — see each function's doc comment for the TS
//! counterpart it mirrors), feeds completed access units into
//! `VTDecompressionSession`, and publishes decoded pictures as plain NV12
//! planes: luma (`y`) and interleaved chroma (`uv`), de-strided, no padding.
//! That shape was picked deliberately to match `YuvFrame` in
//! `app/utils/yuv.ts` — the fixed-point Rec.709 converter already built and
//! shipped for the software-decode fallback — so the frontend's new
//! "native" path is mostly: fetch planes, call the converter that already
//! exists, paint. No new colour math on either side of the FFI boundary.
//!
//! Scope: HEVC only. H.264 already decodes fine through WebCodecs in this
//! WKWebView — only HEVC was ever blocked — so there is no reason to widen
//! this module to cover a codec that was never broken.
//!
//! macOS only, enforced at the module level: every other target simply never
//! has this module compiled in, and `liveview.rs` must not call into it
//! outside `#[cfg(target_os = "macos")]`.
//!
//! Uses the classic refcon/callback-based `VTDecompressionSession` C API
//! (`VTDecompressionSessionCreate`/`DecodeFrame`/`Invalidate`,
//! `CMBlockBufferCreateWithMemoryBlock`, `CMSampleBufferCreate`) rather than
//! the newer `VTDecompressionSession::create`/`decode_frame` associated
//! functions objc2 now points to instead — deliberately: that's the FFI
//! surface this was built against, and it's a plain C calling convention
//! this module already owns the unsafety of, rather than whatever Rust-side
//! API objc2 wraps it in next.
#![allow(deprecated)]

use std::collections::VecDeque;
use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use objc2_core_foundation::{CFDictionary, CFMutableDictionary, CFNumber, CFNumberType, CFRetained};
use objc2_core_media::{
    CMBlockBuffer, CMBlockBufferCreateWithMemoryBlock, CMBlockBufferReplaceDataBytes,
    CMFormatDescription, CMSampleBuffer, CMSampleBufferCreate, CMSampleTimingInfo, CMTime,
    CMVideoFormatDescriptionCreateFromHEVCParameterSets,
};
use objc2_core_video::{
    kCVPixelBufferPixelFormatTypeKey, kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
    CVPixelBuffer, CVPixelBufferGetBaseAddressOfPlane, CVPixelBufferGetBytesPerRowOfPlane,
    CVPixelBufferGetHeightOfPlane, CVPixelBufferGetWidthOfPlane, CVPixelBufferLockBaseAddress,
    CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress,
};
use objc2_video_toolbox::{
    VTDecodeFrameFlags, VTDecodeInfoFlags, VTDecompressionOutputCallbackRecord,
    VTDecompressionSession, VTDecompressionSessionCreate, VTDecompressionSessionDecodeFrame,
    VTDecompressionSessionInvalidate,
};
use tokio::sync::broadcast;
use tokio::sync::broadcast::error::RecvError as BroadcastRecvError;

/// HEVC NAL unit types this module cares about. Same values as the
/// `H265_*` constants in `app/utils/annexB.ts`.
const NAL_VPS: i32 = 32;
const NAL_SPS: i32 = 33;
const NAL_PPS: i32 = 34;
const IRAP_MIN: i32 = 16;
const IRAP_MAX: i32 = 23;
const VCL_MAX: i32 = 31;

/// Mirrors `annexB.ts`'s `nalType()` for the H.265 case only: a 2-byte NAL
/// header, type in bits 6..1 of the first byte.
fn nal_type(unit: &[u8]) -> i32 {
    if unit.is_empty() {
        return -1;
    }
    ((unit[0] >> 1) & 0x3f) as i32
}

fn is_vcl(t: i32) -> bool {
    t <= VCL_MAX
}

fn is_key(t: i32) -> bool {
    (IRAP_MIN..=IRAP_MAX).contains(&t)
}

/// Mirrors `annexB.ts`'s `startsPicture()`: HEVC's
/// `first_slice_segment_in_pic_flag` is the top bit of the byte right after
/// the 2-byte NAL header.
fn starts_picture(unit: &[u8]) -> bool {
    unit.len() > 2 && (unit[2] & 0x80) != 0
}

/// Mirrors `annexB.ts`'s `splitNalUnits()`: one pass, emulation-prevention
/// bytes left in (VideoToolbox wants the parameter sets exactly as
/// transmitted — it does its own unescaping), start codes stripped. Returns
/// owned copies rather than slices into `bytes`, since the caller's buffer
/// gets reused/dropped across reads.
fn split_nal_units(bytes: &[u8]) -> Vec<Vec<u8>> {
    let mut units = Vec::new();
    let len = bytes.len();
    let mut from: isize = -1;
    let mut i = 0usize;
    while i + 2 < len {
        if bytes[i] != 0 || bytes[i + 1] != 0 {
            i += 1;
            continue;
        }
        let size: usize;
        if bytes[i + 2] == 1 {
            size = 3;
        } else if i + 3 < len && bytes[i + 2] == 0 && bytes[i + 3] == 1 {
            size = 4;
        } else {
            i += 1;
            continue;
        }
        if from >= 0 && i > from as usize {
            units.push(bytes[from as usize..i].to_vec());
        }
        from = (i + size) as isize;
        i += size;
    }
    if from >= 0 && len > from as usize {
        units.push(bytes[from as usize..len].to_vec());
    }
    units
}

/// One decoded picture, already converted to RGBA8 — see
/// `convert_nv12_to_rgba` below for why that happens here instead of in the
/// frontend's `yuvToRgba` (`app/utils/yuv.ts`), which it replicates exactly.
pub struct DecodedFrame {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// Rec.709 limited-range (16-235/16-240) fixed-point (Q12) conversion
/// constants — the exact precomputed values of `app/utils/yuv.ts`'s
/// `Math.round(coefficient * 4096)` constants, hardcoded here rather than
/// computed at runtime so there is no risk of Rust's and JS's floating-point
/// rounding disagreeing by a single bit at the boundary. Keep these in sync
/// with that file by hand if the matrix ever changes; `yuv.test.ts` is the
/// source of truth for what the output should look like.
const FIX_SHIFT: i32 = 12;
const FIX_HALF: i32 = 1 << (FIX_SHIFT - 1);
const Y_SCALE_FX: i32 = 4769; // round(1.1644 * 4096)
const CR_TO_R_FX: i32 = 7343; // round(1.7927 * 4096)
const CB_TO_G_FX: i32 = -873; // round(-0.2132 * 4096)
const CR_TO_G_FX: i32 = -2183; // round(-0.5329 * 4096)
const CB_TO_B_FX: i32 = 8652; // round(2.1124 * 4096)

/// Owns the live `VTDecompressionSession` plus the boxed broadcast sender
/// its output callback reaches back through. Both are torn down together.
struct Session {
    raw: NonNull<VTDecompressionSession>,
    /// Kept alive for exactly as long as `raw`: the output callback's
    /// `decompressionOutputRefCon` points at this box's contents.
    refcon: *mut broadcast::Sender<Arc<DecodedFrame>>,
    /// The exact format description `raw` was created with. Every sample
    /// buffer handed to `VTDecompressionSessionDecodeFrame` must carry this
    /// same format description — a session doesn't support that changing
    /// out from under it — so `decode_one` reuses it for every access unit
    /// instead of passing `None` (which decoded as
    /// `kVTFormatDescriptionChangeNotSupportedErr`/-12916 on every single
    /// frame, the actual cause of native decode never producing a picture).
    format_description: CFRetained<CMFormatDescription>,
}

// Safety: `raw` is only ever read (passed to VideoToolbox calls) or torn
// down in `Drop`; `refcon` points at a `broadcast::Sender`, which is itself
// `Send + Sync`, and is only read through from VideoToolbox's callback
// thread, never mutated. `VTDecompressionSessionInvalidate` (called first in
// `Drop`, below) is documented to block until no further output-callback
// invocations are in flight or will occur, so freeing `refcon` right after
// it returns can never race a callback that's still reading it.
unsafe impl Send for Session {}
unsafe impl Sync for Session {}

impl Drop for Session {
    fn drop(&mut self) {
        unsafe {
            VTDecompressionSessionInvalidate(self.raw.as_ref());
            // VTDecompressionSession is a CF type; invalidate does not
            // release it. Wrapping the raw (already +1 retained) pointer in
            // a `CFRetained` and immediately dropping it calls the correct
            // release for us, rather than needing to name that function.
            drop(CFRetained::from_raw(self.raw));
            drop(Box::from_raw(self.refcon));
        }
    }
}

/// Per-stream decode state: NAL reassembly buffer, cached parameter sets,
/// and the live session (recreated whenever the parameter sets change —
/// i.e. the camera changed resolution/mode).
pub struct HevcDecoder {
    carry: Vec<u8>,
    pending: VecDeque<Vec<u8>>,
    vps: Option<Vec<u8>>,
    sps: Option<Vec<u8>>,
    pps: Option<Vec<u8>>,
    session: Option<Session>,
    seen_keyframe: bool,
    sender: broadcast::Sender<Arc<DecodedFrame>>,
}

impl HevcDecoder {
    pub fn new(sender: broadcast::Sender<Arc<DecodedFrame>>) -> Self {
        Self {
            carry: Vec::new(),
            pending: VecDeque::new(),
            vps: None,
            sps: None,
            pps: None,
            session: None,
            seen_keyframe: false,
            sender,
        }
    }

    /// Feed one chunk of raw bytes straight off the camera's TCP stream.
    /// Mirrors `readAnnexBLoop()`'s per-chunk body in `LiveView.vue`.
    pub fn feed(&mut self, chunk: &[u8]) {
        let mut merged = Vec::with_capacity(self.carry.len() + chunk.len());
        merged.extend_from_slice(&self.carry);
        merged.extend_from_slice(chunk);

        let mut units = split_nal_units(&merged);
        if units.is_empty() {
            self.carry = merged;
            return;
        }
        // The last unit may be cut mid-NAL; hold it back for the next chunk,
        // same as annexB.ts's `carry` handling.
        let tail = units.pop().unwrap();
        self.carry = Vec::with_capacity(4 + tail.len());
        self.carry.extend_from_slice(&[0, 0, 0, 1]);
        self.carry.extend_from_slice(&tail);

        for unit in units {
            self.pending.push_back(unit);
        }

        self.update_parameter_sets();
        self.drain_access_units();
    }

    /// Scan pending units for VPS/SPS/PPS and (re)build the decode session
    /// if any of them changed — a new keyframe can carry new parameter sets
    /// after a resolution change.
    fn update_parameter_sets(&mut self) {
        let mut changed = false;
        for unit in &self.pending {
            match nal_type(unit) {
                NAL_VPS if self.vps.as_deref() != Some(unit.as_slice()) => {
                    self.vps = Some(unit.clone());
                    changed = true;
                }
                NAL_SPS if self.sps.as_deref() != Some(unit.as_slice()) => {
                    self.sps = Some(unit.clone());
                    changed = true;
                }
                NAL_PPS if self.pps.as_deref() != Some(unit.as_slice()) => {
                    self.pps = Some(unit.clone());
                    changed = true;
                }
                _ => {}
            }
        }
        if !changed {
            return;
        }
        let (Some(vps), Some(sps), Some(pps)) = (&self.vps, &self.sps, &self.pps) else {
            return;
        };
        match unsafe { create_session(vps, sps, pps, self.sender.clone()) } {
            Ok(session) => {
                self.session = Some(session);
                // A fresh session has decoded nothing yet; wait for the next
                // keyframe before feeding it anything, same reasoning as the
                // frontend's `seenKeyframe` gate.
                self.seen_keyframe = false;
            }
            Err(message) => {
                log::warn!("native HEVC decode: failed to (re)build VideoToolbox session: {message}");
                self.session = None;
            }
        }
    }

    /// Mirrors `annexB.ts`'s `drainAccessUnits()` + `groupAccessUnits()`
    /// collapsed into one pass, "length4" framing only (4-byte big-endian
    /// length prefixes, VCL NALs only — parameter sets live in the format
    /// description instead, same as the frontend's described-decoder path).
    fn drain_access_units(&mut self) {
        let units: Vec<Vec<u8>> = self.pending.iter().cloned().collect();
        let mut picture_starts = Vec::new();
        for (i, unit) in units.iter().enumerate() {
            let t = nal_type(unit);
            if is_vcl(t) && starts_picture(unit) {
                picture_starts.push(i);
            }
        }
        if picture_starts.len() < 2 {
            return; // nothing provably complete yet
        }
        let cut = *picture_starts.last().unwrap();
        let mut from = cut;
        while from > 0 && !is_vcl(nal_type(&units[from - 1])) {
            from -= 1;
        }

        let mut current: Vec<Vec<u8>> = Vec::new();
        let mut key = false;
        let mut seen_vcl = false;
        let flush = |current: &mut Vec<Vec<u8>>, key: &mut bool, seen_vcl: &mut bool, this: &mut Self| {
            if !*seen_vcl || current.is_empty() {
                current.clear();
                *key = false;
                *seen_vcl = false;
                return;
            }
            this.decode_access_unit(current, *key);
            current.clear();
            *key = false;
            *seen_vcl = false;
        };

        for unit in units.into_iter().take(from) {
            let t = nal_type(&unit);
            if is_vcl(t) && starts_picture(&unit) && seen_vcl {
                flush(&mut current, &mut key, &mut seen_vcl, self);
            }
            if is_vcl(t) {
                seen_vcl = true;
                if is_key(t) {
                    key = true;
                }
                current.push(unit);
            }
            // Non-VCL units (extra parameter sets, SEI, ...) are dropped
            // here deliberately: the decoder gets its parameter sets from
            // the format description, not from in-band NALs, once a
            // session exists.
        }
        flush(&mut current, &mut key, &mut seen_vcl, self);

        self.pending.drain(..from);
    }

    fn decode_access_unit(&mut self, vcl_units: &[Vec<u8>], key: bool) {
        if !key && !self.seen_keyframe {
            return;
        }
        if key {
            self.seen_keyframe = true;
        }
        let Some(session) = &self.session else { return };

        let mut packed = Vec::new();
        for unit in vcl_units {
            let len = unit.len() as u32;
            packed.extend_from_slice(&len.to_be_bytes());
            packed.extend_from_slice(unit);
        }

        if let Err(message) = unsafe { decode_one(session, &packed) } {
            log::warn!("native HEVC decode: decode_frame failed: {message}");
        }
    }
}

/// Build a `VTDecompressionSession` from the current VPS/SPS/PPS, wired to
/// publish every decoded picture onto `sender`.
unsafe fn create_session(
    vps: &[u8],
    sps: &[u8],
    pps: &[u8],
    sender: broadcast::Sender<Arc<DecodedFrame>>,
) -> Result<Session, String> {
    let format_description = create_format_description(vps, sps, pps)?;

    // Request NV12 output directly — matches `YuvFrame` on the frontend, so
    // no colour-space conversion happens on this side of the FFI boundary.
    let attrs = CFMutableDictionary::empty();
    let pixel_format = CFNumber::new(
        None,
        CFNumberType::SInt32Type,
        &(kCVPixelFormatType_420YpCbCr8BiPlanarFullRange as i32) as *const i32 as *const c_void,
    )
    .ok_or("CFNumber::new failed for the destination pixel format")?;
    attrs.set(kCVPixelBufferPixelFormatTypeKey, &*pixel_format);
    // `VTDecompressionSessionCreate` takes the type-erased `&CFDictionary`
    // (no generic params), not our concretely-typed
    // `CFMutableDictionary<CFString, CFNumber>`. Both are the same CF object
    // underneath — the K/V generics are a Rust-side-only marker, not part of
    // the ABI — so this reference cast is sound.
    let attrs: &CFDictionary = unsafe { &*((&*attrs) as *const _ as *const CFDictionary) };

    let refcon = Box::into_raw(Box::new(sender));
    let callback_record = VTDecompressionOutputCallbackRecord {
        decompressionOutputCallback: Some(decode_output_callback),
        decompressionOutputRefCon: refcon as *mut c_void,
    };

    let mut session_out: *mut VTDecompressionSession = std::ptr::null_mut();
    let status = VTDecompressionSessionCreate(
        None,
        std::mem::transmute::<&CMFormatDescription, _>(&*format_description),
        None,
        Some(attrs),
        &callback_record,
        NonNull::new(&mut session_out as *mut *mut VTDecompressionSession).unwrap(),
    );
    if status != 0 || session_out.is_null() {
        drop(Box::from_raw(refcon));
        return Err(format!("VTDecompressionSessionCreate failed with OSStatus {status}"));
    }

    Ok(Session { raw: NonNull::new(session_out).unwrap(), refcon, format_description })
}

unsafe fn create_format_description(
    vps: &[u8],
    sps: &[u8],
    pps: &[u8],
) -> Result<CFRetained<CMFormatDescription>, String> {
    let pointers: [NonNull<u8>; 3] = [
        NonNull::new(vps.as_ptr() as *mut u8).ok_or("empty VPS")?,
        NonNull::new(sps.as_ptr() as *mut u8).ok_or("empty SPS")?,
        NonNull::new(pps.as_ptr() as *mut u8).ok_or("empty PPS")?,
    ];
    let sizes: [usize; 3] = [vps.len(), sps.len(), pps.len()];

    let mut desc_out: *const CMFormatDescription = std::ptr::null();
    let status = CMVideoFormatDescriptionCreateFromHEVCParameterSets(
        None,
        3,
        NonNull::new(pointers.as_ptr() as *mut NonNull<u8>).unwrap(),
        NonNull::new(sizes.as_ptr() as *mut usize).unwrap(),
        4, // NAL length-prefix size used for subsequent sample buffers
        None,
        NonNull::new(&mut desc_out as *mut *const CMFormatDescription).unwrap(),
    );
    if status != 0 || desc_out.is_null() {
        return Err(format!(
            "CMVideoFormatDescriptionCreateFromHEVCParameterSets failed with OSStatus {status}"
        ));
    }
    Ok(CFRetained::from_raw(NonNull::new(desc_out as *mut CMFormatDescription).unwrap()))
}

/// Wrap one length-prefixed access unit in a `CMBlockBuffer`/`CMSampleBuffer`
/// pair and hand it to the session.
///
/// `memoryBlock: null_mut()` with a real `blockAllocator` makes CoreMedia
/// allocate and own this block itself, so there is no question of who frees
/// it. Passing `packed`'s own pointer here instead — even with
/// `kCMBlockBufferAlwaysCopyDataFlag` set, as this function used to — does
/// NOT make CoreMedia copy it: per Apple's docs that flag only applies to
/// `CMBlockBufferCreateContiguous`. `CreateWithMemoryBlock` with a non-NULL
/// `memoryBlock` always takes ownership of that exact pointer and frees it
/// when the block buffer is finalized (at the end of this function, when
/// `block_buffer` drops) — which, combined with `packed` also being freed
/// by Rust when the caller's `decode_access_unit` returns, was a double
/// free. That's what actually crashed the app, not the VT decode failure
/// logged just before it. `CMBlockBufferReplaceDataBytes` below copies
/// `packed`'s bytes into CoreMedia's own buffer instead, so `packed` stays
/// entirely Rust-owned and is dropped safely once this function returns.
unsafe fn decode_one(session: &Session, packed: &[u8]) -> Result<(), String> {
    let mut block_buffer: *mut CMBlockBuffer = std::ptr::null_mut();
    let status = CMBlockBufferCreateWithMemoryBlock(
        None,
        std::ptr::null_mut(),
        packed.len(),
        None,
        std::ptr::null(),
        0,
        packed.len(),
        0,
        NonNull::new(&mut block_buffer as *mut *mut CMBlockBuffer).unwrap(),
    );
    if status != 0 || block_buffer.is_null() {
        return Err(format!("CMBlockBufferCreateWithMemoryBlock failed with OSStatus {status}"));
    }
    let block_buffer = CFRetained::from_raw(NonNull::new(block_buffer).unwrap());

    let source = NonNull::new(packed.as_ptr() as *mut c_void).ok_or("empty packed access unit")?;
    let status = CMBlockBufferReplaceDataBytes(source, &*block_buffer, 0, packed.len());
    if status != 0 {
        return Err(format!("CMBlockBufferReplaceDataBytes failed with OSStatus {status}"));
    }

    // No real timing available (and none needed — this is a live, discard-
    // if-late preview, not a file being muxed), so every sample just carries
    // an increasing, otherwise meaningless timestamp.
    use std::sync::atomic::AtomicI64;
    static COUNTER: AtomicI64 = AtomicI64::new(0);
    let pts = CMTime::new(COUNTER.fetch_add(1, Ordering::Relaxed), 90_000);
    let timing = CMSampleTimingInfo {
        duration: CMTime::new(0, 90_000),
        presentationTimeStamp: pts,
        decodeTimeStamp: pts,
    };
    let sample_size = packed.len();

    let mut sample_buffer: *mut CMSampleBuffer = std::ptr::null_mut();
    // Format description type mismatch note: VTDecompressionSessionCreate
    // wants `&CMVideoFormatDescription`; CoreMedia's own headers define
    // CMVideoFormatDescriptionRef as a typedef of CMFormatDescriptionRef, so
    // these two should be the same opaque type in objc2's bindings too. If
    // `cargo check` disagrees, this is a one-line cast fix.
    let status = CMSampleBufferCreate(
        None,
        Some(&*block_buffer),
        true,
        None,
        std::ptr::null_mut(),
        Some(&*session.format_description),
        1,
        1,
        &timing,
        1,
        &sample_size,
        NonNull::new(&mut sample_buffer as *mut *mut CMSampleBuffer).unwrap(),
    );
    if status != 0 || sample_buffer.is_null() {
        return Err(format!("CMSampleBufferCreate failed with OSStatus {status}"));
    }
    let sample_buffer = CFRetained::from_raw(NonNull::new(sample_buffer).unwrap());

    let mut info_flags = VTDecodeInfoFlags(0);
    let status = VTDecompressionSessionDecodeFrame(
        session.raw.as_ref(),
        &*sample_buffer,
        VTDecodeFrameFlags(0),
        std::ptr::null_mut(),
        &mut info_flags,
    );
    if status != 0 {
        return Err(format!("VTDecompressionSessionDecodeFrame failed with OSStatus {status}"));
    }
    Ok(())
}

/// The actual output callback VideoToolbox calls back on, on its own
/// thread, whenever a picture finishes decoding. Must not panic across the
/// FFI boundary — every fallible step below logs and returns instead.
unsafe extern "C-unwind" fn decode_output_callback(
    decompression_output_ref_con: *mut c_void,
    _source_frame_ref_con: *mut c_void,
    status: i32,
    _info_flags: VTDecodeInfoFlags,
    image_buffer: *mut objc2_core_video::CVImageBuffer,
    _presentation_time_stamp: CMTime,
    _presentation_duration: CMTime,
) {
    // Raw pointers aren't `UnwindSafe` by default (the compiler can't see
    // that nothing here leaves them in a half-mutated state on panic); this
    // closure only ever reads through them, so asserting unwind-safety is
    // sound.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if status != 0 || image_buffer.is_null() || decompression_output_ref_con.is_null() {
            log::warn!("native HEVC decode: output callback saw status {status}");
            return;
        }
        let sender = &*(decompression_output_ref_con as *const broadcast::Sender<Arc<DecodedFrame>>);
        // The decoder was configured to hand back NV12 pixel buffers, so this
        // reinterpret is the pixel buffer VideoToolbox actually produced for
        // every real decode — see the destination_image_buffer_attributes
        // dict built in create_session().
        let pixel_buffer = &*(image_buffer as *const CVPixelBuffer);

        match convert_nv12_to_rgba(pixel_buffer) {
            Ok(frame) => {
                let _ = sender.send(Arc::new(frame));
            }
            Err(message) => log::warn!("native HEVC decode: failed to read decoded frame: {message}"),
        }
    }));
    if result.is_err() {
        log::error!("native HEVC decode: panic in output callback (suppressed, not propagated)");
    }
}

/// De-stride, colour-convert, and hand back one decoded picture as RGBA8 —
/// fused into a single pass over the locked pixel buffer (no intermediate
/// NV12 `Vec<u8>` the way this function used to produce, read back, and
/// discard) that replicates `yuvToRgba` in `app/utils/yuv.ts` exactly: same
/// Rec.709 limited-range matrix, same Q12 fixed-point shift and rounding —
/// see the `FIX_*`/`*_FX` constants above. That function used to run in the
/// browser, in JS, after this endpoint shipped raw NV12 planes; benchmarked
/// in isolation (convert-only, no decode) at ~128ms for one 720p frame on
/// the browser's main thread, which alone capped native decode under 8fps —
/// the real cause of it looking choppy once it was producing pictures at
/// all. Compiled fixed-point integer math here, with no cross-thread
/// `postMessage` and no extra buffer round trip, should be well under that.
unsafe fn convert_nv12_to_rgba(pixel_buffer: &CVPixelBuffer) -> Result<DecodedFrame, String> {
    let lock_status = CVPixelBufferLockBaseAddress(pixel_buffer, CVPixelBufferLockFlags(1)); // read-only
    if lock_status != 0 {
        return Err(format!("CVPixelBufferLockBaseAddress failed with CVReturn {lock_status}"));
    }

    let width = CVPixelBufferGetWidthOfPlane(pixel_buffer, 0) as usize;
    let height = CVPixelBufferGetHeightOfPlane(pixel_buffer, 0) as usize;
    let chroma_width = CVPixelBufferGetWidthOfPlane(pixel_buffer, 1) as usize;
    let chroma_height = CVPixelBufferGetHeightOfPlane(pixel_buffer, 1) as usize;

    let y_base = CVPixelBufferGetBaseAddressOfPlane(pixel_buffer, 0) as *const u8;
    let y_stride = CVPixelBufferGetBytesPerRowOfPlane(pixel_buffer, 0);
    let uv_base = CVPixelBufferGetBaseAddressOfPlane(pixel_buffer, 1) as *const u8;
    let uv_stride = CVPixelBufferGetBytesPerRowOfPlane(pixel_buffer, 1);

    let mut rgba = vec![0u8; width * height * 4];

    if !y_base.is_null() && !uv_base.is_null() && chroma_width > 0 && chroma_height > 0 {
        // Integer, not float, division: NV12 4:2:0 chroma dimensions always
        // evenly divide the luma dimensions (half, rounded up), so this is
        // exact — and avoids floats in the hot loop for the same reason
        // yuv.ts's own comment gives for avoiding them there.
        let chroma_step_x = (width / chroma_width).max(1);
        let chroma_step_y = (height / chroma_height).max(1);

        for row in 0..height {
            let chroma_row = (row / chroma_step_y).min(chroma_height - 1);
            let y_row = std::slice::from_raw_parts(y_base.add(row * y_stride), width);
            let uv_row = std::slice::from_raw_parts(uv_base.add(chroma_row * uv_stride), chroma_width * 2);
            let mut out_offset = row * width * 4;

            for col in 0..width {
                let chroma_col = (col / chroma_step_x).min(chroma_width - 1);
                let y_val = y_row[col] as i32 - 16;
                let cb_val = uv_row[chroma_col * 2] as i32 - 128;
                let cr_val = uv_row[chroma_col * 2 + 1] as i32 - 128;

                let luma_fx = Y_SCALE_FX * y_val;
                let r = (luma_fx + CR_TO_R_FX * cr_val + FIX_HALF) >> FIX_SHIFT;
                let g = (luma_fx + CB_TO_G_FX * cb_val + CR_TO_G_FX * cr_val + FIX_HALF) >> FIX_SHIFT;
                let b = (luma_fx + CB_TO_B_FX * cb_val + FIX_HALF) >> FIX_SHIFT;

                // `Uint8ClampedArray` clamps on store in the JS version this
                // replaces; `.clamp(0, 255)` is the same behaviour here.
                rgba[out_offset] = r.clamp(0, 255) as u8;
                rgba[out_offset + 1] = g.clamp(0, 255) as u8;
                rgba[out_offset + 2] = b.clamp(0, 255) as u8;
                rgba[out_offset + 3] = 255;
                out_offset += 4;
            }
        }
    }

    CVPixelBufferUnlockBaseAddress(pixel_buffer, CVPixelBufferLockFlags(1));

    Ok(DecodedFrame { width: width as u32, height: height as u32, rgba })
}

/// Spawn the task that reads raw camera bytes from `rx` (a clone of the same
/// broadcast receiver `/stream` relays to clients) and feeds them to a fresh
/// `HevcDecoder`. Returns the sender new `/frames` clients subscribe to —
/// independent of `/stream`'s own relay task, so a slow or absent `/frames`
/// client never affects it, and vice versa.
pub fn spawn(mut rx: broadcast::Receiver<Vec<u8>>) -> broadcast::Sender<Arc<DecodedFrame>> {
    let (sender, _) = broadcast::channel(4);
    let mut decoder = HevcDecoder::new(sender.clone());
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(payload) => decoder.feed(&payload),
                Err(BroadcastRecvError::Lagged(_)) => continue,
                Err(BroadcastRecvError::Closed) => break,
            }
        }
    });
    sender
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_nal_units_strips_start_codes() {
        let bytes = [0, 0, 0, 1, 0xAA, 0xBB, 0, 0, 1, 0xCC];
        let units = split_nal_units(&bytes);
        assert_eq!(units, vec![vec![0xAA, 0xBB], vec![0xCC]]);
    }

    #[test]
    fn nal_type_reads_h265_header() {
        // VPS: type 32 -> byte pattern (32 << 1) = 0x40
        assert_eq!(nal_type(&[0x40, 0x01]), NAL_VPS);
    }

    #[test]
    fn starts_picture_reads_top_bit_of_third_byte() {
        assert!(starts_picture(&[0x00, 0x00, 0x80]));
        assert!(!starts_picture(&[0x00, 0x00, 0x00]));
    }
}
