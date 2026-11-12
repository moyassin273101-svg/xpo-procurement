'use strict';
const { Pool, types } = require('pg');
const config = require('./config');

// NUMERIC -> JS number (amounts fit safely in double at 2dp for this domain)
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
// DATE -> 'YYYY-MM-DD' string (avoid timezone shifts)
types.setTypeParser(1082, (v) => v);

const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, tx, query: (t, p) => pool.query(t, p) };
