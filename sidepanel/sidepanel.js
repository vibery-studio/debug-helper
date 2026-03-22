const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let activeFilter = 'all';
let autoScroll = true; // auto-scroll feed to bottom
let cachedScreenshots = []; // shared screenshot cache for feed thumbnails
let currentSessionId = null;   // the session being viewed (from history or active)
let activeSessionId = null;    // the currently recording session (set by service worker)
let viewingHistorical = false; // true when viewing a past session from history
let knownEventCount = 0;

async function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

// Tab switching
$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.remove('active'));
    $$('.tab-content').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    $(`#tab-${tab.dataset.tab}`).classList.add('active');
    $('#filters').classList.toggle('hidden', tab.dataset.tab !== 'feed');
    if (tab.dataset.tab !== 'feed') {
      $('#note-bar').classList.add('hidden');
    } else if (activeSessionId) {
      $('#note-bar').classList.remove('hidden');
    }
    if (tab.dataset.tab === 'history') loadHistory();
  });
});

// Filters
$$('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = btn.dataset.filter;
    applyFilter();
  });
});

// Auto-scroll pause toggle
$('#btn-autoscroll').addEventListener('click', () => {
  autoScroll = !autoScroll;
  const btn = $('#btn-autoscroll');
  btn.textContent = autoScroll ? 'Auto ↓' : 'Paused';
  btn.classList.toggle('paused', !autoScroll);
  if (autoScroll) {
    const feed = $('#feed');
    feed.scrollTop = feed.scrollHeight;
  }
});

function applyFilter() {
  $$('.event-item').forEach(el => {
    if (activeFilter === 'all') { el.classList.remove('hidden'); return; }
    el.classList.toggle('hidden', el.dataset.type !== activeFilter);
  });
}

function badgeClass(type) {
  if (type === 'event:dom') return 'badge-dom';
  if (type === 'event:console') return 'badge-warn';
  if (type.includes('network')) return 'badge-network';
  if (type === 'event:note') return 'badge-note';
  if (type === 'event:screenshot') return 'badge-info';
  return 'badge-info';
}

function eventLabel(ev) {
  if (ev.type === 'event:dom') {
    const ctx = ev.context || {};
    let label = `<strong>${ev.eventType}</strong>`;
    if (ctx.text) label += ` "${escHtml(ctx.text).slice(0, 60)}"`;
    if (ctx.tag) label += ` <code>${escHtml(ctx.tag)}</code>`;
    label += ` on <code>${escHtml(ev.selector)}</code>`;
    if (ev.value) label += ' = ' + escHtml(ev.value);
    return label;
  }
  if (ev.type === 'event:console') return `<span class="badge ${ev.level === 'error' ? 'badge-error' : 'badge-warn'}">${ev.level}</span> ${escHtml(ev.message).slice(0, 200)}`;
  if (ev.type.includes('network')) return `<strong>${ev.method}</strong> ${escHtml(ev.url).slice(0, 100)} → <span class="${ev.status >= 400 ? 'badge-error' : ''}">${ev.status}</span> (${ev.duration}ms)`;
  if (ev.type === 'event:note') return `<strong>📝</strong> ${escHtml(ev.content)}`;
  if (ev.type === 'event:screenshot') return `<strong>📸</strong> Screenshot captured`;
  return JSON.stringify(ev).slice(0, 200);
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function renderEvent(ev) {
  const div = document.createElement('div');
  div.className = 'event-item' + (ev.type === 'event:note' ? ' note-event' : '') + (ev.type === 'event:screenshot' ? ' screenshot-event' : '');
  div.dataset.type = ev.type;
  const t = new Date(ev.timestamp);
  const time = t.toLocaleTimeString() + '.' + String(t.getMilliseconds()).padStart(3, '0');
  div.innerHTML = `<span class="time">${time}</span> <span class="badge ${badgeClass(ev.type)}">${ev.type.split(':').pop()}</span><div class="detail">${eventLabel(ev)}</div>`;

  // Show thumbnail for screenshot events using cached data
  if (ev.type === 'event:screenshot' && ev.screenshotId) {
    const s = cachedScreenshots.find(sc => sc.id === ev.screenshotId);
    if (s) {
      const thumb = document.createElement('img');
      thumb.className = 'feed-screenshot-thumb';
      thumb.dataset.screenshotId = ev.screenshotId;
      thumb.title = 'Click to open annotator';
      thumb.src = s.annotatedDataUrl || s.dataUrl;
      thumb.addEventListener('click', () => {
        chrome.windows.create({
          url: chrome.runtime.getURL(`annotator/annotator.html?id=${ev.screenshotId}`),
          type: 'popup', width: 900, height: 700
        });
      });
      div.appendChild(thumb);
    }
  }

  return div;
}

async function loadFeed() {
  let state;
  try {
    state = await send({ type: 'session:get' });
  } catch { return; } // service worker unavailable
  const statusEl = $('#status');
  const noteBar = $('#note-bar');

  // Check which tab is active — only show note-bar on feed tab
  const onFeedTab = document.querySelector('.tab[data-tab="feed"]')?.classList.contains('active');

  if (state.recording) {
    statusEl.textContent = 'Recording';
    statusEl.className = 'status-badge recording';
    activeSessionId = state.session.id;
    currentSessionId = state.session.id;
    viewingHistorical = false;
    if (onFeedTab) noteBar.classList.remove('hidden');
  } else if (state.session) {
    noteBar.classList.add('hidden');
    // Session exists (either just stopped or from lastSessionId)
    if (activeSessionId && activeSessionId === state.session.id && state.session.endTime) {
      // Was recording, now stopped — auto-show this session
      statusEl.textContent = 'Session ended';
      statusEl.className = 'status-badge';
      currentSessionId = state.session.id;
      activeSessionId = null;
      loadHistory(); // refresh history list
    } else if (!viewingHistorical) {
      // Show last session
      statusEl.textContent = state.session.endTime ? 'Last session' : 'Idle';
      statusEl.className = 'status-badge';
      currentSessionId = state.session.id;
    } else {
      statusEl.textContent = 'Viewing history';
      statusEl.className = 'status-badge';
    }
  } else {
    statusEl.textContent = viewingHistorical ? 'Viewing history' : 'Idle';
    statusEl.className = 'status-badge';
    activeSessionId = null;
    noteBar.classList.add('hidden');
  }

  updateRecordButton();

  if (!currentSessionId) return;

  const sid = currentSessionId;
  const all = await chrome.storage.local.get(null);
  let events = [];
  for (const k in all) {
    if (k.startsWith('events:' + sid + ':')) {
      events = events.concat(all[k]);
    }
  }

  // Always refresh screenshot cache to pick up annotation edits
  try {
    cachedScreenshots = await send({ type: 'screenshot:list', sessionId: sid }) || [];
  } catch { cachedScreenshots = []; }

  if (events.length !== knownEventCount) {
    events.sort((a, b) => a.timestamp - b.timestamp);
    const feed = $('#feed');
    feed.innerHTML = '';
    events.forEach(ev => feed.appendChild(renderEvent(ev)));
    if (autoScroll) $('#tab-feed').scrollTop = $('#tab-feed').scrollHeight;
    knownEventCount = events.length;
    applyFilter();
    renderGallery(cachedScreenshots);
  } else {
    // Update existing feed thumbnails with latest screenshot data (e.g. after annotation)
    $$('.feed-screenshot-thumb').forEach(thumb => {
      const s = cachedScreenshots.find(sc => sc.id === thumb.dataset.screenshotId);
      if (s) {
        const newSrc = s.annotatedDataUrl || s.dataUrl;
        if (thumb.src !== newSrc) thumb.src = newSrc;
      }
    });
    renderGallery(cachedScreenshots);
  }
}

// Toggle recording
$('#btn-record').addEventListener('click', async () => {
  const btn = $('#btn-record');
  btn.disabled = true;
  try {
    if (activeSessionId) {
      await send({ type: 'session:stop' });
    } else {
      await send({ type: 'session:start' });
    }
    knownEventCount = -1;
    loadFeed();
  } catch (err) {
    console.error('[Debug Helper] Record toggle failed:', err);
  } finally {
    btn.disabled = false;
  }
});

function updateRecordButton() {
  const btn = $('#btn-record');
  if (activeSessionId) {
    btn.textContent = 'Stop';
    btn.title = 'Stop recording';
    btn.classList.add('recording');
  } else {
    btn.textContent = 'Record';
    btn.title = 'Start recording';
    btn.classList.remove('recording');
  }
}

// Add note
async function addNote() {
  const input = $('#note-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  await send({ type: 'event:note', content: text, timestamp: Date.now() });
  knownEventCount = -1; // force refresh
  loadFeed();
}

$('#btn-add-note').addEventListener('click', addNote);
$('#note-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addNote();
});

// Feed capture screenshot button
$('#btn-feed-capture').addEventListener('click', async () => {
  const btn = $('#btn-feed-capture');
  btn.disabled = true;
  btn.textContent = '...';
  try {
    const result = await send({ type: 'screenshot:capture' });
    if (result?.error) {
      btn.textContent = 'Failed';
      setTimeout(() => { btn.textContent = 'Capture'; }, 1500);
      return;
    }
    knownEventCount = -1;
    loadFeed();
    btn.textContent = 'Capture';
  } catch {
    btn.textContent = 'Failed';
    setTimeout(() => { btn.textContent = 'Capture'; }, 1500);
  } finally {
    btn.disabled = false;
  }
});

// Screenshots
$('#btn-capture').addEventListener('click', async () => {
  const btn = $('#btn-capture');
  btn.disabled = true;
  try {
    const result = await send({ type: 'screenshot:capture' });
    if (result?.error) {
      btn.textContent = 'Failed';
      setTimeout(() => { btn.textContent = 'Capture Screenshot'; }, 1500);
      return;
    }
    knownEventCount = -1;
    loadFeed();
  } catch (err) {
    btn.textContent = 'Failed';
    setTimeout(() => { btn.textContent = 'Capture Screenshot'; }, 1500);
  } finally {
    btn.disabled = false;
  }
});

// Render gallery from screenshot array (shared by loadScreenshots and loadFeed)
function renderGallery(screenshots) {
  const gallery = $('#gallery');
  gallery.innerHTML = '';
  screenshots.forEach(s => {
    const img = document.createElement('img');
    img.src = s.annotatedDataUrl || s.dataUrl;
    img.title = new Date(s.timestamp).toLocaleString();
    img.addEventListener('click', () => {
      chrome.windows.create({
        url: chrome.runtime.getURL(`annotator/annotator.html?id=${s.id}`),
        type: 'popup', width: 900, height: 700
      });
    });
    gallery.appendChild(img);
  });
}

async function loadScreenshots() {
  if (!currentSessionId) return;
  cachedScreenshots = await send({ type: 'screenshot:list', sessionId: currentSessionId }) || [];
  renderGallery(cachedScreenshots);
}

// View a specific session (from history click)
function viewSession(sessionId) {
  currentSessionId = sessionId;
  viewingHistorical = sessionId !== activeSessionId;
  knownEventCount = -1; // force reload
  // Switch to feed tab
  $$('.tab').forEach(t => t.classList.remove('active'));
  $$('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector('.tab[data-tab="feed"]').classList.add('active');
  $('#tab-feed').classList.add('active');
  $('#filters').classList.remove('hidden');
  loadFeedForSession(sessionId);
  loadScreenshotsForSession(sessionId);
}

async function loadFeedForSession(sessionId) {
  const session = await send({ type: 'session:get' });
  const sid = sessionId || session?.session?.id;
  if (!sid) return;

  const all = await chrome.storage.local.get(null);
  let events = [];
  for (const k in all) {
    if (k.startsWith('events:' + sid + ':')) {
      events = events.concat(all[k]);
    }
  }

  // Refresh screenshot cache before rendering
  cachedScreenshots = await send({ type: 'screenshot:list', sessionId: sid }) || [];
  events.sort((a, b) => a.timestamp - b.timestamp);
  const feed = $('#feed');
  feed.innerHTML = '';
  events.forEach(ev => feed.appendChild(renderEvent(ev)));
  if (autoScroll) $('#tab-feed').scrollTop = $('#tab-feed').scrollHeight;
  knownEventCount = events.length;
  applyFilter();
  renderGallery(cachedScreenshots);
}

async function loadScreenshotsForSession(sessionId) {
  if (!sessionId) return;
  cachedScreenshots = await send({ type: 'screenshot:list', sessionId }) || [];
  renderGallery(cachedScreenshots);
}

// History
function updateDeleteSelectedBtn() {
  const checked = $$('.session-check:checked');
  $('#btn-delete-selected').disabled = checked.length === 0;
  $('#btn-delete-selected').textContent = checked.length ? `Delete (${checked.length})` : 'Delete Selected';
}

async function loadHistory() {
  const sessions = await send({ type: 'session:list' });
  const list = $('#history-list');
  list.innerHTML = '';
  sessions.forEach(s => {
    const div = document.createElement('div');
    div.className = 'session-item';
    const start = new Date(s.startTime).toLocaleString();
    const dur = s.endTime ? Math.round((s.endTime - s.startTime) / 1000) + 's' : 'ongoing';
    const isActive = s.id === currentSessionId;
    const title = s.title ? escHtml(s.title) : '';
    div.innerHTML = `
      <div class="session-row">
        <input type="checkbox" class="session-check" data-id="${s.id}">
        <div class="session-info">
          <div class="session-title ${title ? '' : 'untitled'}" data-id="${s.id}">${title || 'Untitled session'}</div>
          <div class="url">${escHtml(s.url)}</div>
          <div class="meta">${start} · ${dur} · ${s.eventCount} events${isActive ? ' · <strong>viewing</strong>' : ''}</div>
        </div>
      </div>
      <div class="session-actions">
        <button class="btn btn-sm session-view" data-id="${s.id}">View</button>
        <button class="btn btn-sm session-export" data-id="${s.id}">Export</button>
        <button class="btn btn-sm session-rename" data-id="${s.id}" data-title="${escHtml(s.title || '')}">Rename</button>
        <button class="btn btn-sm session-delete" data-id="${s.id}" style="color:var(--danger)">Delete</button>
      </div>
    `;
    list.appendChild(div);
  });

  // Checkbox change
  $$('.session-check').forEach(cb => cb.addEventListener('change', updateDeleteSelectedBtn));

  // Click on title to rename
  $$('.session-title').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      renameSession(el.dataset.id, el.textContent === 'Untitled session' ? '' : el.textContent);
    });
  });

  // Bind actions
  $$('.session-view').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); viewSession(btn.dataset.id); });
  });

  $$('.session-export').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const sid = btn.dataset.id;
      currentSessionId = sid;
      viewingHistorical = sid !== activeSessionId;
      $$('.tab').forEach(t => t.classList.remove('active'));
      $$('.tab-content').forEach(t => t.classList.remove('active'));
      document.querySelector('.tab[data-tab="export"]').classList.add('active');
      $('#tab-export').classList.add('active');
      $('#filters').classList.add('hidden');
    });
  });

  $$('.session-rename').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      renameSession(btn.dataset.id, btn.dataset.title);
    });
  });

  $$('.session-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this session?')) return;
      await send({ type: 'session:clear', sessionId: btn.dataset.id });
      loadHistory();
    });
  });

  updateDeleteSelectedBtn();
}

async function renameSession(sessionId, currentTitle) {
  const title = prompt('Session title:', currentTitle || '');
  if (title === null) return;
  await send({ type: 'session:update', sessionId, updates: { title } });
  loadHistory();
}

// Delete selected sessions
$('#btn-delete-selected').addEventListener('click', async () => {
  const checked = [...$$('.session-check:checked')].map(cb => cb.dataset.id);
  if (!checked.length) return;
  if (!confirm(`Delete ${checked.length} session(s)?`)) return;
  for (const id of checked) await send({ type: 'session:clear', sessionId: id });
  if (checked.includes(currentSessionId)) { currentSessionId = null; viewingHistorical = false; }
  loadHistory();
});

$('#btn-select-all').addEventListener('click', () => {
  const checks = $$('.session-check');
  const allChecked = [...checks].every(cb => cb.checked);
  checks.forEach(cb => cb.checked = !allChecked);
  updateDeleteSelectedBtn();
});

// Export
let lastExportText = '';
let lastExportFormat = 'md';

function getExportFilters() {
  const filters = {};
  $$('#tab-export .filter-section input[data-filter]').forEach(cb => {
    filters[cb.dataset.filter] = cb.checked;
  });
  return filters;
}

async function generatePreview(format) {
  if (!currentSessionId) return;
  const btnMap = { markdown: $('#btn-preview-md'), json: $('#btn-preview-json'), toon: $('#btn-preview-toon') };
  const btn = btnMap[format];
  btn.textContent = 'Generating...';
  btn.disabled = true;

  try {
    const result = await send({ type: 'export:generate', sessionId: currentSessionId, format, filters: getExportFilters() });
    if (!result || result.error) {
      $('#export-preview').textContent = result?.error || 'No data — is a session selected?';
      $('#preview-info').textContent = 'Error';
      $('#export-preview-wrap').classList.remove('hidden');
      return;
    }

    if (format === 'markdown') {
      lastExportText = result.markdown;
      lastExportFormat = 'md';
    } else if (format === 'toon') {
      lastExportText = result.toon;
      lastExportFormat = 'toon';
    } else {
      // Strip internal fields from preview/copy
      const clean = JSON.parse(JSON.stringify(result));
      if (clean.debugReport) delete clean.debugReport._screenshotFiles;
      lastExportText = JSON.stringify(clean, null, 2);
      lastExportFormat = 'json';
    }

    $('#export-preview').textContent = lastExportText;
    const sizeKB = (new Blob([lastExportText]).size / 1024).toFixed(1);
    $('#preview-info').textContent = `${format.toUpperCase()} · ${sizeKB} KB`;
    $('#export-preview-wrap').classList.remove('hidden');
  } finally {
    const labels = { markdown: 'Preview Markdown', json: 'Preview JSON', toon: 'Preview TOON' };
    btn.textContent = labels[format];
    btn.disabled = false;
  }
}

// Quick export — one-click copy markdown with default filters
$('#btn-quick-export').addEventListener('click', async () => {
  const btn = $('#btn-quick-export');
  const sid = currentSessionId;
  if (!sid) { btn.textContent = 'No session'; setTimeout(() => btn.textContent = 'Quick Copy', 1500); return; }
  btn.textContent = 'Exporting...';
  btn.disabled = true;
  try {
    const result = await send({ type: 'export:generate', sessionId: sid, format: 'markdown', filters: {
      steps: true, console: true, network: true, networkErrorsOnly: true,
      screenshots: true, dedup: true, skipScrollZero: true, screenshotAsFile: true
    }});
    if (result?.markdown) {
      try { await navigator.clipboard.writeText(result.markdown); }
      catch { /* fallback */ const ta = document.createElement('textarea'); ta.value = result.markdown; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
      btn.textContent = 'Copied!';
    }
  } finally {
    btn.disabled = false;
    setTimeout(() => btn.textContent = 'Quick Copy', 1500);
  }
});

$('#btn-delete-all').addEventListener('click', async () => {
  const sessions = await send({ type: 'session:list' });
  if (!sessions.length) return;
  if (!confirm(`Delete all ${sessions.length} sessions?`)) return;
  for (const s of sessions) await send({ type: 'session:clear', sessionId: s.id });
  currentSessionId = null;
  viewingHistorical = false;
  knownEventCount = 0;
  $('#feed').innerHTML = '';
  $('#gallery').innerHTML = '';
  loadHistory();
});

$('#btn-preview-md').addEventListener('click', () => generatePreview('markdown'));
$('#btn-preview-json').addEventListener('click', () => generatePreview('json'));
$('#btn-preview-toon').addEventListener('click', () => generatePreview('toon'));

$('#btn-debug-events').addEventListener('click', async () => {
  if (!currentSessionId) { alert('No session selected'); return; }
  const result = await send({ type: 'debug:events', sessionId: currentSessionId });
  $('#export-preview').textContent = JSON.stringify(result, null, 2);
  $('#export-preview-wrap').classList.remove('hidden');
  $('#preview-info').textContent = 'DEBUG';
});

$('#btn-copy').addEventListener('click', async () => {
  if (!lastExportText) return;
  try {
    await navigator.clipboard.writeText(lastExportText);
    $('#btn-copy').textContent = 'Copied!';
  } catch {
    // Fallback: select the pre text
    const range = document.createRange();
    range.selectNodeContents($('#export-preview'));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('copy');
    $('#btn-copy').textContent = 'Copied!';
  }
  setTimeout(() => $('#btn-copy').textContent = 'Copy to Clipboard', 1500);
});

$('#btn-download').addEventListener('click', async () => {
  if (!lastExportText || !currentSessionId) return;
  const btn = $('#btn-download');
  const filters = getExportFilters();
  const formatMap = { md: 'markdown', json: 'json', toon: 'toon' };
  const format = formatMap[lastExportFormat] || 'json';

  if (filters.screenshotAsFile) {
    // Download as ZIP (report + screenshot files)
    btn.textContent = 'Building ZIP...';
    btn.disabled = true;
    try {
      const result = await send({ type: 'export:zip', sessionId: currentSessionId, format, filters });
      if (result?.zipDataUrl) {
        const a = document.createElement('a');
        a.href = result.zipDataUrl;
        a.download = result.filename;
        a.click();
      }
    } finally {
      btn.textContent = 'Download ZIP';
      btn.disabled = false;
    }
  } else {
    // Download single file
    const ext = lastExportFormat;
    const mimeTypes = { json: 'application/json', md: 'text/markdown', toon: 'text/toon' };
    const blob = new Blob([lastExportText], { type: mimeTypes[ext] || 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `debug-report-${currentSessionId}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  }
});

// Storage change listener for live updates
chrome.storage.onChanged.addListener((changes) => {
  loadFeed();
  // Refresh history when a session is created or ended
  if (Object.keys(changes).some(k => k.startsWith('session:') || k === 'currentSessionId')) {
    loadHistory();
  }
});

// Initial load — check if popup requested a specific session
(async () => {
  const { viewSessionId } = await chrome.storage.local.get('viewSessionId');
  if (viewSessionId) {
    await chrome.storage.local.remove('viewSessionId');
    viewSession(viewSessionId);
  } else {
    loadFeed();
    loadScreenshots();
  }
  loadHistory();
})();
setInterval(() => {
  loadFeed();
  loadScreenshots();
}, 3000);
