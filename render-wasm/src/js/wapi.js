addToLibrary({
  wapi_requestAnimationFrame: function wapi_requestAnimationFrame() {
    if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
      setTimeout(Module._process_animation_frame);
    } else {
      return window.requestAnimationFrame(Module._process_animation_frame);
    }
  },
  wapi_cancelAnimationFrame: function wapi_cancelAnimationFrame(frameId) {
    if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
      clearTimeout(frameId);
    } else {
      return window.cancelAnimationFrame(frameId);
    }
  },
  wapi_notifyTilesRenderComplete: function wapi_notifyTilesRenderComplete() {
    // The corresponding listener lives on `document` (main thread), so in a
    // worker context we simply skip the dispatch instead of crashing.
    if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
      return;
    }
    document.dispatchEvent(new CustomEvent('penpot:wasm:tiles-complete'));
  },
  // Fire-and-forget POST to the debug-mode log sink. Used by the
  // `wapi_post_log!` macro on the Rust side. Endpoint hardcoded;
  // change per session if the debug-mode `start.sh` rolls a new port.
  wapi_post_log: function wapi_post_log(json_ptr, json_len) {
    try {
      var s = UTF8ToString(json_ptr, json_len);
      // Lazy fetch — defer to next microtask so the wasm thread is
      // never blocked on network. `keepalive` lets the POST survive
      // a page unload mid-flight. Errors swallowed — agent reads via
      // GET /events; missing messages just mean the buffer underran.
      Promise.resolve().then(function () {
        fetch('http://127.0.0.1:60408/event', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: s,
          keepalive: true,
          mode: 'cors',
        }).catch(function () {});
      });
    } catch (e) {}
  }
});
