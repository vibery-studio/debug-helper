// ISOLATED world — relays postMessage from MAIN world to service worker
// and broadcasts recording state to MAIN world interceptors
(() => {
  // Robust duplicate guard: remove previous listener if it exists
  if (window.__debugHelperBridgeListener) {
    window.removeEventListener('message', window.__debugHelperBridgeListener);
  }

  let recording = false;

  function broadcastRecordingState(state) {
    recording = state;
    window.postMessage({
      source: 'debug-helper-control',
      type: 'recording-state',
      recording: state
    }, '*');
  }

  function onMessage(e) {
    if (e.source !== window) return;
    if (!e.data || e.data.source !== 'debug-helper-main') return;
    if (!recording) return; // Don't relay messages when not recording

    const msg = { ...e.data };
    delete msg.source;

    chrome.runtime.sendMessage(msg).catch(() => {
      // Service worker may not be ready
    });
  }

  window.__debugHelperBridgeListener = onMessage;
  window.addEventListener('message', onMessage);

  // Listen for recording start/stop from service worker
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'recording:start') {
      broadcastRecordingState(true);
    } else if (msg.type === 'recording:stop') {
      broadcastRecordingState(false);
    }
  });

  // Check current recording state on injection
  chrome.runtime.sendMessage({ type: 'session:get' }, (res) => {
    if (res && res.recording) {
      broadcastRecordingState(true);
    }
  });
})();
