// ISOLATED world — relays postMessage from MAIN world to service worker
(() => {
  if (window.__debugHelperBridge) return;
  window.__debugHelperBridge = true;
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (!e.data || e.data.source !== 'debug-helper-main') return;

    const msg = { ...e.data };
    delete msg.source;

    chrome.runtime.sendMessage(msg).catch(() => {
      // Service worker may not be ready
    });
  });
})();
