// MAIN world — wraps fetch and XMLHttpRequest
;(() => {
  const PREFIX = '__debugHelper__';
  if (window[PREFIX + 'networkPatched']) return;
  window[PREFIX + 'networkPatched'] = true;

  let recording = false;

  // Listen for recording state changes from the bridge (ISOLATED world)
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.source === 'debug-helper-control' && e.data.type === 'recording-state') {
      recording = e.data.recording;
    }
  });

  const MAX_BODY = 10240;

  function post(data) {
    if (!recording) return;
    window.postMessage({
      source: 'debug-helper-main',
      type: 'event:network',
      ...data
    }, '*');
  }

  // Wrap fetch
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const method = (init?.method || 'GET').toUpperCase();
    const url = typeof input === 'string' ? input : input.url;
    const start = Date.now();

    try {
      const response = await origFetch.call(this, input, init);
      const duration = Date.now() - start;
      const entry = { timestamp: start, method, url, status: response.status, duration };

      if (response.status >= 400) {
        try {
          const clone = response.clone();
          const text = await clone.text();
          entry.responseBody = text.slice(0, MAX_BODY);
        } catch {}
      }
      post(entry);
      return response;
    } catch (err) {
      post({ timestamp: start, method, url, status: 0, duration: Date.now() - start, responseBody: err.message });
      throw err;
    }
  };

  // Wrap XMLHttpRequest
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__dh_method = method;
    this.__dh_url = url;
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const start = Date.now();
    this.addEventListener('loadend', function () {
      const entry = {
        timestamp: start,
        method: (this.__dh_method || 'GET').toUpperCase(),
        url: this.__dh_url || '',
        status: this.status,
        duration: Date.now() - start
      };
      if (this.status >= 400) {
        try { entry.responseBody = (this.responseText || '').slice(0, MAX_BODY); } catch {}
      }
      post(entry);
    });
    return origSend.call(this, body);
  };
})();
