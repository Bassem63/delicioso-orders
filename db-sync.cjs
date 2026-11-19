const { createClient } = require('@libsql/client');

if (!process.env.TURSO_DATABASE_URL) process.env.TURSO_DATABASE_URL = 'libsql://dilicioso-bassem63.aws-eu-north-1.turso.io';
if (!process.env.TURSO_AUTH_TOKEN) process.env.TURSO_AUTH_TOKEN = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3OTI3ODg5NzMsImlkIjoiMDFhMTZhOGMtODIwMS03MmVjLWEwYjgtNDljNmMwZTliODljIiwia2lkIjoibjh4S0VMUk5RbFlYM25pNnlvdk5SS1ZxZU5pQ3VBV0Q2X0I3ZVJMLWw1byIsInJpZCI6ImRhYjQyYzRmLTI0OWEtNDc4OS1hMzczLTI2OTY5ZjZmMDE1OSJ9.VwT5_1jNk0WmiMJl7j78xQy1v-JkUSEjEdIIjLub7DyBVptHwhA6Hr-_hGYGJYTyX-iTspLa3g6HKryCsMk8BA';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

function rowsToObjects(rs) {
  if (!rs) return [];
  const cols = rs.columns || [];
  const out = [];
  if (rs.rows && Array.isArray(rs.rows)) {
    for (const row of rs.rows) {
      if (Array.isArray(row)) {
        const obj = {};
        cols.forEach((c, i) => { obj[c] = row[i]; });
        out.push(obj);
      } else if (typeof row === 'object') {
        out.push(row);
      }
    }
  }
  return out;
}

// Async database wrapper
function prepare(sql) {
  return {
    get: async (...args) => {
      const rs = await client.execute({ sql, args });
      return rs.rows && rs.rows[0] ? rowsToObjects({ columns: rs.columns, rows: [rs.rows[0]] })[0] : null;
    },
    all: async (...args) => {
      const rs = await client.execute({ sql, args });
      return rowsToObjects(rs);
    },
    run: async (...args) => {
      const rs = await client.execute({ sql, args });
      return { lastInsertRowid: rs.lastInsertRowid, changes: rs.rowsAffected };
    }
  };
}

// Execute multiple statements
async function exec(sql) {
  // Split by semicolon and execute each statement separately
  const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 0);
  for (const stmt of statements) {
    await client.execute(stmt);
  }
}

module.exports = {
  prepare,
  exec,
  close: () => client.close()
};