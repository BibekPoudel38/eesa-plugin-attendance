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
import { fetchRoster, rosterHealth } from './roster.js';
import { notifyUser } from './notify.js';

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

// Self-hosted front-end vendor assets (Leaflet for the zone map), served at
// /vendor/* so app.html can load them same-origin (no CDN dependency).
app.use('/vendor', express.static(join(__dirname, '..', 'public', 'vendor'), {
  maxAge: '30d', immutable: true,
}));

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

// Platform → plugin: "who was present today" for the generic audience resolver
// (Flow's presence-gated recipients). Authed by a gateway SERVICE token
// (sub='gateway') or a tenant admin — never a plain staff token. Tenant-scoped
// by the token, so it can only read its own tenant's presence.
app.get('/api/present', async (req, res) => {
  let ctx;
  try { ctx = await verifyToken(req.get('Authorization')); }
  catch (e) { return res.status(e.status || 401).json({ ok: false, error: e.message }); }
  if (ctx.sub !== 'gateway' && !isPlatformAdmin(ctx)) {
    return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Service or admin token required.' } });
  }
  res.json({ ok: true, data: { present: await db.presentToday(ctx.tenantId) } });
});

// ---- Employee REST hot path (Flutter) — any enrolled user -----------------
app.post('/api/checkIn', emp, async (req, res) => {
  const { zoneId = null, lat = null, lng = null, forWork = true, source = 'geofence', workType = null } = req.body || {};
  await db.recordEvent(req.ctx.tenantId, req.ctx.sub, 'check_in', { zoneId, lat, lng, forWork, source, workType });
  res.json({ ok: true, data: await db.myStatus(req.ctx.tenantId, req.ctx.sub) });
});
app.post('/api/checkOut', emp, async (req, res) => {
  const { zoneId = null, lat = null, lng = null, source = 'geofence' } = req.body || {};
  await db.recordEvent(req.ctx.tenantId, req.ctx.sub, 'check_out', { zoneId, lat, lng, source });
  res.json({ ok: true, data: await db.myStatus(req.ctx.tenantId, req.ctx.sub) });
});

// Employee taps a LOCATION NFC tag with their OWN phone → check-in, or check-out
// if already in (tap-to-toggle). The tag maps to a zone; the event is source=nfc.
app.post('/api/checkInNfc', emp, async (req, res) => {
  const { uid, lat = null, lng = null, workType = null } = req.body || {};
  const tag = await db.resolveNfcTag(req.ctx.tenantId, uid);
  if (!tag) {
    return res.status(404).json({ ok: false, error: { code: 'UNKNOWN_TAG', message: 'This NFC tag is not registered for your workspace.' } });
  }
  if (tag.kind !== 'location') {
    return res.status(400).json({ ok: false, error: { code: 'WRONG_TAG', message: 'That is an employee badge, not a location tag — tap it on the kiosk instead.' } });
  }
  const before = await db.myStatus(req.ctx.tenantId, req.ctx.sub);
  const type = before.checkedIn ? 'check_out' : 'check_in';
  await db.recordEvent(req.ctx.tenantId, req.ctx.sub, type, { zoneId: tag.zoneId, lat, lng, source: 'nfc', workType });
  res.json({ ok: true, data: { action: type, tag: tag.label || tag.uid, status: await db.myStatus(req.ctx.tenantId, req.ctx.sub) } });
});

// Kiosk mode: a shared device taps an employee BADGE → check-in/out for that
// employee. Manager/admin-authed (a dedicated kiosk-device token can replace
// this later). Physical badge + attended device resists buddy-punching.
app.post('/api/kiosk/nfc', manager, async (req, res) => {
  const { uid, lat = null, lng = null } = req.body || {};
  const tag = await db.resolveNfcTag(req.ctx.tenantId, uid);
  if (!tag || tag.kind !== 'badge' || !tag.employeeRef) {
    return res.status(404).json({ ok: false, error: { code: 'UNKNOWN_BADGE', message: 'This badge is not registered to an employee.' } });
  }
  const before = await db.myStatus(req.ctx.tenantId, tag.employeeRef);
  const type = before.checkedIn ? 'check_out' : 'check_in';
  await db.recordEvent(req.ctx.tenantId, tag.employeeRef, type, { zoneId: tag.zoneId, lat, lng, source: 'nfc' });
  res.json({ ok: true, data: { action: type, employeeRef: tag.employeeRef, status: await db.myStatus(req.ctx.tenantId, tag.employeeRef) } });
});
app.get('/api/getMyStatus', emp, async (req, res) => res.json({ ok: true, data: await db.myStatus(req.ctx.tenantId, req.ctx.sub) }));
app.get('/api/getMyZones', emp, async (req, res) => res.json({ ok: true, data: await db.listZones(req.ctx.tenantId) }));
app.get('/api/getMyHistory', emp, async (req, res) =>
  res.json({ ok: true, data: await db.myHistory(req.ctx.tenantId, req.ctx.sub, Number(req.query.days) || 7) }));
// The work types THIS user may pick at check-in ("here to work?" prompt).
app.get('/api/getMyWorkTypes', emp, async (req, res) =>
  res.json({ ok: true, data: await db.myWorkTypes(req.ctx.tenantId, req.ctx.sub) }));

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
  const out = { ok: true, data: rows };
  // Nothing to show → attach a self-diagnosis (why the roster came back empty)
  // so the admin sees the actual reason instead of a blank table.
  if (rows.length === 0) out.diag = await rosterHealth(tenantId);
  res.json(out);
});
app.post('/api/admin/members', manager, async (req, res) => {
  const { employeeRef, role = 'staff', payRate = null, name = '', email = '', workTypeIds } = req.body || {};
  if (!employeeRef) return res.status(400).json({ ok: false, error: 'employeeRef required' });
  res.json({ ok: true, data: await db.upsertMember(req.ctx.tenantId, { employeeRef, role, payRate, name, email, workTypeIds }) });
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
  const result = await db.setApproval(req.ctx.tenantId, employeeRef, day, status, req.ctx.sub);
  // Nothing to approve if no timesheet exists for that day (e.g. a scheduled but
  // unworked absence). Don't claim success / notify.
  if (!result.updated) {
    return res.status(404).json({ ok: false, error: { code: 'NO_TIMESHEET', message: 'No attendance recorded for that day.' } });
  }
  // Notify the staff member of the decision (best-effort, non-blocking).
  const verb = status === 'rejected' ? 'rejected' : status === 'pending' ? 'reset to pending' : 'approved';
  notifyUser(req.ctx.tenantId, employeeRef, {
    title: `Timesheet ${verb}`,
    body: `Your attendance for ${day} was ${verb}.`,
    type: 'attendance_approved',
    data: { day: String(day), status: String(status) },
  });
  res.json({ ok: true, data: result });
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

// Optional per-person, per-day schedule (expected hours) → Actual vs Expected.
app.get('/api/admin/schedules', manager, async (req, res) =>
  res.json({ ok: true, data: await db.listSchedules(req.ctx.tenantId, {
    from: req.query.from || null, to: req.query.to || null, employeeRef: req.query.employeeRef || null,
  }) }));
app.post('/api/admin/schedules', manager, async (req, res) => {
  const { employeeRef, day, expectedMinutes = null, expectedHours = null, note = '', templateId = null } = req.body || {};
  if (!employeeRef || !day) return res.status(400).json({ ok: false, error: 'employeeRef and day required' });
  const mins = expectedMinutes != null
    ? Number(expectedMinutes)
    : (expectedHours != null ? Math.round(Number(expectedHours) * 60) : null);
  try {
    res.json({ ok: true, data: await db.upsertSchedule(req.ctx.tenantId, { employeeRef, day, expectedMinutes: mins, note, templateId }) });
  } catch (e) { res.status(e.status || 400).json({ ok: false, error: e.message }); }
});
app.delete('/api/admin/schedules/:employeeRef/:day', manager, async (req, res) =>
  res.json({ ok: true, data: await db.removeSchedule(req.ctx.tenantId, req.params.employeeRef, req.params.day) }));

// Reusable schedule templates (the library assigned via a schedule row).
app.get('/api/admin/templates', manager, async (req, res) =>
  res.json({ ok: true, data: await db.listTemplates(req.ctx.tenantId) }));
app.post('/api/admin/templates', manager, async (req, res) => {
  try { res.json({ ok: true, data: await db.upsertTemplate(req.ctx.tenantId, req.body || {}) }); }
  catch (e) { res.status(e.status || 400).json({ ok: false, error: e.message }); }
});
app.delete('/api/admin/templates/:id', manager, async (req, res) =>
  res.json({ ok: true, data: await db.removeTemplate(req.ctx.tenantId, req.params.id) }));

// Work-type catalog (assigned per user in Team; picked at check-in).
app.get('/api/admin/work-types', manager, async (req, res) =>
  res.json({ ok: true, data: await db.listWorkTypes(req.ctx.tenantId) }));
app.post('/api/admin/work-types', manager, async (req, res) => {
  try { res.json({ ok: true, data: await db.upsertWorkType(req.ctx.tenantId, req.body || {}) }); }
  catch (e) { res.status(e.status || 400).json({ ok: false, error: e.message }); }
});
app.delete('/api/admin/work-types/:id', manager, async (req, res) =>
  res.json({ ok: true, data: await db.removeWorkType(req.ctx.tenantId, req.params.id) }));

// NFC tag registry — location stickers (mapped to a zone) + employee badges.
// The app/kiosk scans a chip and POSTs its UID here to register it.
app.get('/api/admin/nfc-tags', manager, async (req, res) =>
  res.json({ ok: true, data: await db.listNfcTags(req.ctx.tenantId) }));
app.post('/api/admin/nfc-tags', manager, async (req, res) => {
  try { res.json({ ok: true, data: await db.registerNfcTag(req.ctx.tenantId, req.body || {}) }); }
  catch (e) { res.status(e.status || 400).json({ ok: false, error: e.message }); }
});
app.delete('/api/admin/nfc-tags/:id', manager, async (req, res) =>
  res.json({ ok: true, data: await db.removeNfcTag(req.ctx.tenantId, req.params.id) }));

// ---- Embedded UI: static shell + a context endpoint (UI session token) ----
app.get('/app', (req, res) => res.sendFile(join(__dirname, '..', 'public', 'app.html')));
app.get('/api/ui/context', authMiddleware({ surface: 'ui' }), async (req, res) => {
  const member = await db.getMembership(req.ctx.tenantId, req.ctx.sub);
  const admin = isPlatformAdmin(req.ctx);
  // Wrap in `data` — the UI's api() helper returns j.data, like every other
  // endpoint. Top-level fields here made CTX undefined → "reading 'name'".
  res.json({
    ok: true,
    data: {
      tenant: req.ctx.tenantId,
      name: req.ctx.email || req.ctx.sub,
      role: (member && member.role) || (admin ? 'manager' : null),
      isPlatformAdmin: admin,
    },
  });
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`attendance plugin listening on :${port}`));
