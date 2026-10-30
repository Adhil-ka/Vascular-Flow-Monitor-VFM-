import { createServer } from 'node:http';
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const rootDir = dirname(fileURLToPath(import.meta.url));
const dataDir = join(rootDir, 'data');
const port = Number(process.env.PORT || 3000);
const notificationMode = process.env.VFM_NOTIFICATION_MODE || 'demo';
const startedAt = new Date().toISOString();
const alerts = new Map();

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  // Vendored ES modules are served from .mjs, so they need the same script type.
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8'
};

function responseJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(self), bluetooth=(self)');
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'");
}

async function readJsonBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 12_000) throw new Error('Request is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Request must be valid JSON.'); }
}

function stringValue(value, maxLength = 80) { return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''; }
function safeNumber(value) { return Number.isFinite(value) ? Number(value) : null; }

async function appendAudit(event) {
  await mkdir(dataDir, { recursive: true });
  await appendFile(join(dataDir, 'alert-audit.ndjson'), `${JSON.stringify(event)}\n`, 'utf8');
}

class DemoNotificationProvider {
  async deliver(alert) {
    return { delivery: 'SIMULATED_DELIVERED', deliveredAt: new Date().toISOString(), preview: `VFM demo: persistent flow-pattern change recorded for ${alert.patientAlias || 'the patient'}.` };
  }
}

class TwilioNotificationProvider {
  async deliver(alert) {
    const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM: from, TWILIO_TO: to } = process.env;
    if (![sid, token, from, to].every(Boolean)) throw new Error('Twilio is not fully configured on the server.');
    const body = `VFM alert: persistent flow-pattern change for ${alert.patientAlias || 'patient'} (${alert.accessSide || 'access arm'}). Prototype alert; follow the agreed clinical pathway.`;
    const form = new URLSearchParams({ To: to, From: from, Body: body });
    const auth = Buffer.from(`${sid}:${token}`).toString('base64');
    const result = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
    if (!result.ok) throw new Error(`Twilio delivery failed (${result.status}).`);
    return { delivery: 'DELIVERED', deliveredAt: new Date().toISOString(), preview: 'Secure server-side notification dispatched.' };
  }
}

const notificationProvider = notificationMode === 'twilio' ? new TwilioNotificationProvider() : new DemoNotificationProvider();

function normalizeAlert(body) {
  const evidence = body && typeof body.evidence === 'object' ? body.evidence : {};
  return {
    id: stringValue(body?.id, 64) || randomUUID(), patientAlias: stringValue(body?.patientAlias, 36),
    accessSide: ['Left', 'Right'].includes(body?.accessSide) ? body.accessSide : '',
    occurredAt: stringValue(body?.occurredAt, 40) || new Date().toISOString(), mode: body?.mode === 'demo' ? 'demo' : 'live',
    evidence: {
      ratio: safeNumber(evidence.ratio),
      baseline: safeNumber(evidence.baseline),
      deltaPercent: safeNumber(evidence.ratioDelta),
      amplitudeDeltaPercent: safeNumber(evidence.amplitudeDelta),
      dominantFrequencyHz: safeNumber(evidence.dominantFrequencyHz),
      // Optical channel. Absent on v1 frames, in which case these stay null.
      spo2: safeNumber(evidence.spo2),
      bpm: safeNumber(evidence.bpm),
      perfusionIndex: safeNumber(evidence.perfusionIndex),
      quality: safeNumber(evidence.quality)
    }
  };
}

async function serveStatic(req, res) {
  const rawPath = new URL(req.url, 'http://localhost').pathname;
  const relativePath = rawPath === '/' ? 'AVF.html' : decodeURIComponent(rawPath).replace(/^\/+/, '');
  // Dotfiles and the audit directory are not part of the app. Without this the
  // server hands out .git/ (full history) and .env (provider credentials) — and
  // the documented cloudflared workflow puts it on a public URL.
  const segments = relativePath.split(/[\\/]+/);
  if (segments.some((part) => part.startsWith('.') || part === 'data')) {
    return responseJson(res, 404, { error: 'Not found' });
  }
  const target = normalize(join(rootDir, relativePath));
  if (!target.startsWith(`${rootDir}${sep}`) && target !== rootDir) return responseJson(res, 403, { error: 'Forbidden' });
  try {
    const info = await stat(target);
    if (!info.isFile()) return responseJson(res, 404, { error: 'Not found' });
    const content = await readFile(target);
    res.writeHead(200, { 'Content-Type': mimeTypes[extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(content);
  } catch { responseJson(res, 404, { error: 'Not found' }); }
}

const server = createServer(async (req, res) => {
  setSecurityHeaders(res);
  const route = new URL(req.url, 'http://localhost').pathname;
  try {
    if (req.method === 'GET' && route === '/api/health') return responseJson(res, 200, { status: 'ok', notificationMode, startedAt });
    if (req.method === 'POST' && route === '/api/alerts') {
      const alert = normalizeAlert(await readJsonBody(req));
      const delivery = await notificationProvider.deliver(alert);
      const record = { type: 'alert-escalated', ...alert, ...delivery };
      alerts.set(alert.id, record); await appendAudit(record);
      return responseJson(res, 201, { id: alert.id, ...delivery });
    }
    const match = route.match(/^\/api\/alerts\/([^/]+)\/acknowledge$/);
    if (req.method === 'POST' && match) {
      const id = decodeURIComponent(match[1]).slice(0, 64);
      const acknowledgement = { type: 'alert-acknowledged', id, acknowledgedAt: new Date().toISOString() };
      alerts.set(id, { ...(alerts.get(id) || {}), ...acknowledgement }); await appendAudit(acknowledgement);
      return responseJson(res, 200, acknowledgement);
    }
    if (!['GET', 'HEAD'].includes(req.method)) return responseJson(res, 405, { error: 'Method not allowed' });
    if (req.method === 'HEAD') return res.end();
    return serveStatic(req, res);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected server error.';
    console.error(`[VFM] ${message}`);
    return responseJson(res, 400, { error: message });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`VFM running at http://127.0.0.1:${port}`);
  console.log(`Notification mode: ${notificationMode}`);
});
