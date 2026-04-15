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

  function extractBody(body) {
    if (!body) return null;
    try {
      if (typeof body === 'string') return body.slice(0, MAX_BODY);
      if (body instanceof URLSearchParams) return body.toString().slice(0, MAX_BODY);
      if (body instanceof FormData || body instanceof Blob || body instanceof ReadableStream || body instanceof ArrayBuffer) return null;
      return JSON.stringify(body).slice(0, MAX_BODY);
    } catch { return null; }
  }

  window.fetch = async function (input, init) {
    const isRequest = input instanceof Request;
    const method = (init?.method || (isRequest ? input.method : 'GET')).toUpperCase();
    const url = typeof input === 'string' ? input : input.url;
    const start = Date.now();

    // Capture request body for mutating methods
    let requestBody = null;
    if (/^(POST|PUT|PATCH|DELETE)$/.test(method)) {
      requestBody = extractBody(init?.body) || (isRequest ? extractBody(input.body) : null);
    }

    try {
      const response = await origFetch.call(this, input, init);
      const duration = Date.now() - start;
      const entry = { timestamp: start, method, url, status: response.status, duration };

      if (requestBody) entry.requestBody = requestBody;

      // Always capture response body
      try {
        const clone = response.clone();
        const text = await clone.text();
        if (text.length > 0) entry.responseBody = text.slice(0, MAX_BODY);
      } catch {}

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
    const method = (this.__dh_method || 'GET').toUpperCase();
    // Capture request body for mutating methods
    let requestBody = null;
    if (body && /^(POST|PUT|PATCH|DELETE)$/.test(method)) {
      try { requestBody = typeof body === 'string' ? body.slice(0, MAX_BODY) : JSON.stringify(body).slice(0, MAX_BODY); } catch {}
    }
    this.addEventListener('loadend', function () {
      const entry = {
        timestamp: start,
        method,
        url: this.__dh_url || '',
        status: this.status,
        duration: Date.now() - start
      };
      if (requestBody) entry.requestBody = requestBody;
      try { const rt = (this.responseText || ''); if (rt.length > 0) entry.responseBody = rt.slice(0, MAX_BODY); } catch {}
      post(entry);
    });
    return origSend.call(this, body);
  };
})();
