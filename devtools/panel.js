const elRequests = document.getElementById('requests');
const elCount = document.getElementById('count');
let count = 0;

chrome.devtools.network.onRequestFinished.addListener(async (request) => {
  count++;
  elCount.textContent = `(${count} requests)`;

  const status = request.response.status;
  const method = request.request.method;
  const url = request.request.url;
  const duration = Math.round(request.time * 1000);
  const size = request.response.content.size;
  const mimeType = request.response.content.mimeType;

  const div = document.createElement('div');
  div.className = 'request-item' + (status >= 400 ? ' error' : '');
  div.innerHTML = `
    <span class="status ${status >= 400 ? 'err' : ''}">${status}</span>
    <strong>${method}</strong> ${url.length > 80 ? url.slice(0, 80) + '...' : url}
    <span style="color:var(--text-secondary)">${duration}ms · ${mimeType} · ${size}B</span>
  `;
  elRequests.prepend(div);

  // Send enhanced data for 4xx/5xx to service worker
  if (status >= 400) {
    request.getContent((body) => {
      chrome.runtime.sendMessage({
        type: 'event:network:enhanced',
        timestamp: Date.now(),
        method,
        url,
        status,
        duration,
        size,
        mimeType,
        headers: request.response.headers,
        responseBody: (body || '').slice(0, 10240)
      });
    });
  }
});
