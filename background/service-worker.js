importScripts('../lib/storage.js', '../lib/export.js', '../lib/zip.js', '../lib/toon.js');

// Sensitive data redaction
const Redact = {
  PATTERNS: [
    { re: /\b(Bearer\s+)[A-Za-z0-9\-._~+\/]+=*/gi, replace: '$1[REDACTED]' },
    { re: /\b(token|api[_-]?key|secret|password|passwd|authorization)[=:]\s*["']?[^\s"',}{]+/gi, replace: '$1=[REDACTED]' },
    { re: /\b(sk-|pk_live_|pk_test_|rk_live_|rk_test_|ghp_|gho_|github_pat_)[A-Za-z0-9_\-]+/gi, replace: '[REDACTED_KEY]' },
  ],

  str(s) {
    if (typeof s !== 'string') return s;
    for (const p of this.PATTERNS) s = s.replace(p.re, p.replace);
    return s;
  },

  event(e) {
    const copy = { ...e };
    if (copy.message) copy.message = this.str(copy.message);
    if (copy.stack) copy.stack = this.str(copy.stack);
    if (copy.url) copy.url = this.str(copy.url);
    if (copy.requestBody) copy.requestBody = this.str(copy.requestBody);
    if (copy.responseBody) copy.responseBody = this.str(copy.responseBody);
    if (copy.value) copy.value = this.str(copy.value);
    if (copy.content) copy.content = this.str(copy.content);
    return copy;
  }
};

const SW = {
  eventBuffer: [],
  FLUSH_INTERVAL: 2000,
  FLUSH_SIZE: 50,
  _flushTimer: null,
  KEEPALIVE_NAME: 'debug-helper-keepalive',

  async init() {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      // Verify sender is from this extension or a content script
      if (sender.id && sender.id !== chrome.runtime.id) {
        sendResponse({ error: 'Unauthorized sender' });
        return true;
      }
      this.handleMessage(msg, sender).then(sendResponse).catch(err => {
        console.error('[Debug Helper] Message handler error:', err);
        sendResponse({ error: err.message || 'Internal error' });
      });
      return true;
    });

    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === this.KEEPALIVE_NAME) this.flushBuffer();
    });

    const session = await Storage.getCurrentSession();
    if (session && !session.endTime) {
      this.setBadge(true);
      this.startKeepalive();
    }
  },

  async handleMessage(msg) {
    switch (msg.type) {
      case 'session:start': return this.startSession(msg);
      case 'session:stop': return this.stopSession();
      case 'session:get': return this.getSessionState();
      case 'session:clear': return this.clearSession(msg.sessionId);
      case 'session:update': return this.updateSession(msg.sessionId, msg.updates);
      case 'session:list': return Storage.listSessions();
      case 'session:flush': return this.flushBuffer();
      case 'screenshot:capture': return this.captureScreenshot(msg.tabId);
      case 'screenshot:saveDataUrl': return this.saveScreenshotDataUrl(msg.dataUrl);
      case 'video:streamId': return this.getTabStreamId(msg.tabId);
      case 'screenshot:save': return this.saveAnnotatedScreenshot(msg);
      case 'screenshot:list': return this.listScreenshots(msg.sessionId);
      case 'storage:usage': return Storage.getStorageUsage();
      case 'storage:cleanup': return Storage.cleanupOldSessions(msg.keepCount || 10);
      case 'export:generate': return this.exportSession(msg.sessionId, msg.format, msg.filters);
      case 'export:zip': return this.exportZip(msg.sessionId, msg.format, msg.filters);
      case 'debug:events': return this.debugEvents(msg.sessionId);
      case 'event:dom':
      case 'event:console':
      case 'event:network':
      case 'event:network:enhanced':
      case 'event:note':
      case 'event:video':
        return this.bufferEvent(msg);
      default:
        return { error: 'Unknown message type: ' + msg.type };
    }
  },

  async startSession(msg) {
    const current = await Storage.getCurrentSession();
    if (current && !current.endTime) await this.stopSession();

    // Auto-cleanup if storage usage > 80%
    try {
      const usage = await Storage.getStorageUsage();
      if (usage.percent > 80) {
        const deleted = await Storage.cleanupOldSessions(5);
        if (deleted > 0) console.log(`[Debug Helper] Auto-cleaned ${deleted} old sessions (storage at ${usage.percent}%)`);
      }
    } catch (err) {
      console.warn('[Debug Helper] Storage check failed:', err);
    }

    const tab = msg.tabId
      ? await chrome.tabs.get(msg.tabId)
      : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];

    const session = await Storage.createSession(tab.id, tab.url);
    this.setBadge(true);
    this.startKeepalive();

    // Re-inject content scripts to handle extension reload / fresh tabs
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content/recorder.js'],
      });
    } catch { /* already injected or restricted page */ }
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content/bridge.js'],
      });
    } catch {}
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, world: 'MAIN' },
        files: ['content/console-capture.js'],
      });
    } catch {}
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, world: 'MAIN' },
        files: ['content/network-capture.js'],
      });
    } catch {}

    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'recording:start', sessionId: session.id });
    } catch { /* content script may not be loaded yet */ }

    return session;
  },

  async stopSession() {
    const session = await Storage.getCurrentSession();
    if (!session) return null;

    await this.flushBuffer();
    const ended = await Storage.endSession(session.id);
    this.setBadge(false);
    this.stopKeepalive();

    try {
      await chrome.tabs.sendMessage(session.tabId, { type: 'recording:stop' });
    } catch { /* tab may be closed */ }

    return ended;
  },

  lastSessionId: null,

  async getSessionState() {
    const session = await Storage.getCurrentSession();
    if (session) this.lastSessionId = session.id;
    const lastSession = !session && this.lastSessionId
      ? await Storage.getSession(this.lastSessionId)
      : null;
    return {
      session: session || lastSession,
      recording: !!(session && !session.endTime),
      lastSessionId: this.lastSessionId
    };
  },

  async updateSession(sessionId, updates) {
    const session = await Storage.getSession(sessionId);
    if (!session) return null;
    // Only allow safe fields
    if (updates.title !== undefined) session.title = updates.title;
    await chrome.storage.local.set({ ['session:' + sessionId]: session });
    return session;
  },

  async clearSession(sessionId) {
    await Storage.clearSession(sessionId);
    return { success: true };
  },

  async bufferEvent(event) {
    const session = await Storage.getCurrentSession();
    // Explicitly tell the caller the session is gone so it can persist the
    // event (e.g. a late video:stop marker) through a direct storage write.
    if (!session) return { buffered: false, reason: 'no-active-session' };

    // Redact sensitive data before storing
    event = Redact.event(event);

    event._sessionId = session.id;
    this.eventBuffer.push(event);

    if (this.eventBuffer.length >= this.FLUSH_SIZE) {
      await this.flushBuffer();
    } else {
      // Debounced flush — write to storage 500ms after last event for snappy UI
      clearTimeout(this._flushTimer);
      this._flushTimer = setTimeout(() => this.flushBuffer(), 500);
    }
    return { buffered: true };
  },

  async flushBuffer() {
    if (this.eventBuffer.length === 0) return;

    const session = await Storage.getCurrentSession();
    if (!session) { this.eventBuffer = []; return; }

    const events = this.eventBuffer.splice(0);
    try {
      await Storage.addEvents(session.id, events);
    } catch (err) {
      console.error('[Debug Helper] Failed to flush events:', err);
      // If quota exceeded, try to clean old sessions
      if (err?.message?.includes('QUOTA') || err?.message?.includes('quota')) {
        await Storage.cleanupOldSessions(5);
      }
    }
  },

  async captureScreenshot() {
    const session = await Storage.getCurrentSession();
    if (!session) return { error: 'No active session' };

    let dataUrl;
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
    } catch (err) {
      console.error('[Debug Helper] Screenshot capture failed:', err);
      return { error: 'Screenshot capture failed: ' + err.message };
    }
    const entry = await Storage.saveScreenshot(session.id, dataUrl, []);

    // Flush buffered DOM events first so timeline order is correct
    await this.flushBuffer();

    // Store screenshot marker directly (not via buffer) to guarantee persistence
    await Storage.addEvents(session.id, [{
      type: 'event:screenshot',
      timestamp: entry.timestamp,
      screenshotId: entry.id,
      _sessionId: session.id
    }]);

    return entry;
  },

  // Persist a screenshot that was captured client-side (sidepanel grabs a frame
  // from the tab stream via tabCapture, which avoids the <all_urls> requirement
  // that chrome.tabs.captureVisibleTab imposes).
  async saveScreenshotDataUrl(dataUrl) {
    if (!dataUrl) return { error: 'Missing dataUrl' };
    const session = await Storage.getCurrentSession();
    if (!session) return { error: 'No active session' };

    const entry = await Storage.saveScreenshot(session.id, dataUrl, []);
    await this.flushBuffer();
    await Storage.addEvents(session.id, [{
      type: 'event:screenshot',
      timestamp: entry.timestamp,
      screenshotId: entry.id,
      _sessionId: session.id
    }]);
    return entry;
  },

  async saveAnnotatedScreenshot(msg) {
    return Storage.updateScreenshot(msg.screenshotId, {
      annotatedDataUrl: msg.annotatedDataUrl,
      annotations: msg.annotations
    });
  },

  async getTabStreamId(tabId) {
    const session = await Storage.getCurrentSession();
    const tid = tabId || session?.tabId;
    if (!tid) return { error: 'No active tab' };
    return new Promise((resolve) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tid }, (streamId) => {
        if (chrome.runtime.lastError) {
          resolve({ error: chrome.runtime.lastError.message });
        } else {
          resolve({ streamId });
        }
      });
    });
  },

  async listScreenshots(sessionId) {
    const sid = sessionId || (await Storage.getCurrentSession())?.id;
    if (!sid) return [];
    return Storage.getScreenshots(sid);
  },

  async debugEvents(sessionId) {
    const events = await Storage.getEvents(sessionId);
    const screenshots = await Storage.getScreenshots(sessionId);
    return {
      eventCount: events.length,
      eventTypes: events.map(e => e.type),
      screenshotEvents: events.filter(e => e.type === 'event:screenshot'),
      screenshotIds: screenshots.map(s => s.id),
    };
  },

  async exportZip(sessionId, format, filters) {
    // Force screenshotAsFile for ZIP
    const f = { ...filters, screenshotAsFile: true };
    const data = await Export.generateJSON(sessionId, f);
    if (!data) return null;

    const entries = [];

    // Screenshot image files
    const screenshotFiles = data.debugReport._screenshotFiles || [];
    for (const sf of screenshotFiles) {
      const res = await fetch(sf.dataUrl);
      const buf = await res.arrayBuffer();
      entries.push({ name: sf.filename, data: new Uint8Array(buf) });
    }

    // Video files
    const videoFiles = data.debugReport._videoFiles || [];
    for (const vf of videoFiles) {
      if (vf.blob) {
        const buf = await vf.blob.arrayBuffer();
        entries.push({ name: vf.filename, data: new Uint8Array(buf) });
      }
    }

    // Remove internal fields before serializing
    delete data.debugReport._screenshotFiles;
    delete data.debugReport._videoFiles;

    // Report file
    if (format === 'markdown') {
      const md = await Export.generateMarkdown(sessionId, f);
      entries.push({ name: `debug-report.md`, data: md });
    } else if (format === 'toon') {
      const report = { ...data.debugReport };
      delete report._screenshotFiles;
      entries.push({ name: `debug-report.toon`, data: Toon.encode({ debugReport: report }) });
    } else {
      entries.push({ name: `debug-report.json`, data: JSON.stringify(data, null, 2) });
    }

    const blob = Zip.build(entries);
    // Convert blob to data URL so we can pass it back via message
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return { zipDataUrl: 'data:application/zip;base64,' + btoa(binary), filename: `debug-report-${sessionId}.zip` };
  },

  async exportSession(sessionId, format, filters) {
    if (format === 'json') {
      const data = await Export.generateJSON(sessionId, filters);
      if (!data) return null;
      // Strip internal fields with Blob objects — they can't survive message passing
      delete data.debugReport._screenshotFiles;
      delete data.debugReport._videoFiles;
      return data;
    }
    if (format === 'toon') {
      const data = await Export.generateJSON(sessionId, filters);
      if (!data) return null;
      const report = { ...data.debugReport };
      delete report._screenshotFiles;
      delete report._videoFiles;
      return { toon: Toon.encode({ debugReport: report }) };
    }
    return { markdown: await Export.generateMarkdown(sessionId, filters) };
  },

  setBadge(recording) {
    chrome.action.setBadgeText({ text: recording ? 'REC' : '' });
    chrome.action.setBadgeBackgroundColor({ color: recording ? '#e53e3e' : '#000' });
  },

  flushIntervalId: null,

  startKeepalive() {
    chrome.alarms.create(this.KEEPALIVE_NAME, { periodInMinutes: 0.4 });
    // Start periodic flush only during active recording
    if (this.flushIntervalId) clearInterval(this.flushIntervalId);
    this.flushIntervalId = setInterval(() => this.flushBuffer(), this.FLUSH_INTERVAL);
  },

  stopKeepalive() {
    chrome.alarms.clear(this.KEEPALIVE_NAME);
    if (this.flushIntervalId) {
      clearInterval(this.flushIntervalId);
      this.flushIntervalId = null;
    }
  }
};

// Auto-stop the session if the recording tab is closed or discarded.
// Preserves whatever events have already been buffered.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const session = await Storage.getCurrentSession();
    if (!session || session.endTime || session.tabId !== tabId) return;
    console.log('[Debug Helper] Recording tab closed, auto-stopping session');
    await SW.stopSession();
  } catch (err) {
    console.error('[Debug Helper] Failed to auto-stop on tab close:', err);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  // Chrome's memory saver can discard a tab — the tab id stays valid but the
  // page is unloaded, which also kills any tabCapture stream attached to it.
  if (!changeInfo.discarded) return;
  try {
    const session = await Storage.getCurrentSession();
    if (!session || session.endTime || session.tabId !== tabId) return;
    console.log('[Debug Helper] Recording tab discarded, auto-stopping session');
    await SW.stopSession();
  } catch (err) {
    console.error('[Debug Helper] Failed to auto-stop on tab discard:', err);
  }
});

// Keyboard shortcut commands
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'capture-screenshot') {
    const session = await Storage.getCurrentSession();
    if (!session || session.endTime) return; // only during active recording
    await SW.captureScreenshot();
  } else if (command === 'toggle-recording') {
    const session = await Storage.getCurrentSession();
    if (session && !session.endTime) {
      await SW.stopSession();
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) await SW.startSession({ tabId: tab.id });
    }
  }
});

SW.init();

// --- Dev auto-reload (disabled in production builds) ---
// To enable during development, set localStorage['debug-helper-dev'] = '1'
// or uncomment the DevReload.start() call below.
const DevReload = {
  INTERVAL: 1500,
  FILES: [
    'manifest.json',
    'background/service-worker.js',
    'content/bridge.js', 'content/recorder.js',
    'content/console-capture.js', 'content/network-capture.js',
    'popup/popup.js', 'popup/popup.html', 'popup/popup.css',
    'sidepanel/sidepanel.js', 'sidepanel/sidepanel.html', 'sidepanel/sidepanel.css',
    'annotator/annotator.js', 'annotator/annotator.html', 'annotator/annotator.css',
    'devtools/panel.js', 'devtools/panel.html', 'devtools/devtools.js',
    'lib/storage.js', 'lib/export.js', 'lib/utils.js', 'lib/zip.js',
    'styles/common.css'
  ],
  hashes: null,

  async checksum(url) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      const text = await res.text();
      let h = 0;
      for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
      return h;
    } catch { return 0; }
  },

  async snapshot() {
    const map = {};
    for (const f of this.FILES) {
      map[f] = await this.checksum(chrome.runtime.getURL(f));
    }
    return map;
  },

  async poll() {
    const current = await this.snapshot();
    if (!this.hashes) { this.hashes = current; return; }
    for (const f of this.FILES) {
      if (current[f] !== this.hashes[f]) {
        console.log('[Debug Helper] File changed:', f, '— reloading extension');
        chrome.runtime.reload();
        return;
      }
    }
  },

  start() {
    this.snapshot().then(h => { this.hashes = h; });
    setInterval(() => this.poll(), this.INTERVAL);
    console.log('[Debug Helper] Dev auto-reload active (polling every 1.5s)');
  }
};

// DevReload.start();
