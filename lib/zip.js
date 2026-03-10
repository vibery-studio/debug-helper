// Minimal ZIP builder — no dependencies, works in service worker + page contexts
// Produces a valid ZIP file as a Blob
const Zip = {
  // entries: [{ name: 'file.txt', data: Uint8Array | string }]
  build(entries) {
    const files = entries.map(e => ({
      name: new TextEncoder().encode(e.name),
      data: typeof e.data === 'string' ? new TextEncoder().encode(e.data) : e.data,
    }));

    // Calculate sizes
    let offset = 0;
    const localHeaders = [];
    for (const f of files) {
      const header = this._localHeader(f.name, f.data, offset);
      localHeaders.push(header);
      offset += header.byteLength + f.data.byteLength;
    }

    const centralStart = offset;
    const centralHeaders = [];
    let localOffset = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      centralHeaders.push(this._centralHeader(f.name, f.data, localOffset));
      localOffset += localHeaders[i].byteLength + f.data.byteLength;
    }

    const centralSize = centralHeaders.reduce((s, h) => s + h.byteLength, 0);
    const endRecord = this._endRecord(files.length, centralSize, centralStart);

    // Assemble
    const parts = [];
    for (let i = 0; i < files.length; i++) {
      parts.push(localHeaders[i], files[i].data);
    }
    for (const h of centralHeaders) parts.push(h);
    parts.push(endRecord);

    return new Blob(parts, { type: 'application/zip' });
  },

  _localHeader(name, data, offset) {
    const buf = new ArrayBuffer(30 + name.byteLength);
    const v = new DataView(buf);
    const u = new Uint8Array(buf);
    v.setUint32(0, 0x04034b50, true);  // signature
    v.setUint16(4, 20, true);           // version needed
    v.setUint16(6, 0, true);            // flags
    v.setUint16(8, 0, true);            // compression: store
    v.setUint16(10, 0, true);           // mod time
    v.setUint16(12, 0, true);           // mod date
    v.setUint32(14, this._crc32(data), true);
    v.setUint32(18, data.byteLength, true);  // compressed
    v.setUint32(22, data.byteLength, true);  // uncompressed
    v.setUint16(26, name.byteLength, true);
    v.setUint16(28, 0, true);           // extra length
    u.set(name, 30);
    return new Uint8Array(buf);
  },

  _centralHeader(name, data, localOffset) {
    const buf = new ArrayBuffer(46 + name.byteLength);
    const v = new DataView(buf);
    const u = new Uint8Array(buf);
    v.setUint32(0, 0x02014b50, true);  // signature
    v.setUint16(4, 20, true);           // version made
    v.setUint16(6, 20, true);           // version needed
    v.setUint16(8, 0, true);            // flags
    v.setUint16(10, 0, true);           // compression
    v.setUint16(12, 0, true);           // mod time
    v.setUint16(14, 0, true);           // mod date
    v.setUint32(16, this._crc32(data), true);
    v.setUint32(20, data.byteLength, true);
    v.setUint32(24, data.byteLength, true);
    v.setUint16(28, name.byteLength, true);
    v.setUint16(30, 0, true);           // extra length
    v.setUint16(32, 0, true);           // comment length
    v.setUint16(34, 0, true);           // disk start
    v.setUint16(36, 0, true);           // internal attrs
    v.setUint32(38, 0, true);           // external attrs
    v.setUint32(42, localOffset, true);
    u.set(name, 46);
    return new Uint8Array(buf);
  },

  _endRecord(count, centralSize, centralStart) {
    const buf = new ArrayBuffer(22);
    const v = new DataView(buf);
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(4, 0, true);
    v.setUint16(6, 0, true);
    v.setUint16(8, count, true);
    v.setUint16(10, count, true);
    v.setUint32(12, centralSize, true);
    v.setUint32(16, centralStart, true);
    v.setUint16(20, 0, true);
    return new Uint8Array(buf);
  },

  _crc32Table: null,
  _crc32(data) {
    if (!this._crc32Table) {
      const t = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[i] = c;
      }
      this._crc32Table = t;
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.byteLength; i++) {
      crc = this._crc32Table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
};
