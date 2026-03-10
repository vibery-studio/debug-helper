const $ = (sel) => document.querySelector(sel);

const btnToggle = $('#btn-toggle');
const btnScreenshot = $('#btn-screenshot');
const btnExportMd = $('#btn-export-md');
const btnExportJson = $('#btn-export-json');
const btnExportToon = $('#btn-export-toon');
const btnSidepanel = $('#btn-sidepanel');
const elStatus = $('#status');
const elStats = $('#stats');
const elEvents = $('#stat-events');
const elDuration = $('#stat-duration');
const elScreenshots = $('#stat-screenshots');
const elSessionsList = $('#sessions-list');

let currentSession = null;
let updateTimer = null;

async function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

async function refresh() {
  const state = await send({ type: 'session:get' });
  currentSession = state.session;
  const recording = state.recording;

  elStatus.textContent = recording ? 'Recording...' : (currentSession ? 'Session ended' : 'Idle');
  elStatus.className = 'status' + (recording ? ' recording' : '');
  btnToggle.textContent = recording ? 'Stop Recording' : 'Start Recording';
  btnToggle.className = 'btn ' + (recording ? 'btn-danger' : 'btn-primary');
  btnScreenshot.disabled = !recording;
  $('#note-bar').classList.toggle('hidden', !recording);

  const hasSession = !!currentSession;
  btnExportMd.disabled = !hasSession;
  btnExportJson.disabled = !hasSession;
  btnExportToon.disabled = !hasSession;
  $('#export-filters').classList.toggle('hidden', !hasSession);

  if (hasSession) {
    elStats.classList.remove('hidden');
    elEvents.textContent = currentSession.eventCount || 0;
    const dur = (currentSession.endTime || Date.now()) - currentSession.startTime;
    elDuration.textContent = dur < 60000 ? Math.round(dur / 1000) + 's' : Math.round(dur / 60000) + 'm';

    const screenshots = await send({ type: 'screenshot:list', sessionId: currentSession.id });
    elScreenshots.textContent = screenshots.length;
  } else {
    elStats.classList.add('hidden');
  }

  // Recent sessions
  const sessions = await send({ type: 'session:list' });
  elSessionsList.innerHTML = '';
  sessions.slice(0, 5).forEach(s => {
    const div = document.createElement('div');
    div.className = 'session-item';
    div.style.cursor = 'pointer';
    const time = new Date(s.startTime).toLocaleString();
    div.innerHTML = `
      <span class="session-url" title="${s.url}">${s.url}</span>
      <span style="font-size:10px;color:var(--text-secondary)">${s.eventCount}ev</span>
    `;
    div.addEventListener('click', async () => {
      // Store the session to view, then open sidepanel
      await chrome.storage.local.set({ viewSessionId: s.id });
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      chrome.sidePanel.open({ tabId: tab.id });
      window.close();
    });
    elSessionsList.appendChild(div);
  });
}

btnToggle.addEventListener('click', async () => {
  if (currentSession && !currentSession.endTime) {
    await send({ type: 'session:stop' });
  } else {
    await send({ type: 'session:start' });
  }
  refresh();
});

btnScreenshot.addEventListener('click', async () => {
  await send({ type: 'screenshot:capture' });
  refresh();
});

// Add note
async function addNote() {
  const input = $('#note-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  await send({ type: 'event:note', content: text, timestamp: Date.now() });
  refresh();
}
$('#btn-add-note').addEventListener('click', addNote);
$('#note-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addNote(); });

let lastPopupExportText = '';

function getFilters() {
  const filters = {};
  document.querySelectorAll('#export-filters input[data-filter]').forEach(cb => {
    filters[cb.dataset.filter] = cb.checked;
  });
  return filters;
}

async function popupExport(format) {
  if (!currentSession) return;
  const btnMap = { markdown: btnExportMd, json: btnExportJson, toon: btnExportToon };
  const btn = btnMap[format];
  btn.textContent = 'Generating...';
  btn.disabled = true;

  try {
    const result = await send({ type: 'export:generate', sessionId: currentSession.id, format, filters: getFilters() });
    if (format === 'markdown') {
      lastPopupExportText = result.markdown;
    } else if (format === 'toon') {
      lastPopupExportText = result.toon;
    } else {
      lastPopupExportText = JSON.stringify(result, null, 2);
    }

    $('#export-preview').textContent = lastPopupExportText;
    const sizeKB = (new Blob([lastPopupExportText]).size / 1024).toFixed(1);
    $('#export-info').textContent = `${format.toUpperCase()} · ${sizeKB} KB`;
    $('#export-result').classList.remove('hidden');
  } finally {
    const labels = { markdown: 'Export Markdown', json: 'Export JSON', toon: 'Export TOON' };
    btn.textContent = labels[format];
    btn.disabled = false;
  }
}

btnExportMd.addEventListener('click', () => popupExport('markdown'));
btnExportJson.addEventListener('click', () => popupExport('json'));
btnExportToon.addEventListener('click', () => popupExport('toon'));

$('#btn-copy-result').addEventListener('click', async () => {
  if (!lastPopupExportText) return;
  try {
    await navigator.clipboard.writeText(lastPopupExportText);
    $('#btn-copy-result').textContent = 'Copied!';
  } catch {
    const range = document.createRange();
    range.selectNodeContents($('#export-preview'));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('copy');
    $('#btn-copy-result').textContent = 'Copied!';
  }
  setTimeout(() => $('#btn-copy-result').textContent = 'Copy', 1500);
});

btnSidepanel.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.sidePanel.open({ tabId: tab.id });
});

// Auto-refresh while recording
refresh();
updateTimer = setInterval(refresh, 2000);
