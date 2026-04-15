// NOTE: DB_NAME, DB_VERSION, and STORE_SCREENSHOTS are also hard-coded in
// sidepanel/sidepanel.js openMediaDB(). Keep them in sync — bumping the version
// or renaming the store here requires a matching change there.
const Storage = {
  DB_NAME: 'debug-helper',
  DB_VERSION: 1,
  STORE_SCREENSHOTS: 'screenshots',
  CHUNK_SIZE: 500,

  // IndexedDB for screenshots
  _db: null,
  _ensureStore(db) {
    if (!db.objectStoreNames.contains(this.STORE_SCREENSHOTS)) {
      db.createObjectStore(this.STORE_SCREENSHOTS, { keyPath: 'id' });
    }
  },
  _openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.DB_NAME, this.DB_VERSION);
      req.onupgradeneeded = (e) => this._ensureStore(e.target.result);
      req.onsuccess = () => {
        const db = req.result;
        // Clear cached ref when the connection is unexpectedly closed
        db.onclose = () => { if (this._db === db) this._db = null; };
        db.onversionchange = () => { db.close(); if (this._db === db) this._db = null; };
        this._db = db;
        resolve(db);
      };
      req.onerror = () => reject(req.error);
    });
  },
  async getDB() {
    if (this._db) {
      // Validate the cached connection is still usable
      try {
        // A quick no-op transaction to verify the connection
        this._db.transaction(this.STORE_SCREENSHOTS, 'readonly');
        return this._db;
      } catch {
        // Connection is stale — reopen
        this._db = null;
      }
    }
    return this._openDB();
  },

  // Session CRUD
  async createSession(tabId, url) {
    const session = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      tabId,
      url,
      startTime: Date.now(),
      endTime: null,
      eventCount: 0,
      chunkCount: 0
    };
    await chrome.storage.local.set({ ['session:' + session.id]: session, currentSessionId: session.id });
    return session;
  },

  async getSession(sessionId) {
    const data = await chrome.storage.local.get('session:' + sessionId);
    return data['session:' + sessionId] || null;
  },

  async getCurrentSession() {
    const { currentSessionId } = await chrome.storage.local.get('currentSessionId');
    if (!currentSessionId) return null;
    return this.getSession(currentSessionId);
  },

  async endSession(sessionId) {
    const session = await this.getSession(sessionId);
    if (!session) return;
    session.endTime = Date.now();
    await chrome.storage.local.set({ ['session:' + session.id]: session });
    await chrome.storage.local.remove('currentSessionId');
    return session;
  },

  async listSessions() {
    const all = await chrome.storage.local.get(null);
    return Object.keys(all)
      .filter(k => k.startsWith('session:'))
      .map(k => all[k])
      .sort((a, b) => b.startTime - a.startTime);
  },

  // Event storage (chunked)
  async addEvents(sessionId, events) {
    const session = await this.getSession(sessionId);
    if (!session) return;

    const chunkKey = `events:${sessionId}:${session.chunkCount}`;
    const existing = (await chrome.storage.local.get(chunkKey))[chunkKey] || [];
    const combined = existing.concat(events);

    if (combined.length >= this.CHUNK_SIZE) {
      await chrome.storage.local.set({ [chunkKey]: combined.slice(0, this.CHUNK_SIZE) });
      session.chunkCount++;
      const overflow = combined.slice(this.CHUNK_SIZE);
      if (overflow.length > 0) {
        await chrome.storage.local.set({ [`events:${sessionId}:${session.chunkCount}`]: overflow });
      }
    } else {
      await chrome.storage.local.set({ [chunkKey]: combined });
    }

    session.eventCount += events.length;
    await chrome.storage.local.set({ ['session:' + sessionId]: session });
  },

  async getEvents(sessionId) {
    const session = await this.getSession(sessionId);
    if (!session) return [];
    const keys = [];
    for (let i = 0; i <= session.chunkCount; i++) {
      keys.push(`events:${sessionId}:${i}`);
    }
    const data = await chrome.storage.local.get(keys);
    let events = [];
    for (const k of keys) {
      if (data[k]) events = events.concat(data[k]);
    }
    return events;
  },

  // Screenshots (IndexedDB)
  async saveScreenshot(sessionId, dataUrl, annotations) {
    const db = await this.getDB();
    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      sessionId,
      dataUrl,
      annotations: annotations || [],
      timestamp: Date.now()
    };
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_SCREENSHOTS, 'readwrite');
      tx.objectStore(this.STORE_SCREENSHOTS).put(entry);
      tx.oncomplete = () => resolve(entry);
      tx.onerror = () => reject(tx.error);
    });
  },

  async getScreenshots(sessionId) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_SCREENSHOTS, 'readonly');
      const store = tx.objectStore(this.STORE_SCREENSHOTS);
      const req = store.getAll();
      req.onsuccess = () => {
        resolve(req.result.filter(s => s.sessionId === sessionId).sort((a, b) => a.timestamp - b.timestamp));
      };
      req.onerror = () => reject(req.error);
    });
  },

  async updateScreenshot(id, updates) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_SCREENSHOTS, 'readwrite');
      const store = tx.objectStore(this.STORE_SCREENSHOTS);
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const entry = getReq.result;
        if (!entry) return resolve(null);
        Object.assign(entry, updates);
        store.put(entry);
        tx.oncomplete = () => resolve(entry);
      };
      tx.onerror = () => reject(tx.error);
    });
  },

  // Storage quota management
  async getStorageUsage() {
    const bytes = await chrome.storage.local.getBytesInUse(null);
    const quota = chrome.storage.local.QUOTA_BYTES || 10485760; // 10MB default
    return { bytes, quota, percent: Math.round((bytes / quota) * 100) };
  },

  async cleanupOldSessions(keepCount = 10) {
    const sessions = await this.listSessions();
    // Keep active session + most recent N
    const toDelete = sessions
      .filter(s => s.endTime) // only ended sessions
      .slice(keepCount);      // keep newest keepCount
    for (const s of toDelete) {
      await this.clearSession(s.id);
    }
    return toDelete.length;
  },

  // Cleanup
  async clearSession(sessionId) {
    const session = await this.getSession(sessionId);
    if (!session) return;
    const keys = ['session:' + sessionId];
    for (let i = 0; i <= session.chunkCount; i++) {
      keys.push(`events:${sessionId}:${i}`);
    }
    await chrome.storage.local.remove(keys);

    // Remove screenshots from IndexedDB
    const screenshots = await this.getScreenshots(sessionId);
    const db = await this.getDB();
    const tx = db.transaction(this.STORE_SCREENSHOTS, 'readwrite');
    const store = tx.objectStore(this.STORE_SCREENSHOTS);
    for (const s of screenshots) store.delete(s.id);
  }
};
