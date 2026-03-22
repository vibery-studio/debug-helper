const Export = {
  MAX_SCREENSHOT_WIDTH: 1200,
  JPEG_QUALITY: 0.7,
  DEDUP_THRESHOLD_MS: 150,

  DEFAULT_FILTERS: {
    steps: true,
    console: true,
    network: true,
    networkErrorsOnly: true,
    screenshots: true,
    dedup: true,
    skipScrollZero: true,
    screenshotAsFile: true,
  },

  async compressScreenshot(dataUrl) {
    try {
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);
      const scale = bitmap.width > this.MAX_SCREENSHOT_WIDTH
        ? this.MAX_SCREENSHOT_WIDTH / bitmap.width : 1;
      const w = Math.round(bitmap.width * scale);
      const h = Math.round(bitmap.height * scale);
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, w, h);
      bitmap.close();
      const jpegBlob = await c.convertToBlob({ type: 'image/jpeg', quality: this.JPEG_QUALITY });
      const buf = await jpegBlob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return 'data:image/jpeg;base64,' + btoa(binary);
    } catch (e) {
      console.warn('[Export] Screenshot compression failed:', e);
      return dataUrl;
    }
  },

  // --- Cleanup passes on raw events ---

  deduplicateClicks(events) {
    const out = [];
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.type !== 'event:dom' || (e.eventType !== 'click' && e.eventType !== 'dblclick')) {
        out.push(e); continue;
      }
      const next = events[i + 1];
      if (next && next.type === 'event:dom'
        && (next.eventType === 'click' || next.eventType === 'dblclick')
        && Math.abs(next.timestamp - e.timestamp) < this.DEDUP_THRESHOLD_MS) {
        const eText = e.context?.text?.length || 0;
        const nText = next.context?.text?.length || 0;
        if (nText > eText) { out.push(next); } else { out.push(e); }
        i++;
      } else {
        out.push(e);
      }
    }
    return out;
  },

  filterScrollZero(events) {
    return events.filter(e => {
      if (e.type !== 'event:dom' || e.eventType !== 'scroll') return true;
      return e.value !== '0' && e.value !== 0;
    });
  },

  // --- Helpers for compact output ---

  relativeTime(timestamp, startTime) {
    const delta = timestamp - startTime;
    if (delta < 1000) return `+${delta}ms`;
    return `+${(delta / 1000).toFixed(1)}s`;
  },

  // Human-readable description of a step action
  describeStep(step) {
    const ctx = step.context || {};
    const label = ctx.text || ctx.ariaLabel || '';
    const shortLabel = label.length > 60 ? label.slice(0, 57) + '...' : label;

    switch (step.action) {
      case 'click':
      case 'dblclick': {
        const what = shortLabel
          ? `"${shortLabel}"`
          : (ctx.tag || step.selector);
        return `${step.action === 'dblclick' ? 'Double-clicked' : 'Clicked'} ${what}`;
      }
      case 'input':
        return `Typed "${step.value || ''}" in ${shortLabel || ctx.tag || step.selector}`;
      case 'change':
        return `Set ${shortLabel || ctx.tag || step.selector} to "${step.value || ''}"`;
      case 'submit':
        return `Submitted ${shortLabel || ctx.tag || 'form'}`;
      case 'scroll':
        return `Scrolled to y=${step.value}`;
      case 'note':
        return `📝 ${step.content || ''}`;
      default:
        return `${step.action} on ${shortLabel || step.selector}`;
    }
  },

  // Auto-generate a brief narrative summary from steps
  generateSummary(steps, session) {
    if (!steps || steps.length === 0) return '';

    const actions = [];
    let lastUrl = session.url;

    for (const s of steps) {
      // Track navigations
      if (s.url && s.url !== lastUrl) {
        const path = s.url.replace(/https?:\/\/[^/]+/, '');
        actions.push(`Navigated to ${path}`);
        lastUrl = s.url;
      }

      const ctx = s.context || {};
      const label = ctx.text || ctx.ariaLabel || '';
      const shortLabel = label.length > 40 ? label.slice(0, 37) + '...' : label;

      if (s.action === 'click' || s.action === 'dblclick') {
        if (shortLabel) actions.push(`Clicked "${shortLabel}"`);
      } else if (s.action === 'input' || s.action === 'change') {
        if (s.value) actions.push(`Entered "${s.value}"`);
      } else if (s.action === 'submit') {
        actions.push('Submitted form');
      } else if (s.action === 'note') {
        actions.push(`Note: "${s.content}"`);
      }
    }

    // Deduplicate consecutive similar actions and limit
    const unique = [];
    for (const a of actions) {
      if (unique.length === 0 || unique[unique.length - 1] !== a) unique.push(a);
    }
    return unique.slice(0, 8).join('. ') + '.';
  },

  async generateJSON(sessionId, filters) {
    const f = { ...this.DEFAULT_FILTERS, ...filters };
    const session = await Storage.getSession(sessionId);
    if (!session) return null;
    let events = await Storage.getEvents(sessionId);
    const screenshots = f.screenshots ? await Storage.getScreenshots(sessionId) : [];

    // Apply cleanup passes
    if (f.dedup) events = this.deduplicateClicks(events);
    if (f.skipScrollZero) events = this.filterScrollZero(events);

    // Build screenshot lookup
    const screenshotMap = {};
    const screenshotEntries = [];
    let ssIdx = 0;
    for (const s of screenshots) {
      ssIdx++;
      const src = s.annotatedDataUrl || s.dataUrl;
      const compressed = await this.compressScreenshot(src);
      const entry = {
        id: s.id,
        index: ssIdx,
        timestamp: new Date(s.timestamp).toISOString(),
        annotations: (s.annotations || []).map(a => ({
          type: a.type || a.tool,
          label: a.label || a.text || ''
        })).filter(a => a.label),
        _dataUrl: compressed,
      };
      screenshotMap[s.id] = entry;
      screenshotEntries.push(entry);
    }

    // Build unified timeline
    const timeline = [];
    let stepNum = 0;
    let lastUrl = session.url;
    for (const e of events) {
      if (e.type === 'event:note' && f.steps) {
        stepNum++;
        timeline.push({
          kind: 'step', step: stepNum,
          t: this.relativeTime(e.timestamp, session.startTime),
          action: 'note',
          content: e.content,
        });
      } else if (e.type === 'event:dom' && f.steps) {
        stepNum++;
        const step = {
          kind: 'step', step: stepNum,
          t: this.relativeTime(e.timestamp, session.startTime),
          action: e.eventType,
          selector: e.selector,
          context: e.context || undefined,
          value: e.value || undefined,
        };
        // Only include url when it changed (navigation)
        if (e.url && e.url !== lastUrl) {
          step.url = e.url;
          lastUrl = e.url;
        }
        timeline.push(step);
      } else if (e.type === 'event:screenshot' && f.screenshots && screenshotMap[e.screenshotId]) {
        const ss = screenshotMap[e.screenshotId];
        ss.afterStep = stepNum || null;
        timeline.push({ kind: 'screenshot', screenshotIndex: ss.index, afterStep: stepNum || null, timestamp: ss.timestamp });
      }
    }

    const report = {
      title: session.title || undefined,
      url: session.url,
      startTime: new Date(session.startTime).toISOString(),
      endTime: session.endTime ? new Date(session.endTime).toISOString() : null,
      duration: session.endTime ? session.endTime - session.startTime : Date.now() - session.startTime,
    };

    // Step → screenshot cross-refs
    const stepScreenshotRefs = {};
    for (const t of timeline) {
      if (t.kind === 'screenshot' && t.afterStep) {
        if (!stepScreenshotRefs[t.afterStep]) stepScreenshotRefs[t.afterStep] = [];
        stepScreenshotRefs[t.afterStep].push(t.screenshotIndex);
      }
    }

    if (f.steps) {
      const steps = timeline.filter(t => t.kind === 'step').map(s => {
        const entry = { ...s };
        delete entry.kind;
        if (stepScreenshotRefs[s.step]) entry.screenshotRefs = stepScreenshotRefs[s.step];
        return entry;
      });
      // Summary before steps for readability
      report.summary = this.generateSummary(steps, session);
      report.steps = steps;
    }

    if (f.console) {
      const consoleErrors = events
        .filter(e => e.type === 'event:console' && (e.level === 'error' || e.level === 'warn'))
        .map(e => ({
          t: this.relativeTime(e.timestamp, session.startTime),
          level: e.level,
          message: e.message,
          stack: e.stack || undefined
        }));
      if (consoleErrors.length > 0) report.consoleErrors = consoleErrors;
    }

    if (f.network) {
      let netEvents = events.filter(e => e.type === 'event:network' || e.type === 'event:network:enhanced');
      if (f.networkErrorsOnly) {
        netEvents = netEvents.filter(e => e.status >= 400 || e.status === 0);
      }
      const networkRequests = netEvents.map(e => {
        // Truncate long URLs — keep origin + path, trim query strings over 120 chars
        let url = e.url;
        const qIdx = url.indexOf('?');
        if (qIdx > 0 && url.length > 200) {
          url = url.slice(0, qIdx) + '?…';
        }
        const entry = {
          t: this.relativeTime(e.timestamp, session.startTime),
          method: e.method,
          url,
          status: e.status,
          duration: e.duration,
        };
        if (e.requestBody) entry.requestBody = e.requestBody;
        if (e.responseBody) entry.responseBody = e.responseBody;
        return entry;
      });
      if (networkRequests.length > 0) report.networkRequests = networkRequests;
    }

    if (f.screenshots && screenshotEntries.length > 0) {
      report.screenshots = screenshotEntries.map(s => {
        const out = {
          id: s.id, index: s.index, timestamp: s.timestamp,
          afterStep: s.afterStep || null,
        };
        if (s.annotations.length > 0) out.annotations = s.annotations;
        if (!f.screenshotAsFile) {
          out.dataUrl = s._dataUrl;
        }
        return out;
      });
      if (f.screenshotAsFile) {
        report._screenshotFiles = screenshotEntries.map(s => ({
          filename: `screenshot-${s.index}.jpg`,
          dataUrl: s._dataUrl,
        }));
      }
    }

    return { debugReport: report };
  },

  async generateMarkdown(sessionId, filters) {
    const data = await this.generateJSON(sessionId, filters);
    if (!data) return '';
    const r = data.debugReport;
    const f = { ...this.DEFAULT_FILTERS, ...filters };
    const lines = [];

    lines.push(`# ${r.title || 'Debug Report'}`);
    lines.push(`**URL:** ${r.url}  `);
    lines.push(`**Time:** ${r.startTime} → ${r.endTime || 'ongoing'}  `);
    lines.push(`**Duration:** ${r.duration}ms`);
    lines.push('');

    // Summary
    if (r.summary) {
      lines.push(`> ${r.summary}`);
      lines.push('');
    }

    // Screenshot afterStep lookup
    const ssAfterStep = {};
    if (r.screenshots) {
      for (const s of r.screenshots) {
        if (s.afterStep != null) {
          if (!ssAfterStep[s.afterStep]) ssAfterStep[s.afterStep] = [];
          ssAfterStep[s.afterStep].push(s);
        }
      }
    }

    // Steps
    if (r.steps && r.steps.length > 0) {
      lines.push('## Steps');
      r.steps.forEach(s => {
        const desc = this.describeStep(s);
        let line = `${s.step}. \`${s.t}\` ${desc}`;
        if (s.url) line += ` → navigated to ${s.url}`;
        if (ssAfterStep[s.step]) {
          const refs = ssAfterStep[s.step].map(ss => `[Screenshot ${ss.index}](#screenshot-${ss.index})`).join(', ');
          line += ` — see ${refs}`;
        }
        lines.push(line);
      });
      lines.push('');
    }

    // Console — only if non-empty
    if (r.consoleErrors && r.consoleErrors.length > 0) {
      lines.push('## Console Errors');
      r.consoleErrors.forEach(e => {
        lines.push(`- **[${e.level.toUpperCase()}]** \`${e.t}\`: ${e.message}`);
        if (e.stack) lines.push('  ```\n  ' + e.stack + '\n  ```');
      });
      lines.push('');
    }

    // Network — only if non-empty
    if (r.networkRequests && r.networkRequests.length > 0) {
      const renderBody = (e) => {
        if (e.requestBody) { lines.push('  **Request:**'); lines.push('  ```'); lines.push('  ' + e.requestBody.slice(0, 2000)); lines.push('  ```'); }
        if (e.responseBody) { lines.push('  **Response:**'); lines.push('  ```'); lines.push('  ' + e.responseBody.slice(0, 2000)); lines.push('  ```'); }
      };
      if (f.networkErrorsOnly) {
        lines.push('## Network Errors');
        r.networkRequests.forEach(e => {
          lines.push(`- **${e.method} ${e.url}** → ${e.status} (${e.duration}ms)`);
          renderBody(e);
        });
      } else {
        const errors = r.networkRequests.filter(e => e.status >= 400 || e.status === 0);
        const ok = r.networkRequests.filter(e => e.status > 0 && e.status < 400);
        if (errors.length > 0) {
          lines.push('## Network Errors');
          errors.forEach(e => {
            lines.push(`- **${e.method} ${e.url}** → ${e.status} (${e.duration}ms)`);
            renderBody(e);
          });
          lines.push('');
        }
        if (ok.length > 0) {
          lines.push('## Network Requests');
          ok.forEach(e => {
            lines.push(`- ${e.method} ${e.url} → ${e.status} (${e.duration}ms)`);
            renderBody(e);
          });
          lines.push('');
        }
      }
      lines.push('');
    }

    // Screenshots — only if non-empty
    if (r.screenshots && r.screenshots.length > 0) {
      lines.push('## Screenshots');
      r.screenshots.forEach(s => {
        const anchor = `<a id="screenshot-${s.index}"></a>`;
        let heading = `### ${anchor}Screenshot ${s.index} (${s.timestamp})`;
        if (s.afterStep) heading += ` — after step ${s.afterStep}`;
        lines.push(heading);
        if (s.annotations && s.annotations.length > 0) {
          s.annotations.forEach(a => lines.push(`- ${a.type}: ${a.label}`));
        }
        if (f.screenshotAsFile) {
          lines.push(`![screenshot-${s.index}](./screenshot-${s.index}.jpg)`);
        } else if (s.dataUrl) {
          lines.push(`![screenshot-${s.index}](${s.dataUrl})`);
        }
        lines.push('');
      });
    }

    return lines.join('\n');
  }
};
