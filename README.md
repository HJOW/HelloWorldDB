# HelloWorldDB
Node.js 로 간단한 DBMS 개발 (아이디어 단계)

## Usage
```js
const HelloWorldDB = require('./src/db');
const db = new HelloWorldDB('./data');
db.createTable('users', ['id', 'name']);
db.insert('users', { id: 1, name: 'Hello' });
db.select('users', { id: 1 });
db.update('users', { id: 1 }, { name: 'World' });
db.delete('users', { id: 1 });
```
Tables are persisted as JSON files. Run tests with `npm test`.
