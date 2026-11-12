'use strict';
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const config = require('./config');
const db = require('./db');
const routes = require('./routes');
const { errorHandler } = require('./middleware');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin, allowedHeaders: ['Authorization', 'Content-Type'] }));
  app.use(express.json({ limit: '15mb' })); // invoice uploads as base64
  app.get('/health', async (_req, res) => {
    try { await db.query('SELECT 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
  });
  app.use('/api', routes);
  app.use((_req, res) => res.status(404).json({ error: 'المسار غير موجود' }));
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
