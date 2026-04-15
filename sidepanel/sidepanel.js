const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let activeFilter = 'all';
let autoScroll = true; // auto-scroll feed to bottom
let cachedScreenshots = []; // shared screenshot cache for feed thumbnails
let currentSessionId = null;   // the session being viewed (from history or active)
let activeSessionId = null;    // the currently recording session (set by service worker)
let viewingHistorical = false; // true when viewing a past session from history
let knownEventIds = new Set(); // dedupe set for rendered events (timestamp:type)
// Separate trackers so revoking one group doesn't invalidate <video src="blob:…">
// elements in the other: the feed and gallery re-render on different schedules.
let feedBlobUrls = [];
let galleryBlobUrls = [];

const eventKey = (ev) => ev.timestamp + ':' + ev.type;

function trackFeedBlobUrl(blob) {
  const url = URL.createObjectURL(blob);
  feedBlobUrls.push(url);
  return url;
}

function trackGalleryBlobUrl(blob) {
  const url = URL.createObjectURL(blob);
  galleryBlobUrls.push(url);
  return url;
}

function revokeFeedBlobUrls() {
  feedBlobUrls.forEach(url => URL.revokeObjectURL(url));
  feedBlobUrls = [];
}

function revokeGalleryBlobUrls() {
  galleryBlobUrls.forEach(url => URL.revokeObjectURL(url));
  galleryBlobUrls = [];
}

function revokeAllBlobUrls() {
  revokeFeedBlobUrls();
  revokeGalleryBlobUrls();
}

async function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

// Lightweight toast notifications. Multiple toasts stack; each auto-dismisses.
function showToast(message, variant = 'info', durationMs = 3200) {
  const container = $('#toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast ' + (variant || 'info');
  toast.textContent = message;
  container.appendChild(toast);
  // Force reflow so the transition from hidden → visible animates.
  void toast.offsetWidth;
  toast.classList.add('visible');
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 220);
  }, durationMs);
}

// Shows which tab the session is recording so the user knows where Capture/Video
// will fire, since the sidepanel targets session.tabId — not the visible tab.
async function updateRecordingTarget() {
  const bar = $('#recording-target');
  const info = $('#recording-target-info');
  if (!bar || !info) return;

  const onFeedTab = document.querySelector('.tab[data-tab="feed"]')?.classList.contains('active');
  if (!activeSessionId || !onFeedTab) {
    bar.classList.add('hidden');
    bar.classList.remove('unavailable');
    return;
  }

  let state;
  try { state = await send({ type: 'session:get' }); } catch { return; }
  const tabId = state?.session?.tabId;
  if (!tabId) {
    bar.classList.add('hidden');
    return;
  }

  bar.classList.remove('hidden');
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url || state.session.url || '';
    const title = tab.title || url;
    info.title = url;

    const restricted = /^(chrome|chrome-extension|edge|about|devtools|view-source|chrome-search):/i.test(url)
      || url.startsWith('https://chrome.google.com/webstore')
      || url.startsWith('https://chromewebstore.google.com');
    const streamLive = !!(sessionStream && sessionStream.getTracks().some(t => t.readyState === 'live'));

    let suffix = '';
    if (restricted) suffix = ' — restricted page, capture disabled';
    else if (!streamLive) suffix = ' — capture stream not open (click Capture to retry)';
    info.textContent = title + suffix;
    bar.classList.toggle('unavailable', restricted || !streamLive);
  } catch {
    // Tab closed or otherwise inaccessible
    bar.classList.add('unavailable');
    info.textContent = 'Recording tab is no longer available';
    info.title = '';
  }
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
      $('#recording-target').classList.add('hidden');
    } else {
      if (activeSessionId) $('#note-bar').classList.remove('hidden');
      updateRecordingTarget();
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
    if (activeFilter === 'media') {
      // Media filter: show screenshots and video notes
      el.classList.toggle('hidden', el.dataset.type !== 'event:screenshot' && el.dataset.type !== 'event:video');
    } else {
      el.classList.toggle('hidden', el.dataset.type !== activeFilter);
    }
  });
}

function badgeClass(type) {
  if (type === 'event:dom') return 'badge-dom';
  if (type === 'event:console') return 'badge-warn';
  if (type.includes('network')) return 'badge-network';
  if (type === 'event:note') return 'badge-note';
  if (type === 'event:screenshot') return 'badge-info';
  if (type === 'event:video') return 'badge-info';
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
  if (ev.type === 'event:video') return `<strong>🎥</strong> ${escHtml(ev.content)}`;
  return JSON.stringify(ev).slice(0, 200);
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

// Render a body block with pretty/copy buttons for JSON content
function renderBodyBlock(label, body) {
  if (!body) {
    const empty = document.createElement('div');
    empty.innerHTML = `<b>${label}:</b> <i>none</i>`;
    return empty;
  }

  // Try to detect and pretty-print JSON
  let prettyBody = null;
  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { prettyBody = JSON.stringify(JSON.parse(trimmed), null, 2); } catch {}
  }

  const container = document.createElement('div');
  container.innerHTML = `<b>${label}:</b>`;

  const actions = document.createElement('div');
  actions.className = 'body-actions';

  const pre = document.createElement('pre');
  pre.textContent = (prettyBody || body).slice(0, 3000);

  if (prettyBody) {
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'btn-body-toggle';
    toggleBtn.textContent = 'Raw';
    toggleBtn._raw = body.slice(0, 3000);
    toggleBtn._pretty = prettyBody.slice(0, 3000);
    toggleBtn._pre = pre;
    actions.appendChild(toggleBtn);
  }

  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn-body-copy';
  copyBtn.textContent = 'Copy';
  copyBtn._pre = pre;
  actions.appendChild(copyBtn);

  container.appendChild(actions);
  container.appendChild(pre);
  return container;
}

// Build expanded detail DOM element for an event
function buildEventDetails(ev) {
  const container = document.createElement('div');

  function addRow(html) {
    const row = document.createElement('div');
    row.innerHTML = html;
    container.appendChild(row);
  }

  if (ev.type === 'event:dom') {
    const ctx = ev.context || {};
    addRow(`<b>Event:</b> ${escHtml(ev.eventType)}`);
    addRow(`<b>Selector:</b> <code>${escHtml(ev.selector)}</code>`);
    if (ctx.tag) addRow(`<b>Tag:</b> ${escHtml(ctx.tag)}`);
    if (ctx.text) addRow(`<b>Text:</b> ${escHtml(ctx.text)}`);
    if (ev.value) addRow(`<b>Value:</b> ${escHtml(ev.value)}`);
    if (ctx.id) addRow(`<b>ID:</b> ${escHtml(ctx.id)}`);
    if (ctx.className) addRow(`<b>Class:</b> ${escHtml(ctx.className)}`);
  } else if (ev.type === 'event:console') {
    addRow(`<b>Level:</b> ${escHtml(ev.level)}`);
    addRow(`<b>Message:</b> ${escHtml(ev.message)}`);
    if (ev.stack) addRow(`<b>Stack:</b><pre>${escHtml(ev.stack)}</pre>`);
  } else if (ev.type.includes('network')) {
    addRow(`<b>Method:</b> ${escHtml(ev.method)}`);
    addRow(`<b>URL:</b> ${escHtml(ev.url)}`);
    addRow(`<b>Status:</b> ${ev.status} · <b>Duration:</b> ${ev.duration}ms`);
    container.appendChild(renderBodyBlock('Request Body', ev.requestBody));
    container.appendChild(renderBodyBlock('Response Body', ev.responseBody));
  } else if (ev.type === 'event:note') {
    addRow(`<b>Note:</b> ${escHtml(ev.content)}`);
  } else if (ev.type === 'event:video') {
    addRow(`<b>Video:</b> ${escHtml(ev.content)}`);
  }
  addRow(`<b>Time:</b> ${new Date(ev.timestamp).toLocaleString()}`);
  return container;
}

function renderEvent(ev) {
  const div = document.createElement('div');
  div.className = 'event-item' + (ev.type === 'event:note' ? ' note-event' : '') + (ev.type === 'event:screenshot' ? ' screenshot-event' : '') + (ev.type === 'event:video' ? ' video-event' : '');
  div.dataset.type = ev.type;
  const t = new Date(ev.timestamp);
  const time = t.toLocaleTimeString() + '.' + String(t.getMilliseconds()).padStart(3, '0');
  div.innerHTML = `<span class="time">${time}</span> <span class="badge ${badgeClass(ev.type)}">${ev.type.split(':').pop()}</span><div class="detail">${eventLabel(ev)}</div>`;

  // Expandable details on click (skip for screenshots/videos — thumbnail is already visible)
  if (ev.type !== 'event:screenshot' && ev.type !== 'event:video') {
    const detailsDiv = document.createElement('div');
    detailsDiv.className = 'event-details hidden';
    detailsDiv.appendChild(buildEventDetails(ev));
    div.appendChild(detailsDiv);

    div.addEventListener('click', (e) => {
      // Handle body action buttons
      const toggleBtn = e.target.closest('.btn-body-toggle');
      if (toggleBtn) {
        e.stopPropagation();
        const isRaw = toggleBtn.textContent === 'Raw';
        toggleBtn._pre.textContent = isRaw ? toggleBtn._raw : toggleBtn._pretty;
        toggleBtn.textContent = isRaw ? 'Pretty' : 'Raw';
        return;
      }
      const copyBtn = e.target.closest('.btn-body-copy');
      if (copyBtn) {
        e.stopPropagation();
        navigator.clipboard.writeText(copyBtn._pre.textContent).then(() => {
          copyBtn.textContent = 'Copied!';
          setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1000);
        });
        return;
      }
      // Toggle expand
      div.classList.toggle('expanded');
      detailsDiv.classList.toggle('hidden');
    });
  }

  // Show thumbnail for screenshot events using cached data
  if (ev.type === 'event:screenshot' && ev.screenshotId) {
    const s = cachedScreenshots.find(sc => sc.id === ev.screenshotId);
    if (s) {
      const thumb = document.createElement('img');
      thumb.className = 'feed-screenshot-thumb';
      thumb.dataset.screenshotId = ev.screenshotId;
      thumb.title = 'Click to open annotator';
      thumb.src = s.annotatedDataUrl || s.dataUrl;
      thumb.addEventListener('click', (e) => {
        e.stopPropagation();
        chrome.windows.create({
          url: chrome.runtime.getURL(`annotator/annotator.html?id=${ev.screenshotId}`),
          type: 'popup', width: 900, height: 700
        });
      });
      div.appendChild(thumb);
    }
  }

  // Show video thumbnail for video events — click opens in popup viewer
  if (ev.type === 'event:video' && ev.videoId) {
    const v = cachedScreenshots.find(sc => sc.id === ev.videoId);
    if (v && v.videoBlob) {
      const video = document.createElement('video');
      video.className = 'feed-video-thumb';
      video.src = trackFeedBlobUrl(v.videoBlob);
      video.preload = 'metadata';
      video.title = 'Click to open video';
      video.addEventListener('click', (e) => {
        e.stopPropagation();
        const blobUrl = URL.createObjectURL(v.videoBlob);
        const w = window.open('', '_blank', 'width=900,height=700');
        w.document.title = 'Debug Helper - Video';
        w.document.body.style.cssText = 'margin:0;background:#000;display:flex;align-items:center;justify-content:center;height:100vh';
        const player = w.document.createElement('video');
        player.src = blobUrl;
        player.controls = true;
        player.autoplay = true;
        player.style.maxWidth = '100%';
        player.style.maxHeight = '100%';
        w.document.body.appendChild(player);
      });
      div.appendChild(video);
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
  updateRecordingTarget();

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
  // Read directly from IndexedDB to preserve video blobs (can't survive message passing)
  try {
    cachedScreenshots = await getMediaFromDB(sid);
  } catch { cachedScreenshots = []; }

  const unseenEvents = events.filter(ev => !knownEventIds.has(eventKey(ev)));
  if (unseenEvents.length > 0 || events.length !== knownEventIds.size) {
    events.sort((a, b) => a.timestamp - b.timestamp);
    const feed = $('#feed');
    if (knownEventIds.size > 0 && events.length >= knownEventIds.size && unseenEvents.length === events.length - knownEventIds.size) {
      // Append only new events to preserve expanded state
      unseenEvents.sort((a, b) => a.timestamp - b.timestamp);
      unseenEvents.forEach(ev => {
        feed.appendChild(renderEvent(ev));
        knownEventIds.add(eventKey(ev));
      });
    } else {
      // Full re-render (first load, session switch, or events decreased)
      revokeFeedBlobUrls();
      feed.innerHTML = '';
      events.forEach(ev => feed.appendChild(renderEvent(ev)));
      knownEventIds = new Set(events.map(eventKey));
    }
    if (autoScroll) $('#tab-feed').scrollTop = $('#tab-feed').scrollHeight;
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
      // Stop video recording if active — wait for save to complete before ending session
      if (videoRecorder && videoRecorder.state === 'recording') await stopVideoRecording();
      closeSessionStream();
      await send({ type: 'session:stop' });
    } else {
      await send({ type: 'session:start' });
      // Open the persistent capture stream while this click gesture is still
      // valid and the recording tab is active — this is the only reliable
      // window for chrome.tabCapture to accept the target tab.
      try {
        await openSessionStream();
      } catch (err) {
        console.warn('[Debug Helper] Could not open capture stream at session start:', err);
        showToast('Capture unavailable — first Capture/Video click will retry', 'warn');
      }
    }
    knownEventIds = new Set();
    loadFeed();
    updateRecordingTarget();
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
  // Flush buffer immediately so the note appears in storage right away
  await send({ type: 'session:flush' });
}

$('#btn-add-note').addEventListener('click', addNote);
$('#btn-add-note').disabled = true;
$('#note-input').addEventListener('input', () => {
  $('#btn-add-note').disabled = !$('#note-input').value.trim();
});
$('#note-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addNote();
});

// Persistent tab-capture stream, kept alive for the whole recording session.
// Opened while the recording tab is active (so chrome.tabCapture accepts the
// request); reused for every screenshot + any video recording so Capture keeps
// working after the user switches tabs.
let sessionStream = null;

async function openSessionStream() {
  if (sessionStream && sessionStream.getTracks().some(t => t.readyState === 'live')) {
    return sessionStream;
  }
  sessionStream = null;

  const streamReq = await send({ type: 'video:streamId' });
  if (streamReq?.error) throw new Error(streamReq.error);

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamReq.streamId,
      },
    },
  });

  // If Chrome's "Stop sharing" UI, a tab close, or a discard kills the stream,
  // drop our ref, save any in-progress video clip, and notify the user. The SW
  // separately auto-stops the session on tab close/discard.
  stream.getTracks().forEach(t => {
    t.addEventListener('ended', () => {
      if (sessionStream !== stream) return;
      sessionStream = null;
      showToast('Recording tab ended — capture stream closed', 'warn');
      if (videoRecorder && videoRecorder.state === 'recording') {
        // Fire-and-forget: persists the partial clip via the existing onstop path
        stopVideoRecording().catch(err => console.error('[Debug Helper] Stop video on stream end failed:', err));
      }
      updateRecordingTarget();
    });
  });

  sessionStream = stream;
  return stream;
}

function closeSessionStream() {
  if (sessionStream) {
    sessionStream.getTracks().forEach(t => t.stop());
    sessionStream = null;
  }
}

// Render a single frame from the given MediaStream to a PNG data URL.
async function grabFrameFromStream(stream) {
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  await video.play();
  if (video.readyState < 2) {
    await new Promise((resolve, reject) => {
      video.addEventListener('loadeddata', resolve, { once: true });
      video.addEventListener('error', () => reject(new Error('video load failed')), { once: true });
    });
  }
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  video.pause();
  video.srcObject = null;
  return canvas.toDataURL('image/png');
}

// Feed capture screenshot button
$('#btn-feed-capture').addEventListener('click', async () => {
  const btn = $('#btn-feed-capture');
  btn.disabled = true;
  btn.textContent = '...';
  try {
    if (!activeSessionId) {
      showToast('Start a recording before capturing', 'warn');
      btn.textContent = 'Capture';
      return;
    }
    if (!sessionStream) {
      // Session likely started outside the sidepanel (popup/keyboard), or the
      // stream died — try to open one now while this click gesture is fresh.
      try { await openSessionStream(); } catch (err) {
        showToast('Capture unavailable: ' + (err?.message || 'stream closed') + ' — switch to the recording tab and retry', 'error');
        btn.textContent = 'Failed';
        setTimeout(() => { btn.textContent = 'Capture'; }, 1500);
        updateRecordingTarget();
        return;
      }
    }
    const dataUrl = await grabFrameFromStream(sessionStream);
    const result = await send({ type: 'screenshot:saveDataUrl', dataUrl });
    if (result?.error) {
      showToast('Capture failed: ' + result.error, 'error');
      btn.textContent = 'Failed';
      setTimeout(() => { btn.textContent = 'Capture'; }, 1500);
      return;
    }
    knownEventIds = new Set();
    loadFeed();
    btn.textContent = 'Capture';
  } catch (err) {
    console.error('[Debug Helper] Screenshot capture failed:', err);
    showToast('Capture failed: ' + (err?.message || 'unknown error'), 'error');
    btn.textContent = 'Failed';
    setTimeout(() => { btn.textContent = 'Capture'; }, 1500);
  } finally {
    btn.disabled = false;
  }
});

// Video recording
let videoRecorder = null;
let videoChunks = [];
let videoSessionId = null; // capture session ID at recording start

async function startVideoRecording() {
  const btn = $('#btn-video');
  if (!activeSessionId) {
    showToast('Start a recording before capturing video', 'warn');
    btn.textContent = 'Record first';
    setTimeout(() => { btn.textContent = 'Video'; }, 1500);
    return;
  }
  try {
    if (!sessionStream) {
      try { await openSessionStream(); } catch (err) {
        showToast('Video failed: ' + (err?.message || 'stream closed') + ' — switch to the recording tab and retry', 'error');
        btn.textContent = 'Failed';
        setTimeout(() => { btn.textContent = 'Video'; }, 1500);
        updateRecordingTarget();
        return;
      }
    }
    videoChunks = [];
    videoSessionId = currentSessionId;
    videoRecorder = new MediaRecorder(sessionStream, { mimeType: 'video/webm;codecs=vp9' });
    videoRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) videoChunks.push(e.data);
    };
    videoRecorder.onstop = async () => {
      const blob = new Blob(videoChunks, { type: 'video/webm' });
      videoChunks = [];
      const videoId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      // Save video blob directly to IndexedDB from sidepanel
      try {
        const db = await openMediaDB();
        await new Promise((resolve, reject) => {
          const tx = db.transaction('screenshots', 'readwrite');
          tx.objectStore('screenshots').put({
            id: videoId,
            sessionId: videoSessionId,
            mediaType: 'video',
            videoBlob: blob,
            timestamp: Date.now()
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch (err) {
        console.error('[Debug Helper] Failed to save video:', err);
      }
      // Refresh cache BEFORE writing event so renderEvent can find the video blob
      const sid = videoSessionId;
      if (sid) {
        cachedScreenshots = await getMediaFromDB(sid);
        renderGallery(cachedScreenshots);

        const videoEvent = {
          type: 'event:video',
          content: `Video recorded (${(blob.size / 1024 / 1024).toFixed(1)} MB)`,
          videoId,
          timestamp: Date.now(),
          _sessionId: sid
        };
        // Prefer writing through the service worker to avoid racing with flushBuffer.
        // Only fall back to a direct storage write if the SW is genuinely unreachable.
        try {
          const result = await send(videoEvent);
          if (!result?.buffered) {
            // SW accepted but didn't buffer (session already stopped) — request a flush
            await send({ type: 'session:flush' });
          }
        } catch {
          // SW unavailable — write directly as a last resort
          const allKeys = await chrome.storage.local.get(null);
          let lastChunk = 0;
          for (const k in allKeys) {
            if (k.startsWith('events:' + sid + ':')) {
              const idx = parseInt(k.split(':')[2], 10);
              if (idx > lastChunk) lastChunk = idx;
            }
          }
          const chunkKey = `events:${sid}:${lastChunk}`;
          const freshData = await chrome.storage.local.get(chunkKey);
          const existing = freshData[chunkKey] || [];
          existing.push(videoEvent);
          await chrome.storage.local.set({ [chunkKey]: existing });
        }
      }
    };
    videoRecorder.start(1000); // collect in 1s chunks
    btn.textContent = 'Stop';
    btn.classList.add('recording-video');
  } catch (err) {
    console.error('[Debug Helper] Video recording failed:', err);
    showToast('Video failed: ' + (err?.message || 'unknown error'), 'error');
    btn.textContent = 'Failed';
    setTimeout(() => { btn.textContent = 'Video'; }, 1500);
  }
}

// Returns a promise that resolves after onstop handler completes.
// NOTE: does NOT stop sessionStream tracks — the stream persists for the rest
// of the session so subsequent screenshots / video clips keep working.
function stopVideoRecording() {
  const btn = $('#btn-video');
  btn.textContent = 'Saving...';
  btn.classList.remove('recording-video');
  return new Promise((resolve) => {
    if (videoRecorder && videoRecorder.state !== 'inactive') {
      const origOnStop = videoRecorder.onstop;
      videoRecorder.onstop = async (e) => {
        if (origOnStop) await origOnStop(e);
        videoRecorder = null;
        btn.textContent = 'Video';
        resolve();
      };
      videoRecorder.stop();
    } else {
      videoRecorder = null;
      btn.textContent = 'Video';
      resolve();
    }
  });
}

$('#btn-video').addEventListener('click', () => {
  if (videoRecorder && videoRecorder.state === 'recording') {
    stopVideoRecording();
  } else {
    startVideoRecording();
  }
});

// Render gallery from media array (screenshots + videos)
function renderGallery(mediaItems) {
  const gallery = $('#gallery');
  revokeGalleryBlobUrls();
  gallery.innerHTML = '';
  mediaItems.forEach(s => {
    if (s.mediaType === 'video' && s.videoBlob) {
      // Video item
      const wrapper = document.createElement('div');
      wrapper.className = 'gallery-video';
      const video = document.createElement('video');
      video.src = trackGalleryBlobUrl(s.videoBlob);
      video.controls = true;
      video.preload = 'metadata';
      video.title = new Date(s.timestamp).toLocaleString();
      // Action buttons
      const actions = document.createElement('div');
      actions.className = 'gallery-video-actions';
      // Open in popup
      const openBtn = document.createElement('button');
      openBtn.className = 'btn btn-sm btn-primary';
      openBtn.textContent = 'Open';
      openBtn.addEventListener('click', () => {
        const blobUrl = URL.createObjectURL(s.videoBlob);
        const w = window.open('', '_blank', 'width=900,height=700');
        w.document.title = 'Debug Helper - Video';
        w.document.body.style.cssText = 'margin:0;background:#000;display:flex;align-items:center;justify-content:center;height:100vh';
        const v = w.document.createElement('video');
        v.src = blobUrl;
        v.controls = true;
        v.autoplay = true;
        v.style.maxWidth = '100%';
        v.style.maxHeight = '100%';
        w.document.body.appendChild(v);
      });
      // Download
      const dlBtn = document.createElement('button');
      dlBtn.className = 'btn btn-sm';
      dlBtn.textContent = 'Download';
      dlBtn.addEventListener('click', () => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(s.videoBlob);
        const ts = new Date(s.timestamp).toISOString().replace(/[:.]/g, '-').slice(0, 19);
        a.download = `debug-video-${ts}.webm`;
        a.click();
      });
      actions.appendChild(openBtn);
      actions.appendChild(dlBtn);
      wrapper.appendChild(video);
      wrapper.appendChild(actions);
      gallery.appendChild(wrapper);
    } else {
      // Screenshot item
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
    }
  });
}

// Open IndexedDB with store creation to avoid missing-store errors.
// NOTE: DB name ('debug-helper'), version (1), and store ('screenshots') must match
// the values in lib/storage.js (Storage.DB_NAME / DB_VERSION / STORE_SCREENSHOTS).
// Bumping the version here requires a coordinated change there too.
function openMediaDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('debug-helper', 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('screenshots')) {
        db.createObjectStore('screenshots', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Read media directly from IndexedDB (blobs can't survive chrome.runtime.sendMessage).
// TODO: add a `sessionId` index on the screenshots store and use index.getAll(sessionId)
// to avoid the full-table scan. Requires a DB version bump coordinated with lib/storage.js.
// Fine for typical usage (<100 media items per session).
async function getMediaFromDB(sessionId) {
  const db = await openMediaDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('screenshots', 'readonly');
    const req = tx.objectStore('screenshots').getAll();
    req.onsuccess = () => {
      resolve(req.result.filter(s => s.sessionId === sessionId).sort((a, b) => a.timestamp - b.timestamp));
    };
    req.onerror = () => reject(req.error);
  });
}

async function loadScreenshots() {
  if (!currentSessionId) return;
  cachedScreenshots = await getMediaFromDB(currentSessionId);
  renderGallery(cachedScreenshots);
}

// View a specific session (from history click)
function viewSession(sessionId) {
  currentSessionId = sessionId;
  viewingHistorical = sessionId !== activeSessionId;
  knownEventIds = new Set(); // force full reload
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

  // Refresh media cache before rendering (read directly from IndexedDB to preserve blobs)
  cachedScreenshots = await getMediaFromDB(sid);
  events.sort((a, b) => a.timestamp - b.timestamp);
  const feed = $('#feed');
  revokeFeedBlobUrls();
  feed.innerHTML = '';
  events.forEach(ev => feed.appendChild(renderEvent(ev)));
  if (autoScroll) $('#tab-feed').scrollTop = $('#tab-feed').scrollHeight;
  knownEventIds = new Set(events.map(eventKey));
  applyFilter();
  renderGallery(cachedScreenshots);
}

async function loadScreenshotsForSession(sessionId) {
  if (!sessionId) return;
  cachedScreenshots = await getMediaFromDB(sessionId);
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
          <div class="url" title="${escHtml(s.url)}">${escHtml(s.url)}</div>
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
      if (clean.debugReport) {
        delete clean.debugReport._screenshotFiles;
        delete clean.debugReport._videoFiles;
      }
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
    const result = await send({ type: 'export:generate', sessionId: sid, format: 'markdown', filters: getExportFilters() });
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
  knownEventIds = new Set();
  revokeAllBlobUrls();
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

// Event-driven feed updates via storage change listener
chrome.storage.onChanged.addListener((changes) => {
  const sid = currentSessionId;

  // Append new events to feed reactively (no full re-render)
  if (sid) {
    for (const key of Object.keys(changes)) {
      if (key.startsWith('events:' + sid + ':') && changes[key].newValue) {
        const newEvents = changes[key].newValue;
        // Only process events we haven't seen (compare with oldValue)
        const oldEvents = changes[key].oldValue || [];
        const added = newEvents.slice(oldEvents.length);
        if (added.length > 0) {
          const feed = $('#feed');
          let hasScreenshot = false;
          let appendedAny = false;
          added.forEach(ev => {
            const k = eventKey(ev);
            if (knownEventIds.has(k)) return; // skip duplicates
            knownEventIds.add(k);
            feed.appendChild(renderEvent(ev));
            appendedAny = true;
            if (ev.type === 'event:screenshot' || ev.type === 'event:video') hasScreenshot = true;
          });
          if (!appendedAny) continue;
          applyFilter();
          if (autoScroll) $('#tab-feed').scrollTop = $('#tab-feed').scrollHeight;
          // Refresh gallery when new media events arrive
          if (hasScreenshot) loadScreenshots();
        }
      }
    }
  }

  // Refresh session state on session changes
  if (Object.keys(changes).some(k => k.startsWith('session:') || k === 'currentSessionId')) {
    loadSessionState();
    loadHistory();
    loadScreenshots();
  }
});

// Lightweight session state update (no feed re-render)
async function loadSessionState() {
  let state;
  try { state = await send({ type: 'session:get' }); } catch { return; }
  const statusEl = $('#status');
  const noteBar = $('#note-bar');
  const onFeedTab = document.querySelector('.tab[data-tab="feed"]')?.classList.contains('active');

  if (state.recording) {
    statusEl.textContent = 'Recording';
    statusEl.className = 'status-badge recording';
    activeSessionId = state.session.id;
    if (currentSessionId !== state.session.id) {
      currentSessionId = state.session.id;
      viewingHistorical = false;
      knownEventIds = new Set();
      revokeFeedBlobUrls();
      $('#feed').innerHTML = '';
      // Auto-enable auto-scroll when new recording starts
      autoScroll = true;
      const scrollBtn = $('#btn-autoscroll');
      scrollBtn.textContent = 'Auto ↓';
      scrollBtn.classList.remove('paused');
    }
    if (onFeedTab) noteBar.classList.remove('hidden');
  } else if (state.session) {
    noteBar.classList.add('hidden');
    if (activeSessionId && activeSessionId === state.session.id && state.session.endTime) {
      statusEl.textContent = 'Session ended';
      statusEl.className = 'status-badge';
      activeSessionId = null;
      loadHistory();
    } else if (!viewingHistorical) {
      statusEl.textContent = state.session.endTime ? 'Last session' : 'Idle';
      statusEl.className = 'status-badge';
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
  updateRecordingTarget();
}

// Cleanup on sidepanel close — stop the session capture stream (video recording
// data in progress will be lost, but the stream won't leak) and revoke blob URLs.
window.addEventListener('beforeunload', () => {
  closeSessionStream();
  revokeAllBlobUrls();
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
