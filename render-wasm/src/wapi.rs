#[macro_export]
macro_rules! request_animation_frame {
    () => {{
        #[cfg(target_arch = "wasm32")]
        unsafe extern "C" {
            pub fn wapi_requestAnimationFrame() -> i32;
        }

        #[cfg(target_arch = "wasm32")]
        let result = unsafe { wapi_requestAnimationFrame() };
        #[cfg(not(target_arch = "wasm32"))]
        let result = 0;

        result
    }};
}

#[macro_export]
macro_rules! cancel_animation_frame {
    ($frame_id:expr) => {
        #[cfg(target_arch = "wasm32")]
        unsafe extern "C" {
            pub fn wapi_cancelAnimationFrame(frame_id: i32);
        }

        {
            let frame_id = $frame_id;
            #[cfg(target_arch = "wasm32")]
            unsafe {
                wapi_cancelAnimationFrame(frame_id)
            };
            #[cfg(not(target_arch = "wasm32"))]
            let _ = frame_id;
        }
    };
}

/// Fire-and-forget POST of a UTF-8 JSON payload to the local debug
/// server (see `~/.claude/skills/debug-mode/start.sh`). Pairs with the
/// `perf-trace` feature — streams per-frame summaries + marker events
/// to the agent's POST sink without going through `dump_perf_snapshot`'s
/// pull cycle. Endpoint hardcoded in `src/js/wapi.js`.
#[macro_export]
macro_rules! wapi_post_log {
    ($json:expr) => {{
        #[cfg(target_arch = "wasm32")]
        unsafe extern "C" {
            pub fn wapi_post_log(json_ptr: *const u8, json_len: u32);
        }
        let s: String = $json;
        #[cfg(target_arch = "wasm32")]
        unsafe {
            wapi_post_log(s.as_ptr(), s.len() as u32)
        };
        #[cfg(not(target_arch = "wasm32"))]
        let _ = s;
    }};
}

pub use cancel_animation_frame;
pub use request_animation_frame;
pub use wapi_post_log;
