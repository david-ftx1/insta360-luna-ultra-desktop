//! Native video-thumbnail extraction via AVFoundation.
//!
//! `VideoThumb.vue` (the gallery grid's video tile) decodes a frame by
//! mounting a real `<video>` element on the camera's HTTP URL and seeking it
//! — the one approach that actually plays in this app's WKWebView
//! (`<video src="blob:...">` fails to decode at all there, verified
//! on-device). That works for *display*, but an earlier attempt to also
//! cache the result by reading the decoded pixels back out through a
//! `<canvas>` hit a second, separate WebKit restriction: `drawImage()`
//! throws a `SecurityError` for a cross-origin `<video>` with no CORS
//! headers ("tainted canvas") — the camera never sends
//! `Access-Control-Allow-Origin`, so every attempt failed before producing a
//! single pixel. Both restrictions are specific to the webview's media/
//! canvas stack, not to the camera or the file itself.
//!
//! This module decodes the exact same file with AVFoundation, running
//! natively in this process rather than inside WKWebView, which has neither
//! restriction: nothing here is a web page, so there is no canvas to taint
//! and no WebCodecs/blob: media-stack restriction to hit. `AVURLAsset` is
//! handed the camera's plain-HTTP URL directly — AVFoundation does its own
//! networking (range requests included), so there is no need to download
//! the file ourselves first — and App Transport Security already allows
//! this: `Info.plist`'s `NSAllowsLocalNetworking` is an app-wide exception
//! for the URL loading system (not WKWebView-specific), so it covers
//! AVFoundation's own network loads too.
//!
//! Returns one small JPEG per call. The frontend treats the result exactly
//! like a photo byte fetch (see `CameraImage.vue`) and runs it through the
//! same session media cache, which is what makes scrolling a video tile
//! away and back free: the cache is keyed by URL regardless of what
//! produced the bytes, and nothing on the frontend ever touches a `<video>`
//! or `<canvas>` for a cache hit.
//!
//! macOS only, same reasoning and enforcement style as `hevc_decode.rs`:
//! the Tauri command itself is registered on every platform (so
//! `generate_handler!` never needs a `cfg` inside its list), but its body
//! is split so only macOS does any real work; every other target gets a
//! clear error instead of a missing command.

// `copyCGImageAtTime:actualTime:error:` is deprecated in favour of the async
// `generateCGImageAsynchronouslyForTime:completionHandler:` — still correct
// and supported, just older API; matches `hevc_decode.rs`'s own
// `#![allow(deprecated)]` for the same reason (an older VideoToolbox call).
#[cfg(target_os = "macos")]
#[allow(deprecated)]
mod mac {
    use objc2_av_foundation::{AVAssetImageGenerator, AVURLAsset};
    use objc2_core_foundation::{CFMutableData, CFString, CGSize};
    use objc2_core_graphics::CGImage;
    use objc2_core_media::CMTime;
    use objc2_foundation::{NSString, NSURL};
    use objc2_image_io::{
        CGImageDestinationAddImage, CGImageDestinationCreateWithData, CGImageDestinationFinalize,
    };

    /// Grid tiles are small squares; no point decoding and shipping a
    /// multi-megapixel frame over IPC for one. `AVAssetImageGenerator`
    /// downscales internally when asked (`maximumSize`), so this also keeps
    /// the decode itself cheap, not just the JPEG encode and the IPC payload.
    const MAX_DIMENSION: f64 = 480.0;

    /// Seek a hair off zero — mirrors `VideoThumb.vue`'s own reasoning (and,
    /// before it, the software-decode path's): the very first frame of an
    /// Insta360 clip is often black.
    fn first_frame_time() -> CMTime {
        // `CMTime::new` is itself an `unsafe fn` in this crate version (plain
        // arithmetic, nothing that can actually fail — the `unsafe` is just
        // this binding's blanket convention for every CoreMedia/AVFoundation
        // call, same as every other call in this file).
        unsafe { CMTime::new(1, 10) } // 0.1s
    }

    /// Try each URL in order (the caller passes the LRV proxy first, then
    /// the full file, same fallback order `VideoThumb.vue` already used),
    /// returning the first frame that decodes.
    pub async fn extract_thumbnail(urls: Vec<String>) -> Result<Vec<u8>, String> {
        tokio::task::spawn_blocking(move || extract_blocking(&urls))
            .await
            .map_err(|e| format!("thumbnail task panicked: {e}"))?
    }

    fn extract_blocking(urls: &[String]) -> Result<Vec<u8>, String> {
        let mut last_error = "no source URL given".to_string();
        for url in urls {
            match extract_one(url) {
                Ok(bytes) => return Ok(bytes),
                Err(message) => last_error = message,
            }
        }
        Err(last_error)
    }

    /// Decode one frame near the start of `url` and return it as JPEG bytes.
    /// Blocking: `AVAssetImageGenerator`'s synchronous frame generator does
    /// its own network I/O internally, which is exactly why
    /// `extract_thumbnail` runs this on a blocking thread rather than the
    /// async executor.
    fn extract_one(url: &str) -> Result<Vec<u8>, String> {
        unsafe {
            let url_string = NSString::from_str(url);
            let ns_url = NSURL::URLWithString(&url_string).ok_or_else(|| "invalid URL".to_string())?;
            let asset = AVURLAsset::URLAssetWithURL_options(&ns_url, None);
            let generator = AVAssetImageGenerator::assetImageGeneratorWithAsset(&asset);
            generator.setAppliesPreferredTrackTransform(true);
            generator.setMaximumSize(CGSize { width: MAX_DIMENSION, height: MAX_DIMENSION });

            // `actualTime` is a plain `CMTime *` out-parameter (not an object
            // pointer, so objc2 keeps it as a raw pointer rather than an
            // `Option`) — null is documented as valid when the caller doesn't
            // need the actual presentation time back, only the image.
            let image = generator
                .copyCGImageAtTime_actualTime_error(first_frame_time(), std::ptr::null_mut())
                .map_err(|error| format!("frame decode failed: {error}"))?;

            encode_jpeg(&image)
        }
    }

    /// Encode a decoded frame to JPEG bytes via ImageIO. No compression-
    /// quality option is set — `maximumSize` above already bounds the
    /// payload to a thumbnail-sized image, which matters far more for size
    /// than quality tuning would.
    unsafe fn encode_jpeg(image: &CGImage) -> Result<Vec<u8>, String> {
        let data = CFMutableData::new(None, 0).ok_or_else(|| "cannot allocate JPEG buffer".to_string())?;
        // "public.jpeg" is the stable, well-known UTI for JPEG
        // (`UTType.jpeg.identifier` in modern Swift; `kUTTypeJPEG`'s value
        // before it was deprecated) — written as a literal so this doesn't
        // need the separate UniformTypeIdentifiers framework bindings just
        // for one constant string.
        let jpeg_type = CFString::from_str("public.jpeg");

        let destination = CGImageDestinationCreateWithData(&data, &jpeg_type, 1, None)
            .ok_or_else(|| "cannot create JPEG encoder".to_string())?;
        CGImageDestinationAddImage(&destination, image, None);
        if !CGImageDestinationFinalize(&destination) {
            return Err("JPEG encode failed".to_string());
        }

        Ok(cf_data_to_vec(&data))
    }

    /// Copy a `CFData`'s bytes into an owned `Vec<u8>`, via the safe
    /// `byte_ptr`/`len` accessors `CFMutableData` exposes for its `CFData`
    /// half (mutability is additive, not a different ABI shape) — unlike
    /// `hevc_decode.rs`'s CoreMedia calls, objc2-core-foundation doesn't
    /// expose `CFDataGetBytePtr`/`CFDataGetLength` as free functions, only
    /// as these methods.
    unsafe fn cf_data_to_vec(data: &CFMutableData) -> Vec<u8> {
        let len = data.len();
        let ptr = data.byte_ptr();
        if ptr.is_null() || len == 0 {
            return Vec::new();
        }
        std::slice::from_raw_parts(ptr, len).to_vec()
    }
}

/// Decode a frame near the start of the first URL in `urls` that works
/// (callers pass the cheaper LRV proxy before the full file) and return it
/// as JPEG bytes. See the module doc comment for why this exists at all.
#[tauri::command]
pub async fn luna_video_thumbnail(urls: Vec<String>) -> Result<Vec<u8>, String> {
    #[cfg(target_os = "macos")]
    {
        mac::extract_thumbnail(urls).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = urls;
        Err("video thumbnails are only available on macOS".to_string())
    }
}
