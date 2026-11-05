import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { getConfig } from '../config.js';
import { logger, safeErrorMessage } from '../logger.js';
import { registerRoutes } from './routes.js';

/** Fastify application: security headers, cookies, uploads, API routes and the built dashboard. */

export async function buildApp(): Promise<FastifyInstance> {
  const cfg = getConfig();
  const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src 'self' blob:; object-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
    );
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.addHook('onResponse', async (req, reply) => {
    if (req.url.startsWith('/api/') && !req.url.startsWith('/api/health')) {
      logger.debug('request', { method: req.method, path: req.url.split('?')[0], status: reply.statusCode, ms: Math.round(reply.elapsedTime) });
    }
  });

  app.setErrorHandler(async (err: Error & { statusCode?: number; issues?: unknown }, _req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : err.name === 'ZodError' ? 400 : 500;
    if (status >= 500) logger.error('Unhandled API error', { error: safeErrorMessage(err) });
    const message = err.name === 'ZodError' ? 'Invalid input: ' + safeErrorMessage(err).slice(0, 300) : safeErrorMessage(err);
    await reply.code(status).send({ error: message });
  });

  await registerRoutes(app);

  const webDir = path.join(cfg.appRoot, 'dist', 'web');
  if (fs.existsSync(path.join(webDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDir, prefix: '/', wildcard: false, index: ['index.html'] });
    app.setNotFoundHandler(async (req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.type('text/html').sendFile('index.html');
      return reply.code(404).send({ error: 'Not found' });
    });
  } else {
    app.get('/', async (_req, reply) => reply.type('text/html').send('<p>Dashboard not built. Run <code>npm run build</code> or use <code>npm run dev</code>.</p>'));
  }
  return app;
}
