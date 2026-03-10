const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const container = document.getElementById('container');
const params = new URLSearchParams(location.search);
const screenshotId = params.get('id');

let image = null;
let tool = 'rect';
let color = '#e53e3e';
let lineWidth = 3;
let annotations = []; // each has: tool, color, lineWidth, visible, ...
let drawing = false;
let startX, startY;
let freehandPoints = [];
let cropRect = null;

// Undo stack — stores snapshots of { annotations, imageDataUrl }
let undoStack = [];
const MAX_UNDO = 30;

function pushUndo() {
  undoStack.push({
    annotations: JSON.parse(JSON.stringify(annotations)),
    imageDataUrl: image ? image.src : null,
    canvasW: canvas.width,
    canvasH: canvas.height,
  });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

function popUndo() {
  if (undoStack.length === 0) return false;
  const state = undoStack.pop();
  annotations = state.annotations;
  selectedIndex = -1;

  if (state.imageDataUrl && state.imageDataUrl !== image.src) {
    // Image changed (e.g. after crop) — restore it
    const img = new Image();
    img.onload = () => {
      image = img;
      canvas.width = img.width;
      canvas.height = img.height;
      fitToWindow();
      redraw();
      renderLayers();
    };
    img.src = state.imageDataUrl;
    return true;
  }

  redraw();
  renderLayers();
  return true;
}

// Counter
let counterNext = 1;

// Zoom
let zoom = 1, fitZoom = 1;

// Selection
let selectedIndex = -1;
let dragOffsetX = 0, dragOffsetY = 0;
let resizing = false;
let resizeCorner = ''; // 'tl','tr','bl','br'
const HANDLE_SIZE = 8;

// --- Helpers ---
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

function isLightColor(hex) {
  const c = hex.replace('#', '');
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 160;
}

function toolIcon(t) {
  return { rect: '▭', arrow: '↗', text: 'T', freehand: '✎', crop: '⊞', counter: '#' }[t] || '?';
}

function toolLabel(a) {
  if (a.tool === 'rect') return a.label || 'Rectangle';
  if (a.tool === 'arrow') return 'Arrow';
  if (a.tool === 'text') return `"${(a.text || '').slice(0, 15)}"`;
  if (a.tool === 'freehand') return 'Freehand';
  if (a.tool === 'counter') return `#${a.number}`;
  return a.tool;
}

// --- Zoom ---
function applyZoom() {
  canvas.style.width = (canvas.width * zoom) + 'px';
  canvas.style.height = (canvas.height * zoom) + 'px';
  $('#zoom-level').textContent = Math.round(zoom * 100) + '%';
}

function fitToWindow() {
  if (!image) return;
  const cw = container.clientWidth - 24;
  const ch = container.clientHeight - 24;
  fitZoom = Math.min(cw / image.width, ch / image.height, 1);
  zoom = fitZoom;
  applyZoom();
}

$('#btn-zoom-in').addEventListener('click', () => { zoom = Math.min(zoom * 1.25, 3); applyZoom(); });
$('#btn-zoom-out').addEventListener('click', () => { zoom = Math.max(zoom / 1.25, 0.1); applyZoom(); });
$('#btn-zoom-fit').addEventListener('click', fitToWindow);

container.addEventListener('wheel', (e) => {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    zoom = Math.max(0.1, Math.min(3, zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
    applyZoom();
  }
}, { passive: false });

// --- DB ---
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('debug-helper', 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('screenshots'))
        db.createObjectStore('screenshots', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function load() {
  const db = await openDB();
  const tx = db.transaction('screenshots', 'readonly');
  const req = tx.objectStore('screenshots').get(screenshotId);
  req.onsuccess = () => {
    const entry = req.result;
    if (!entry) return;
    annotations = (entry.annotations || []).map(a => ({ ...a, visible: a.visible !== false }));
    // Resume counter from highest existing number
    const maxNum = annotations.filter(a => a.tool === 'counter').reduce((m, a) => Math.max(m, a.number || 0), 0);
    if (maxNum >= counterNext) counterNext = maxNum + 1;
    const img = new Image();
    img.onload = () => {
      image = img;
      canvas.width = img.width;
      canvas.height = img.height;
      fitToWindow();
      redraw();
      renderLayers();
    };
    img.src = entry.dataUrl;
  };
}

// --- Drawing ---
function redraw() {
  if (!image) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0);

  annotations.forEach((a, i) => {
    if (a.visible === false) return;
    const isSelected = i === selectedIndex;
    ctx.strokeStyle = a.color;
    ctx.lineWidth = a.lineWidth;
    ctx.fillStyle = a.color;

    if (a.tool === 'rect') {
      if (a.dashed) ctx.setLineDash([6, 4]);
      ctx.strokeRect(a.x, a.y, a.w, a.h);
      ctx.setLineDash([]);
      if (a.label) {
        ctx.font = 'bold 14px sans-serif';
        ctx.strokeStyle = isLightColor(a.color) ? '#000' : '#fff';
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.strokeText(a.label, a.x, a.y - 4);
        ctx.fillStyle = a.color;
        ctx.fillText(a.label, a.x, a.y - 4);
      }
    } else if (a.tool === 'arrow') {
      drawArrow(a.x, a.y, a.x2, a.y2, a.color, a.lineWidth);
    } else if (a.tool === 'text') {
      const fs = a.fontSize || 32;
      ctx.font = `bold ${fs}px sans-serif`;
      // Outline for readability on any background
      ctx.strokeStyle = isLightColor(a.color) ? '#000' : '#fff';
      ctx.lineWidth = Math.max(2, fs / 10);
      ctx.lineJoin = 'round';
      ctx.strokeText(a.text, a.x, a.y);
      ctx.fillText(a.text, a.x, a.y);
    } else if (a.tool === 'freehand' && a.points && a.points.length > 1) {
      ctx.beginPath();
      ctx.moveTo(a.points[0][0], a.points[0][1]);
      for (let j = 1; j < a.points.length; j++) ctx.lineTo(a.points[j][0], a.points[j][1]);
      ctx.stroke();
    } else if (a.tool === 'counter') {
      const r = a.radius || 20;
      const num = String(a.number);
      // Filled circle
      ctx.beginPath();
      ctx.arc(a.x, a.y, r, 0, Math.PI * 2);
      ctx.fillStyle = a.color;
      ctx.fill();
      // Border
      ctx.strokeStyle = isLightColor(a.color) ? '#000' : '#fff';
      ctx.lineWidth = Math.max(2, r * 0.1);
      ctx.stroke();
      // Number text
      ctx.fillStyle = isLightColor(a.color) ? '#000' : '#fff';
      ctx.font = `bold ${Math.round(r * 1.1)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(num, a.x, a.y + 1);
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
    }

    // Selection outline + resize handles
    if (isSelected) {
      const b = getBounds(a);
      if (b) {
        ctx.save();
        ctx.strokeStyle = '#2563eb';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8);
        ctx.setLineDash([]);
        ctx.fillStyle = '#2563eb';
        for (const [hx, hy] of getHandlePositions(b)) {
          ctx.fillRect(hx - HANDLE_SIZE / 2, hy - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
        }
        ctx.restore();
      }
    }
  });
}

function getBounds(a) {
  if (a.tool === 'rect') {
    // Normalize negative w/h
    const x = a.w < 0 ? a.x + a.w : a.x;
    const y = a.h < 0 ? a.y + a.h : a.y;
    return { x, y, w: Math.abs(a.w), h: Math.abs(a.h) };
  }
  if (a.tool === 'arrow') {
    const { cx, cy } = getArrowCurve(a.x, a.y, a.x2, a.y2);
    const minX = Math.min(a.x, a.x2, cx), minY = Math.min(a.y, a.y2, cy);
    const maxX = Math.max(a.x, a.x2, cx), maxY = Math.max(a.y, a.y2, cy);
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  if (a.tool === 'text') {
    const fs = a.fontSize || 32;
    return { x: a.x, y: a.y - fs, w: (a.text || '').length * fs * 0.65, h: fs * 1.3 };
  }
  if (a.tool === 'freehand' && a.points && a.points.length > 0) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [px, py] of a.points) {
      if (px < minX) minX = px; if (py < minY) minY = py;
      if (px > maxX) maxX = px; if (py > maxY) maxY = py;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  if (a.tool === 'counter') {
    const r = a.radius || 20;
    return { x: a.x - r, y: a.y - r, w: r * 2, h: r * 2 };
  }
  return null;
}

function getHandlePositions(b) {
  return [
    [b.x, b.y],                     // tl
    [b.x + b.w, b.y],               // tr
    [b.x, b.y + b.h],               // bl
    [b.x + b.w, b.y + b.h],         // br
  ];
}

function hitHandle(x, y) {
  if (selectedIndex < 0) return '';
  const b = getBounds(annotations[selectedIndex]);
  if (!b) return '';
  const corners = ['tl', 'tr', 'bl', 'br'];
  const positions = getHandlePositions(b);
  for (let i = 0; i < 4; i++) {
    const [hx, hy] = positions[i];
    if (Math.abs(x - hx) < HANDLE_SIZE && Math.abs(y - hy) < HANDLE_SIZE) return corners[i];
  }
  return '';
}

function hitTest(x, y) {
  for (let i = annotations.length - 1; i >= 0; i--) {
    if (annotations[i].visible === false) continue;
    const b = getBounds(annotations[i]);
    if (b && x >= b.x - 8 && x <= b.x + b.w + 8 && y >= b.y - 8 && y <= b.y + b.h + 8) return i;
  }
  return -1;
}

function getArrowCurve(x1, y1, x2, y2) {
  // Compute a perpendicular offset for a natural arc
  const dx = x2 - x1, dy = y2 - y1;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;
  // Curve bulge: ~15% of distance, perpendicular to the line
  const bulge = dist * 0.15;
  const mx = (x1 + x2) / 2 - (dy / dist) * bulge;
  const my = (y1 + y2) / 2 + (dx / dist) * bulge;
  return { cx: mx, cy: my };
}

function drawArrow(x1, y1, x2, y2, col, lw) {
  const { cx, cy } = getArrowCurve(x1, y1, x2, y2);
  const dist = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2) || 1;

  // Scale head to line width and distance
  const headLen = Math.max(14, Math.min(28, dist * 0.08)) + lw;
  const headAngle = 0.4;

  // Tangent angle at endpoint (derivative of quadratic bezier at t=1)
  const angle = Math.atan2(y2 - cy, x2 - cx);

  // Draw curved shaft
  ctx.strokeStyle = col;
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.quadraticCurveTo(cx, cy, x2, y2);
  ctx.stroke();

  // Filled arrowhead
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headLen * Math.cos(angle - headAngle), y2 - headLen * Math.sin(angle - headAngle));
  ctx.lineTo(x2 - headLen * 0.6 * Math.cos(angle), y2 - headLen * 0.6 * Math.sin(angle));
  ctx.lineTo(x2 - headLen * Math.cos(angle + headAngle), y2 - headLen * Math.sin(angle + headAngle));
  ctx.closePath();
  ctx.fill();
}

function canvasCoords(e) {
  const rect = canvas.getBoundingClientRect();
  return [(e.clientX - rect.left) * canvas.width / rect.width, (e.clientY - rect.top) * canvas.height / rect.height];
}

// --- Layers panel ---
function renderLayers() {
  const list = $('#layers-list');
  list.innerHTML = '';
  // Render top-to-bottom (last annotation = top layer)
  for (let i = annotations.length - 1; i >= 0; i--) {
    const a = annotations[i];
    const div = document.createElement('div');
    div.className = 'layer-item' + (i === selectedIndex ? ' selected' : '');
    div.dataset.index = i;
    div.innerHTML = `
      <span class="layer-icon">${toolIcon(a.tool)}</span>
      <span class="layer-label">${toolLabel(a)}</span>
      <span class="layer-vis ${a.visible === false ? 'hidden-layer' : ''}" data-idx="${i}" title="Toggle visibility">&#9673;</span>
    `;
    div.addEventListener('click', (e) => {
      if (e.target.classList.contains('layer-vis')) return;
      selectAnnotation(i);
    });
    div.addEventListener('dblclick', (e) => {
      if (e.target.classList.contains('layer-vis')) return;
      editAnnotation(i);
    });
    list.appendChild(div);
  }

  // Visibility toggles
  $$('.layer-vis').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(el.dataset.idx);
      annotations[idx].visible = annotations[idx].visible === false ? true : false;
      redraw();
      renderLayers();
    });
  });

  updateLayerButtons();
}

function selectAnnotation(idx) {
  selectedIndex = idx;
  tool = 'select';
  $$('.tool-btn').forEach(b => b.classList.remove('active'));
  $('[data-tool="select"]').classList.add('active');
  updateCursor();
  // Sync color/width to selected
  if (idx >= 0) {
    const a = annotations[idx];
    $('#color').value = a.color || '#e53e3e';
    color = a.color;
    if (a.lineWidth) {
      $('#lineWidth').value = a.lineWidth;
      lineWidth = a.lineWidth;
    }
  }
  redraw();
  renderLayers();
}

function editAnnotation(idx) {
  const a = annotations[idx];
  if (a.tool === 'text') {
    const newText = prompt('Edit text:', a.text);
    if (newText !== null) { a.text = newText; a.label = newText; redraw(); renderLayers(); }
  } else if (a.tool === 'rect') {
    const newLabel = prompt('Edit label:', a.label || '');
    if (newLabel !== null) { a.label = newLabel; redraw(); renderLayers(); }
  }
}

function updateLayerButtons() {
  const has = selectedIndex >= 0;
  $('#btn-layer-up').disabled = !has || selectedIndex >= annotations.length - 1;
  $('#btn-layer-down').disabled = !has || selectedIndex <= 0;
  $('#btn-layer-delete').disabled = !has;
}

$('#btn-layer-up').addEventListener('click', () => {
  if (selectedIndex < 0 || selectedIndex >= annotations.length - 1) return;
  [annotations[selectedIndex], annotations[selectedIndex + 1]] = [annotations[selectedIndex + 1], annotations[selectedIndex]];
  selectedIndex++;
  redraw(); renderLayers();
});

$('#btn-layer-down').addEventListener('click', () => {
  if (selectedIndex <= 0) return;
  [annotations[selectedIndex], annotations[selectedIndex - 1]] = [annotations[selectedIndex - 1], annotations[selectedIndex]];
  selectedIndex--;
  redraw(); renderLayers();
});

$('#btn-layer-delete').addEventListener('click', () => {
  if (selectedIndex < 0) return;
  pushUndo();
  annotations.splice(selectedIndex, 1);
  selectedIndex = -1;
  redraw(); renderLayers();
});

$('#btn-toggle-layers').addEventListener('click', () => {
  $('#layers-panel').classList.add('collapsed');
  $('#btn-reopen-layers').classList.add('visible');
});

$('#btn-reopen-layers').addEventListener('click', () => {
  $('#layers-panel').classList.remove('collapsed');
  $('#btn-reopen-layers').classList.remove('visible');
});

// --- Tool selection ---
$$('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.tool-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    tool = btn.dataset.tool;
    if (tool !== 'select') { selectedIndex = -1; redraw(); renderLayers(); }
    updateCursor();
  });
});

function updateCursor() {
  canvas.className = tool === 'select' ? 'cursor-default' : 'cursor-crosshair';
}

$('#color').addEventListener('input', (e) => {
  color = e.target.value;
  if (selectedIndex >= 0) { annotations[selectedIndex].color = color; redraw(); }
});

$('#lineWidth').addEventListener('change', (e) => {
  lineWidth = parseInt(e.target.value);
  if (selectedIndex >= 0) { annotations[selectedIndex].lineWidth = lineWidth; redraw(); }
});

// --- Mouse events ---
canvas.addEventListener('mousedown', (e) => {
  const [x, y] = canvasCoords(e);

  if (tool === 'select') {
    // Check resize handle first
    const handle = hitHandle(x, y);
    if (handle) {
      resizing = true;
      resizeCorner = handle;
      drawing = true;
      startX = x; startY = y;
      // Capture initial state for smooth resize
      if (selectedIndex >= 0 && annotations[selectedIndex].tool === 'text') {
        resizeStartFontSize = annotations[selectedIndex].fontSize || 16;
        resizeStartY = y;
      }
      return;
    }
    const hit = hitTest(x, y);
    selectAnnotation(hit);
    if (hit >= 0) {
      const b = getBounds(annotations[hit]);
      dragOffsetX = x - b.x;
      dragOffsetY = y - b.y;
      drawing = true;
    }
    return;
  }

  drawing = true;
  startX = x;
  startY = y;
  freehandPoints = [[x, y]];
});

canvas.addEventListener('mousemove', (e) => {
  if (!drawing) {
    // Update cursor for resize handles
    if (tool === 'select') {
      const [x, y] = canvasCoords(e);
      const handle = hitHandle(x, y);
      if (handle) {
        canvas.className = (handle === 'tl' || handle === 'br') ? 'cursor-nwse' : 'cursor-nesw';
        canvas.style.cursor = (handle === 'tl' || handle === 'br') ? 'nwse-resize' : 'nesw-resize';
      } else {
        canvas.style.cursor = '';
        updateCursor();
      }
    }
    return;
  }
  const [x, y] = canvasCoords(e);

  if (tool === 'select' && resizing && selectedIndex >= 0) {
    resizeAnnotation(selectedIndex, resizeCorner, x, y);
    redraw();
    return;
  }

  if (tool === 'select' && selectedIndex >= 0) {
    moveAnnotation(selectedIndex, x - dragOffsetX, y - dragOffsetY);
    redraw();
    return;
  }

  if (tool === 'freehand') {
    freehandPoints.push([x, y]);
    redraw();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(freehandPoints[0][0], freehandPoints[0][1]);
    for (const p of freehandPoints) ctx.lineTo(p[0], p[1]);
    ctx.stroke();
  } else {
    redraw();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    if (tool === 'rect' || tool === 'crop') {
      ctx.setLineDash(tool === 'crop' ? [4, 4] : []);
      ctx.strokeRect(startX, startY, x - startX, y - startY);
      ctx.setLineDash([]);
    } else if (tool === 'arrow') {
      drawArrow(startX, startY, x, y, color, lineWidth);
    }
  }
});

canvas.addEventListener('mouseup', (e) => {
  if (!drawing) return;
  drawing = false;
  resizing = false;
  resizeCorner = '';
  const [endX, endY] = canvasCoords(e);

  if (tool === 'select') { renderLayers(); return; }

  const dx = Math.abs(endX - startX), dy = Math.abs(endY - startY);
  const MIN = 3;

  if (tool === 'rect') {
    if (dx < MIN && dy < MIN) { redraw(); return; }
    pushUndo();
    annotations.push({ tool: 'rect', x: startX, y: startY, w: endX - startX, h: endY - startY, color, lineWidth, type: 'rect', visible: true });
  } else if (tool === 'arrow') {
    if (dx < MIN && dy < MIN) { redraw(); return; }
    pushUndo();
    // Scale arrow thickness to image size — visible on high-res screenshots
    const baseArrowLw = image ? Math.max(4, Math.round(image.width * 0.003)) : 5;
    const arrowLw = Math.max(baseArrowLw, lineWidth * 2);
    annotations.push({ tool: 'arrow', x: startX, y: startY, x2: endX, y2: endY, color, lineWidth: arrowLw, type: 'arrow', visible: true });
  } else if (tool === 'text') {
    const text = prompt('Enter text:');
    if (text) {
      pushUndo();
      const defaultFontSize = image ? Math.max(24, Math.min(64, Math.round(image.width * 0.02))) : 32;
      annotations.push({ tool: 'text', x: startX, y: startY, text, color, fontSize: defaultFontSize, type: 'text', label: text, visible: true });
    }
  } else if (tool === 'freehand') {
    if (freehandPoints.length < 3) { redraw(); return; }
    pushUndo();
    annotations.push({ tool: 'freehand', points: freehandPoints, color, lineWidth, type: 'freehand', visible: true });
  } else if (tool === 'counter') {
    pushUndo();
    const radius = image ? Math.max(16, Math.min(36, Math.round(image.width * 0.015))) : 20;
    annotations.push({ tool: 'counter', x: startX, y: startY, number: counterNext, color, radius, type: 'counter', visible: true });
    counterNext++;
  } else if (tool === 'crop') {
    if (dx < MIN || dy < MIN) { redraw(); return; }
    cropRect = { x: Math.min(startX, endX), y: Math.min(startY, endY), w: dx, h: dy };
    pushUndo();
    applyCrop();
    return;
  }
  // Auto-select the newly created annotation
  selectAnnotation(annotations.length - 1);
});

canvas.addEventListener('mouseleave', () => {
  if (drawing && tool !== 'select') { drawing = false; redraw(); }
});

// --- Move & Resize ---
function moveAnnotation(idx, newX, newY) {
  const a = annotations[idx];
  const b = getBounds(a);
  const dx = newX - b.x, dy = newY - b.y;
  if (a.tool === 'rect') { a.x += dx; a.y += dy; }
  else if (a.tool === 'arrow') { a.x += dx; a.y += dy; a.x2 += dx; a.y2 += dy; }
  else if (a.tool === 'text') { a.x += dx; a.y += dy; }
  else if (a.tool === 'counter') { a.x += dx; a.y += dy; }
  else if (a.tool === 'freehand' && a.points) {
    a.points = a.points.map(([px, py]) => [px + dx, py + dy]);
  }
}

let resizeStartFontSize = 16;
let resizeStartY = 0;

function resizeAnnotation(idx, corner, mx, my) {
  const a = annotations[idx];
  if (a.tool === 'rect') {
    if (corner === 'br') { a.w = mx - a.x; a.h = my - a.y; }
    else if (corner === 'tl') { a.w += a.x - mx; a.h += a.y - my; a.x = mx; a.y = my; }
    else if (corner === 'tr') { a.w = mx - a.x; a.h += a.y - my; a.y = my; }
    else if (corner === 'bl') { a.w += a.x - mx; a.x = mx; a.h = my - a.y; }
  } else if (a.tool === 'arrow') {
    if (corner === 'tl' || corner === 'bl') { a.x = mx; a.y = my; }
    else { a.x2 = mx; a.y2 = my; }
  } else if (a.tool === 'text') {
    // Scale font size relative to drag distance from start
    const delta = my - resizeStartY;
    a.fontSize = Math.max(8, Math.round(resizeStartFontSize + delta * 0.3));
  }
}

function applyCrop() {
  if (!cropRect || !image) return;
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = cropRect.w;
  tempCanvas.height = cropRect.h;
  const tempCtx = tempCanvas.getContext('2d');
  tempCtx.drawImage(canvas, cropRect.x, cropRect.y, cropRect.w, cropRect.h, 0, 0, cropRect.w, cropRect.h);
  const img = new Image();
  img.onload = () => {
    image = img;
    canvas.width = img.width;
    canvas.height = img.height;
    annotations = [];
    selectedIndex = -1;
    fitToWindow();
    redraw();
    renderLayers();
  };
  img.src = tempCanvas.toDataURL('image/png');
  cropRect = null;
}

// --- Buttons ---
$('#btn-error').addEventListener('click', () => {
  pushUndo();
  const padding = 20;
  annotations.push({
    tool: 'rect', x: padding, y: padding,
    w: canvas.width - padding * 2, h: canvas.height - padding * 2,
    color: '#e53e3e', lineWidth: 3, dashed: true, label: 'ERROR', type: 'error-marker', visible: true
  });
  redraw(); renderLayers();
});

$('#btn-undo').addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  popUndo();
});

// Double-click on canvas to edit
canvas.addEventListener('dblclick', (e) => {
  const [x, y] = canvasCoords(e);
  const hit = hitTest(x, y);
  if (hit >= 0) editAnnotation(hit);
});

// --- Keyboard shortcuts ---
document.addEventListener('keydown', (e) => {
  // Don't intercept if typing in an input
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selectedIndex >= 0) {
      pushUndo();
      annotations.splice(selectedIndex, 1);
      selectedIndex = -1;
      redraw(); renderLayers();
    }
  }
  if (e.key === 'Escape') { selectedIndex = -1; redraw(); renderLayers(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    e.preventDefault();
    popUndo();
  }
  // Tool shortcuts
  if (!e.ctrlKey && !e.metaKey) {
    const keyMap = { v: 'select', r: 'rect', a: 'arrow', t: 'text', f: 'freehand', c: 'crop', n: 'counter' };
    if (keyMap[e.key]) {
      tool = keyMap[e.key];
      $$('.tool-btn').forEach(b => b.classList.remove('active'));
      $(`[data-tool="${tool}"]`)?.classList.add('active');
      if (tool !== 'select') { selectedIndex = -1; redraw(); renderLayers(); }
      updateCursor();
    }
  }
});

// --- Save ---
$('#btn-save').addEventListener('click', async () => {
  // Render all visible annotations to get the final image
  const saveAnnotations = annotations.filter(a => a.visible !== false);
  redraw(); // ensure canvas is up to date
  const annotatedDataUrl = canvas.toDataURL('image/png');
  await chrome.runtime.sendMessage({
    type: 'screenshot:save',
    screenshotId,
    annotatedDataUrl,
    annotations: saveAnnotations
  });
  $('#btn-save').textContent = 'Saved!';
  setTimeout(() => $('#btn-save').textContent = 'Save', 1500);
});

updateCursor();
load();
