// MAIN world — wraps console methods and captures errors
;(() => {
  const PREFIX = '__debugHelper__';
  if (window[PREFIX + 'consolePatched']) return;
  window[PREFIX + 'consolePatched'] = true;

  let recording = false;

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (!e.data || e.data.source !== 'debug-helper-isolated') return;
    if (e.data.type === 'recording:start') recording = true;
    if (e.data.type === 'recording:stop') recording = false;
  });

  const origConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console)
  };

  function serialize(args) {
    return args.map(a => {
      if (a instanceof Error) return a.message + '\n' + (a.stack || '');
      if (typeof a === 'object') {
        try { return JSON.stringify(a).slice(0, 2048); } catch { return String(a); }
      }
      return String(a);
    }).join(' ');
  }

  function post(level, args, stack) {
    if (!recording) return;
    window.postMessage({
      source: 'debug-helper-main',
      type: 'event:console',
      timestamp: Date.now(),
      level,
      message: serialize(args).slice(0, 5000),
      stack: stack || undefined
    }, '*');
  }

  ['log', 'warn', 'error', 'info'].forEach(level => {
    console[level] = function (...args) {
      origConsole[level](...args);
      let stack;
      if (level === 'error') {
        try { stack = new Error().stack.split('\n').slice(2, 8).join('\n'); } catch {}
      }
      post(level, args, stack);
    };
  });

  window.addEventListener('error', (e) => {
    post('error', [e.message], e.error?.stack || `${e.filename}:${e.lineno}:${e.colno}`);
  });

  window.addEventListener('unhandledrejection', (e) => {
    const msg = e.reason instanceof Error ? e.reason.message : String(e.reason);
    const stack = e.reason instanceof Error ? e.reason.stack : undefined;
    post('error', ['Unhandled Promise Rejection: ' + msg], stack);
  });
})();
