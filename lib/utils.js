const Utils = {
  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  },

  generateSelector(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + CSS.escape(el.id);

    const parts = [];
    let current = el;
    while (current && current.nodeType === 1 && current !== document.body) {
      let selector = current.tagName.toLowerCase();
      if (current.id) {
        parts.unshift('#' + CSS.escape(current.id));
        break;
      }
      if (current.className && typeof current.className === 'string') {
        const cls = current.className.trim().split(/\s+/).slice(0, 2).map(c => '.' + CSS.escape(c)).join('');
        selector += cls;
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
        if (siblings.length > 1) {
          selector += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
        }
      }
      parts.unshift(selector);
      current = parent;
    }
    return parts.join(' > ');
  },

  debounce(fn, ms) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
  },

  truncate(str, maxLen = 10240) {
    if (typeof str !== 'string') {
      try { str = JSON.stringify(str); } catch { str = String(str); }
    }
    return str.length > maxLen ? str.slice(0, maxLen) + '...[truncated]' : str;
  },

  formatTimestamp(ts) {
    const d = new Date(ts);
    return d.toLocaleString() + '.' + String(d.getMilliseconds()).padStart(3, '0');
  },

  formatDuration(ms) {
    if (ms < 1000) return ms + 'ms';
    return (ms / 1000).toFixed(2) + 's';
  }
};

if (typeof globalThis !== 'undefined') globalThis.__DebugHelperUtils = Utils;
