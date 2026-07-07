// Attendance plugin server — three surfaces on one Coolify container:
//   POST /mcp            MCP (gateway-only + token)         → agent tools
//   /api/*               REST hot path (token only)         → Flutter check-in
//   GET  /app            embedded admin UI (surface="ui")   → explorer
import express from 'express';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { authMiddleware, verifyToken, requireGateway } from './auth.js';
import * as db from './db.js';
import { handleRpc } from './mcp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(readFileSync(join(__dirname, '..', 'manifest.json'), 'utf-8'));
const serverInfo = { name: MANIFEST.slug, version: MANIFEST.version };

const app = express();
app.use(express.json());

// The admin UI is embedded inside the Eesa shell; allow framing from it only.
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "frame-ancestors https://app.eesa.ai https://eesa.ai");
  next();
});

app.get('/health', (req, res) => res.json({ ok: true, plugin: MANIFEST.slug }));
app.get('/manifest', (req, res) => res.json(MANIFEST));

// ---- MCP surface: gateway-only + token, JSON-RPC ----
app.post('/mcp', async (req, res) => {
  const body = req.body || {};
  const isNotification = !('id' in body);
  try {
    requireGateway(req);
    const ctx = await verifyToken(req.get('Authorization'));
    const result = await handleRpc(body, ctx, serverInfo);
    if (isNotification || result === null) return res.status(202).end();
    return res.json({ jsonrpc: '2.0', id: body.id, result });
  } catch (e) {
    if (isNotification) return res.status(202).end();
    return res
      .status(e.status || 200)
      .json({ jsonrpc: '2.0', id: body.id ?? null, error: { code: e.code || -32000, message: e.message } });
  }
});

// ---- REST hot path: called DIRECTLY by the Flutter app with the user's Eesa
// token (NOT through the gateway, so no gateway-secret here). Latency-sensitive. ----
const emp = authMiddleware({});
app.post('/api/checkIn', emp, async (req, res) => {
  const { zoneId = null, lat = null, lng = null } = req.body || {};
  res.json({ ok: true, event: await db.recordEvent(req.ctx.tenantId, req.ctx.sub, 'check_in', { zoneId, lat, lng }) });
});
app.post('/api/checkOut', emp, async (req, res) => {
  const { zoneId = null, lat = null, lng = null } = req.body || {};
  res.json({ ok: true, event: await db.recordEvent(req.ctx.tenantId, req.ctx.sub, 'check_out', { zoneId, lat, lng }) });
});
app.get('/api/getMyStatus', emp, async (req, res) => res.json({ ok: true, data: await db.myStatus(req.ctx.tenantId, req.ctx.sub) }));
app.get('/api/getMyZones', emp, async (req, res) => res.json({ ok: true, data: await db.listZones(req.ctx.tenantId) }));
app.get('/api/getMyHistory', emp, async (req, res) =>
  res.json({ ok: true, data: await db.myHistory(req.ctx.tenantId, req.ctx.sub, Number(req.query.days) || 7) }));

// ---- Admin REST: requires the attendance:admin scope ----
function requireAdmin(req, res, next) {
  if (!(req.ctx.scopes || []).includes('attendance:admin')) {
    return res.status(403).json({ ok: false, error: 'attendance:admin scope required' });
  }
  next();
}
const admin = [authMiddleware({}), requireAdmin];
app.get('/api/admin/zones', admin, async (req, res) => res.json({ ok: true, data: await db.listZones(req.ctx.tenantId) }));
app.post('/api/admin/zones', admin, async (req, res) => res.json({ ok: true, data: await db.createZone(req.ctx.tenantId, req.body || {}) }));
app.get('/api/admin/presence', admin, async (req, res) => res.json({ ok: true, data: await db.presence(req.ctx.tenantId) }));

// ---- Embedded UI: static shell + a context endpoint verified with the UI session token ----
app.get('/app', (req, res) => res.sendFile(join(__dirname, '..', 'public', 'app.html')));
app.get('/api/ui/context', authMiddleware({ surface: 'ui' }), (req, res) =>
  res.json({ ok: true, tenant: req.ctx.tenantId, name: req.ctx.email || req.ctx.sub, role: req.ctx.role, scopes: req.ctx.scopes }));

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`attendance plugin listening on :${port}`));
