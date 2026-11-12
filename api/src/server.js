'use strict';
const config = require('./config');
const db = require('./db');
const { migrate } = require('../scripts/migrate');
const { seed } = require('../scripts/seed');
const { createApp } = require('./app');

async function main() {
  await migrate(db.pool);
  if (config.seedOnStart) {
    const { rows: [{ n }] } = await db.query('SELECT count(*)::int AS n FROM users');
    if (n === 0) await seed(db.pool);
  }
  const server = createApp().listen(config.port, () => console.log(`API listening on :${config.port}`));
  const stop = () => server.close(() => db.pool.end().then(() => process.exit(0)));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((e) => { console.error(e); process.exit(1); });
