(() => {
  // Prevent duplicate injection — but allow re-inject after extension reload
  if (window.__debugHelperRecorder) {
    try { if (chrome.runtime?.id) return; } catch {}
  }
  window.__debugHelperRecorder = true;

  let recording = false;

  // --- Compact selector: max 3 parts (ancestor > ... > target) ---
  function compactSelector(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + CSS.escape(el.id);

    // Build full path up to nearest ID or body
    const path = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body) {
      let seg = cur.tagName.toLowerCase();
      if (cur.id) { seg = '#' + CSS.escape(cur.id); path.unshift(seg); break; }
      // One class max for brevity
      if (cur.className && typeof cur.className === 'string') {
        const cls = cur.className.trim().split(/\s+/)[0];
        if (cls) seg += '.' + CSS.escape(cls);
      }
      path.unshift(seg);
      cur = cur.parentElement;
    }

    if (path.length <= 3) return path.join(' > ');
    // 3-part: top > ... > target
    return path[0] + ' > … > ' + path[path.length - 1];
  }

  // --- Rich context for AI ---
  function elementContext(el) {
    if (!el || el.nodeType !== 1) return {};
    const ctx = {};

    // Visible text (innerText of the element itself, not deep children)
    const text = (el.innerText || el.textContent || '').trim();
    if (text && text.length <= 120) ctx.text = text;
    else if (text) ctx.text = text.slice(0, 117) + '...';

    // Aria / title
    const label = el.getAttribute('aria-label') || el.getAttribute('title') || '';
    if (label) ctx.ariaLabel = label.slice(0, 120);

    // Tag + key attributes
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') {
      const href = el.getAttribute('href') || '';
      ctx.tag = `a[href=${href.slice(0, 150)}]`;
    } else if (tag === 'button') {
      ctx.tag = el.type ? `button[type=${el.type}]` : 'button';
    } else if (tag === 'input') {
      ctx.tag = `input[type=${el.type || 'text'}]`;
    } else if (tag === 'img') {
      ctx.tag = 'img';
      ctx.imgAlt = el.alt || el.src?.split('/').pop()?.slice(0, 80) || '';
    } else if (['select', 'textarea', 'form', 'nav', 'header', 'footer', 'main', 'section'].includes(tag)) {
      ctx.tag = tag;
    }

    // Role if semantic
    const role = el.getAttribute('role');
    if (role) ctx.role = role;

    return ctx;
  }

  function sendEvent(eventType, detail) {
    if (!recording) return;
    try {
      chrome.runtime.sendMessage({
        type: 'event:dom',
        timestamp: Date.now(),
        eventType,
        selector: detail.selector || '',
        context: detail.context || undefined,
        url: location.href,
        scrollY: window.scrollY,
        value: detail.value || undefined
      }).catch(() => {});
    } catch {
      stopRecording();
    }
  }

  // Debounce helpers and dedup tracking
  let scrollTimer, inputTimers = new Map();

  // Track recent change/submit to suppress duplicate input/change events
  const recentEvents = new Map(); // selector -> { type, value, time }
  const DEDUP_WINDOW = 100; // ms

  function isDuplicate(eventType, selector, value) {
    const now = Date.now();
    const key = selector;
    const recent = recentEvents.get(key);
    if (!recent || now - recent.time > DEDUP_WINDOW) return false;

    // submit already captured → suppress change/input on same form fields
    if (recent.type === 'submit') return true;
    // change already captured same value → suppress input
    if (recent.type === 'change' && eventType === 'input' && recent.value === value) return true;

    return false;
  }

  function trackEvent(eventType, selector, value) {
    recentEvents.set(selector, { type: eventType, value, time: Date.now() });
    // Cleanup old entries periodically
    if (recentEvents.size > 50) {
      const now = Date.now();
      for (const [k, v] of recentEvents) {
        if (now - v.time > 1000) recentEvents.delete(k);
      }
    }
  }

  function onScroll() {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      sendEvent('scroll', { selector: 'window', value: String(window.scrollY) });
    }, 500);
  }

  function onInput(e) {
    const el = e.target;
    const key = compactSelector(el);
    if (inputTimers.has(key)) clearTimeout(inputTimers.get(key));
    inputTimers.set(key, setTimeout(() => {
      const value = el.type === 'password' ? '***' : (el.value || '').slice(0, 200);
      if (isDuplicate('input', key, value)) { inputTimers.delete(key); return; }
      sendEvent('input', { selector: key, context: elementContext(el), value });
      trackEvent('input', key, value);
      inputTimers.delete(key);
    }, 300));
  }

  function onClick(e) {
    sendEvent(e.type, { selector: compactSelector(e.target), context: elementContext(e.target) });
  }

  function onSubmit(e) {
    const selector = compactSelector(e.target);
    sendEvent('submit', { selector, context: elementContext(e.target) });
    trackEvent('submit', selector);
    // Also mark all child inputs so their pending change/input get suppressed
    e.target.querySelectorAll('input, textarea, select').forEach(el => {
      const childSel = compactSelector(el);
      trackEvent('submit', childSel);
      // Cancel any pending input timer
      if (inputTimers.has(childSel)) {
        clearTimeout(inputTimers.get(childSel));
        inputTimers.delete(childSel);
      }
    });
  }

  function onChange(e) {
    const el = e.target;
    const selector = compactSelector(el);
    const value = el.type === 'password' ? '***' : (el.value || '').slice(0, 200);
    if (isDuplicate('change', selector, value)) return;
    sendEvent('change', { selector, context: elementContext(el), value });
    trackEvent('change', selector, value);
  }

  function startRecording() {
    recording = true;
    document.addEventListener('click', onClick, true);
    document.addEventListener('dblclick', onClick, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('submit', onSubmit, true);
    window.addEventListener('scroll', onScroll, true);
  }

  function stopRecording() {
    recording = false;
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('dblclick', onClick, true);
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('change', onChange, true);
    document.removeEventListener('submit', onSubmit, true);
    window.removeEventListener('scroll', onScroll, true);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'recording:start') startRecording();
    else if (msg.type === 'recording:stop') stopRecording();
  });

  // Check if already recording (e.g., page refresh during session)
  chrome.runtime.sendMessage({ type: 'session:get' }, (res) => {
    if (res && res.recording) startRecording();
  });
})();
