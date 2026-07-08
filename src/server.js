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
import { fetchRoster } from './roster.js';

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

// ---- Membership-based access (plugin-owned roles) -------------------------
// Verify the Eesa token, resolve the caller's membership, gate by role. Roles
// come from the plugin's OWN membership table, NOT token scopes. A platform
// tenant-admin (token role=ADMIN, present on the UI-session token) is always a
// manager so they can bootstrap enrollment before anyone is assigned.
function isPlatformAdmin(ctx) {
  return String(ctx.role || '').toUpperCase() === 'ADMIN';
}
function withMember({ manager = false } = {}) {
  return async (req, res, next) => {
    try {
      req.ctx = await verifyToken(req.get('Authorization'));
    } catch (e) {
      return res.status(e.status || 401).json({ ok: false, error: e.message });
    }
    try {
      const member = await db.getMembership(req.ctx.tenantId, req.ctx.sub);
      const admin = isPlatformAdmin(req.ctx);
      if (manager) {
        if (!(admin || (member && member.role === 'manager'))) {
          return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Manager access required.' } });
        }
      } else if (!member) {
        return res.status(403).json({ ok: false, error: { code: 'NOT_ENROLLED', message: 'You are not enrolled in attendance.' } });
      }
      req.member = member;
      next();
    } catch {
      return res.status(500).json({ ok: false, error: 'membership lookup failed' });
    }
  };
}
const emp = withMember();
const manager = withMember({ manager: true });

// Who am I here? role=null → no access (the launcher hides the app).
app.get('/api/me', async (req, res) => {
  let ctx;
  try { ctx = await verifyToken(req.get('Authorization')); }
  catch (e) { return res.status(e.status || 401).json({ ok: false, error: e.message }); }
  const member = await db.getMembership(ctx.tenantId, ctx.sub);
  const admin = isPlatformAdmin(ctx);
  res.json({ ok: true, data: {
    role: (member && member.role) || (admin ? 'manager' : null),
    enrolled: !!member,
    isPlatformAdmin: admin,
    member: member || null,
  }});
});

// ---- Employee REST hot path (Flutter) — any enrolled user -----------------
app.post('/api/checkIn', emp, async (req, res) => {
  const { zoneId = null, lat = null, lng = null, forWork = true, source = 'geofence' } = req.body || {};
  await db.recordEvent(req.ctx.tenantId, req.ctx.sub, 'check_in', { zoneId, lat, lng, forWork, source });
  res.json({ ok: true, data: await db.myStatus(req.ctx.tenantId, req.ctx.sub) });
});
app.post('/api/checkOut', emp, async (req, res) => {
  const { zoneId = null, lat = null, lng = null, source = 'geofence' } = req.body || {};
  await db.recordEvent(req.ctx.tenantId, req.ctx.sub, 'check_out', { zoneId, lat, lng, source });
  res.json({ ok: true, data: await db.myStatus(req.ctx.tenantId, req.ctx.sub) });
});
app.get('/api/getMyStatus', emp, async (req, res) => res.json({ ok: true, data: await db.myStatus(req.ctx.tenantId, req.ctx.sub) }));
app.get('/api/getMyZones', emp, async (req, res) => res.json({ ok: true, data: await db.listZones(req.ctx.tenantId) }));
app.get('/api/getMyHistory', emp, async (req, res) =>
  res.json({ ok: true, data: await db.myHistory(req.ctx.tenantId, req.ctx.sub, Number(req.query.days) || 7) }));

// ---- Manager REST — team/roles, zones, presence, settings -----------------
// Merge the tenant roster (from the main system) with plugin memberships so the
// admin sees every user and their assigned role (or none).
app.get('/api/admin/members', manager, async (req, res) => {
  const tenantId = req.ctx.tenantId;
  const [roster, members] = await Promise.all([
    fetchRoster(tenantId).catch(() => []),
    db.listMembers(tenantId),
  ]);
  const byId = new Map(members.map((m) => [m.employeeRef, m]));
  const rows = roster.map((u) => {
    const m = byId.get(String(u.id));
    return {
      employeeRef: String(u.id),
      name: u.name || (m && m.name) || '',
      email: u.email || (m && m.email) || '',
      role: (m && m.role) || null,
      payRate: (m && m.payRate) ?? null,
    };
  });
  for (const m of members) {
    if (!roster.some((u) => String(u.id) === m.employeeRef)) {
      rows.push({ employeeRef: m.employeeRef, name: m.name, email: m.email, role: m.role, payRate: m.payRate });
    }
  }
  res.json({ ok: true, data: rows });
});
app.post('/api/admin/members', manager, async (req, res) => {
  const { employeeRef, role = 'staff', payRate = null, name = '', email = '' } = req.body || {};
  if (!employeeRef) return res.status(400).json({ ok: false, error: 'employeeRef required' });
  res.json({ ok: true, data: await db.upsertMember(req.ctx.tenantId, { employeeRef, role, payRate, name, email }) });
});
app.delete('/api/admin/members/:id', manager, async (req, res) =>
  res.json({ ok: true, data: await db.removeMember(req.ctx.tenantId, req.params.id) }));

app.get('/api/admin/settings', manager, async (req, res) =>
  res.json({ ok: true, data: { timezone: await db.getTenantTimezone(req.ctx.tenantId) } }));
app.put('/api/admin/settings', manager, async (req, res) =>
  res.json({ ok: true, data: await db.setTenantTimezone(req.ctx.tenantId, (req.body || {}).timezone || 'UTC') }));

app.get('/api/admin/zones', manager, async (req, res) => res.json({ ok: true, data: await db.listZones(req.ctx.tenantId) }));
app.post('/api/admin/zones', manager, async (req, res) => res.json({ ok: true, data: await db.createZone(req.ctx.tenantId, req.body || {}) }));
app.delete('/api/admin/zones/:id', manager, async (req, res) =>
  res.json({ ok: true, data: await db.deleteZone(req.ctx.tenantId, req.params.id) }));
app.get('/api/admin/presence', manager, async (req, res) => res.json({ ok: true, data: await db.presence(req.ctx.tenantId) }));

// Approvals: the manager reviews day summaries and approves/rejects them.
app.get('/api/admin/approvals', manager, async (req, res) =>
  res.json({ ok: true, data: await db.listApprovals(req.ctx.tenantId, {
    from: req.query.from || null, to: req.query.to || null, status: req.query.status || null,
  }) }));
app.post('/api/admin/approvals', manager, async (req, res) => {
  const { employeeRef, day, status = 'approved' } = req.body || {};
  if (!employeeRef || !day) return res.status(400).json({ ok: false, error: 'employeeRef and day required' });
  res.json({ ok: true, data: await db.setApproval(req.ctx.tenantId, employeeRef, day, status, req.ctx.sub) });
});

// Manual entry: log an event on a staff member's behalf (fallback / correction).
app.post('/api/admin/manual-entry', manager, async (req, res) => {
  const { employeeRef, type = 'check_in', at = null } = req.body || {};
  if (!employeeRef) return res.status(400).json({ ok: false, error: 'employeeRef required' });
  res.json({ ok: true, data: await db.manualEntry(req.ctx.tenantId, employeeRef, type, at) });
});

// EOD report — per-employee hours + approved pay (the QuickBooks export basis).
app.get('/api/admin/report', manager, async (req, res) =>
  res.json({ ok: true, data: await db.report(req.ctx.tenantId, { from: req.query.from || null, to: req.query.to || null }) }));

// ---- Embedded UI: static shell + a context endpoint (UI session token) ----
app.get('/app', (req, res) => res.sendFile(join(__dirname, '..', 'public', 'app.html')));
app.get('/api/ui/context', authMiddleware({ surface: 'ui' }), async (req, res) => {
  const member = await db.getMembership(req.ctx.tenantId, req.ctx.sub);
  const admin = isPlatformAdmin(req.ctx);
  res.json({
    ok: true,
    tenant: req.ctx.tenantId,
    name: req.ctx.email || req.ctx.sub,
    role: (member && member.role) || (admin ? 'manager' : null),
    isPlatformAdmin: admin,
  });
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`attendance plugin listening on :${port}`));
