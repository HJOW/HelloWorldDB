'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const HelloWorldDB = require('../src/db');

test('CRUD and persistence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwdb-'));
  const db = new HelloWorldDB(dir);
  db.createTable('users', ['id', 'name']);
  db.insert('users', { id: 1, name: 'a' });
  db.insert('users', { id: 2, name: 'b' });
  assert.strictEqual(db.select('users').length, 2);
  assert.strictEqual(db.update('users', { id: 1 }, { name: 'z' }), 1);
  assert.strictEqual(db.select('users', { id: 1 })[0].name, 'z');
  assert.strictEqual(new HelloWorldDB(dir).select('users').length, 2);
  assert.strictEqual(db.delete('users', { id: 2 }), 1);
  assert.throws(() => db.insert('users', { bad: 1 }));
  assert.throws(() => db.createTable('../x', ['a']));
  db.dropTable('users');
  assert.throws(() => db.select('users'));
  fs.rmSync(dir, { recursive: true });
});
