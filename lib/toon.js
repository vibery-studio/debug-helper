// Minimal TOON encoder for debug reports
// Spec: https://github.com/toon-format/spec/blob/main/SPEC.md
const Toon = {
  INDENT: '  ',

  encode(value) {
    const lines = [];
    this._encodeValue(value, 0, null, lines);
    return lines.join('\n');
  },

  _encodeValue(value, depth, key, lines) {
    if (value === null || value === undefined) {
      lines.push(this._prefix(depth, key) + 'null');
      return;
    }
    if (Array.isArray(value)) {
      this._encodeArray(value, depth, key, lines);
      return;
    }
    if (typeof value === 'object') {
      this._encodeObject(value, depth, key, lines);
      return;
    }
    // Primitive
    lines.push(this._prefix(depth, key) + this._encodePrimitive(value));
  },

  _prefix(depth, key) {
    const indent = this.INDENT.repeat(depth);
    if (key === null) return indent;
    return indent + this._encodeKey(key) + ': ';
  },

  _encodePrimitive(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'boolean') return String(value);
    if (typeof value === 'number') {
      if (!isFinite(value)) return 'null';
      if (Object.is(value, -0)) return '0';
      return String(value);
    }
    // String
    return this._encodeString(String(value));
  },

  _needsQuoting(s) {
    if (s === '') return true;
    if (s !== s.trim()) return true; // leading/trailing whitespace
    if (s === 'true' || s === 'false' || s === 'null') return true;
    if (/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(s)) return true; // numeric-like
    if (/^0\d+$/.test(s)) return true; // leading zeros
    if (s === '-' || s.startsWith('-')) return true;
    if (/[:"\\[\]{}]/.test(s)) return true;
    if (/[\n\r\t]/.test(s)) return true;
    if (s.includes(',')) return true; // default delimiter
    return false;
  },

  _encodeString(s) {
    if (!this._needsQuoting(s)) return s;
    return '"' + s
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
      + '"';
  },

  _encodeKey(key) {
    if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) return key;
    return this._encodeString(key);
  },

  // Check if array is tabular: all objects with identical primitive-only keys
  _isTabular(arr) {
    if (arr.length === 0) return false;
    if (typeof arr[0] !== 'object' || arr[0] === null || Array.isArray(arr[0])) return false;
    const keys = Object.keys(arr[0]);
    if (keys.length === 0) return false;
    for (const item of arr) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return false;
      const itemKeys = Object.keys(item);
      if (itemKeys.length !== keys.length) return false;
      for (const k of keys) {
        if (!(k in item)) return false;
        const v = item[k];
        if (v !== null && typeof v === 'object') return false; // non-primitive
      }
    }
    return true;
  },

  // Check if array is all primitives
  _isPrimitiveArray(arr) {
    return arr.every(v => v === null || typeof v !== 'object');
  },

  _encodeArray(arr, depth, key, lines) {
    const indent = this.INDENT.repeat(depth);
    const keyStr = key !== null ? this._encodeKey(key) : '';

    if (arr.length === 0) {
      lines.push(indent + (key !== null ? keyStr : '') + '[0]:');
      return;
    }

    // Inline primitive array
    if (this._isPrimitiveArray(arr)) {
      const vals = arr.map(v => this._encodePrimitive(v)).join(',');
      lines.push(indent + (key !== null ? keyStr : '') + `[${arr.length}]: ${vals}`);
      return;
    }

    // Tabular array
    if (this._isTabular(arr)) {
      const fields = Object.keys(arr[0]);
      const fieldStr = fields.map(f => this._encodeKey(f)).join(',');
      lines.push(indent + (key !== null ? keyStr : '') + `[${arr.length}]{${fieldStr}}:`);
      for (const item of arr) {
        const row = fields.map(f => this._encodePrimitive(item[f])).join(',');
        lines.push(this.INDENT.repeat(depth + 1) + row);
      }
      return;
    }

    // Mixed/non-uniform array
    lines.push(indent + (key !== null ? keyStr : '') + `[${arr.length}]:`);
    for (const item of arr) {
      if (item === null || typeof item !== 'object') {
        lines.push(this.INDENT.repeat(depth + 1) + '- ' + this._encodePrimitive(item));
      } else if (Array.isArray(item)) {
        // Nested array as list item
        const subLines = [];
        this._encodeArray(item, 0, null, subLines);
        const first = subLines[0];
        lines.push(this.INDENT.repeat(depth + 1) + '- ' + first.trim());
        for (let i = 1; i < subLines.length; i++) {
          lines.push(this.INDENT.repeat(depth + 2) + subLines[i].trim());
        }
      } else {
        // Object as list item — skip null/undefined values
        const entries = Object.entries(item).filter(([, v]) => v !== undefined && v !== null);
        if (entries.length === 0) {
          lines.push(this.INDENT.repeat(depth + 1) + '-');
        } else {
          const [firstKey, firstVal] = entries[0];
          if (typeof firstVal !== 'object') {
            lines.push(this.INDENT.repeat(depth + 1) + '- ' + this._encodeKey(firstKey) + ': ' + this._encodePrimitive(firstVal));
          } else {
            lines.push(this.INDENT.repeat(depth + 1) + '- ' + this._encodeKey(firstKey) + ':');
            this._encodeValue(firstVal, depth + 3, null, lines);
          }
          for (let j = 1; j < entries.length; j++) {
            this._encodeValue(entries[j][1], depth + 2, entries[j][0], lines);
          }
        }
      }
    }
  },

  _encodeObject(obj, depth, key, lines) {
    const entries = Object.entries(obj);
    const indent = this.INDENT.repeat(depth);

    if (key !== null) {
      lines.push(indent + this._encodeKey(key) + ':');
      depth += 1;
    }

    for (const [k, v] of entries) {
      if (v === undefined || v === null) continue;
      this._encodeValue(v, depth, k, lines);
    }
  }
};
