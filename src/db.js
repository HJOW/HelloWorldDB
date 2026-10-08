'use strict';
const fs = require('fs');
const path = require('path');

// Simple JSON-file backed DBMS: each table is stored as <dir>/<table>.json
class HelloWorldDB {
  constructor(dir) {
    this.dir = dir;
    this.tables = {};
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.json')) {
        this.tables[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      }
    }
  }

  _check(name) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Invalid table name: ' + name);
  }

  _table(name) {
    this._check(name);
    const t = this.tables[name];
    if (!t) throw new Error('No such table: ' + name);
    return t;
  }

  _save(name) {
    fs.writeFileSync(path.join(this.dir, name + '.json'), JSON.stringify(this.tables[name]));
  }

  createTable(name, columns) {
    this._check(name);
    if (this.tables[name]) throw new Error('Table exists: ' + name);
    if (!Array.isArray(columns) || columns.length === 0) throw new Error('Columns required');
    this.tables[name] = { columns: columns.slice(), rows: [] };
    this._save(name);
  }

  dropTable(name) {
    this._table(name);
    delete this.tables[name];
    fs.unlinkSync(path.join(this.dir, name + '.json'));
  }

  insert(name, row) {
    const t = this._table(name);
    const r = {};
    for (const c of t.columns) r[c] = row[c] === undefined ? null : row[c];
    for (const k of Object.keys(row)) if (!t.columns.includes(k)) throw new Error('Unknown column: ' + k);
    t.rows.push(r);
    this._save(name);
    return r;
  }

  // where: object of equality conditions, or a predicate function
  _match(where) {
    if (typeof where === 'function') return where;
    const w = where || {};
    return (r) => Object.keys(w).every((k) => r[k] === w[k]);
  }

  select(name, where) {
    const m = this._match(where);
    return this._table(name).rows.filter(m).map((r) => ({ ...r }));
  }

  update(name, where, values) {
    const t = this._table(name);
    for (const k of Object.keys(values)) if (!t.columns.includes(k)) throw new Error('Unknown column: ' + k);
    const m = this._match(where);
    let n = 0;
    for (const r of t.rows) if (m(r)) { Object.assign(r, values); n++; }
    if (n) this._save(name);
    return n;
  }

  delete(name, where) {
    const t = this._table(name);
    const m = this._match(where);
    const before = t.rows.length;
    t.rows = t.rows.filter((r) => !m(r));
    const n = before - t.rows.length;
    if (n) this._save(name);
    return n;
  }
}

module.exports = HelloWorldDB;
