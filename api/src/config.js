'use strict';
const env = process.env;

const config = {
  port: Number(env.PORT || 3000),
  databaseUrl: env.DATABASE_URL || 'postgres://app:app_dev_password@localhost:5432/procurement',
  jwtSecret: env.JWT_SECRET || '',
  jwtTtl: env.JWT_TTL || '8h',
  corsOrigin: (env.CORS_ORIGIN || 'http://localhost:8080').split(','),
  openrouterKey: env.OPENROUTER_API_KEY || '',
  openrouterModel: env.OPENROUTER_MODEL || '',
  anthropicKey: env.ANTHROPIC_API_KEY || '',
  claudeModel: env.CLAUDE_MODEL || 'claude-sonnet-5-5',
  seedOnStart: env.SEED_ON_START === 'true',
  seedPassword: env.SEED_PASSWORD || 'Passw0rd!',
  isTest: env.NODE_ENV === 'test',
};

if (config.jwtSecret.length < 32 && !config.isTest) {
  throw new Error('JWT_SECRET must be at least 32 characters');
}
if (config.isTest && !config.jwtSecret) config.jwtSecret = 'test-secret-test-secret-test-secret!!';

module.exports = config;
