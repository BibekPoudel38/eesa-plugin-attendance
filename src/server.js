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
import { notifyUser, notifyUsers } from './notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(readFileSync(join(__dirname, '..', 'manifest.json'), 'utf-8'));
const serverInfo = { name: MANIFEST.slug, version: MANIFEST.version };

const app = express();
app.use(express.json());

// ---- Async route safety ----------------------------------------------------
// Express 4 does NOT catch a rejected promise from an `async` handler. Node then
// treats it as an unhandled rejection and KILLS THE PROCESS — so one database
// hiccup took the whole service down and Coolify restarted it into a crash
// loop, with the request never answered and the real cause buried in a restart
// storm. A plugin must degrade to a 500, not to a dead container.
//
// Wrapping at registration covers every route, including ones added later, so
// this can't be forgotten at a single call site the way a per-route try/catch
// can. Handlers with 4 args are Express error middleware and are left alone.
const wrapAsync = (fn) =>
  typeof fn !== 'function' || fn.length === 4
    ? fn
    : (req, res, next) => {
        try {
          return Promise.resolve(fn(req, res, next)).catch(next);
        } catch (e) {
          return next(e);
        }
      };

for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
  const original = app[method].bind(app);
  app[method] = (path, ...handlers) =>
    // app.get('setting') is also Express's config READER — only a call that
    // actually passes handlers is a route registration.
    handlers.length ? original(path, ...handlers.map(wrapAsync)) : original(path);
}

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

// Liveness: the process is up. Deliberately does NOT touch the database, so a
// database outage can't make the orchestrator kill an otherwise-healthy
// container (and so the Flutter app's reachability probe still distinguishes
// "can't reach the host" from "the host is fine, the database isn't").
app.get('/health', (req, res) => res.json({ ok: true, plugin: MANIFEST.slug }));

// Readiness: can we actually reach Postgres? Reports the failing HOSTNAME and
// the errno, because the usual cause is a DATABASE_URL pointing at a service
// name this container cannot resolve — and "getaddrinfo EAI_AGAIN <uuid>" in a
// restart-looping log is a lot harder to act on than this is.
app.get('/health/db', async (req, res) => {
  try {
    await db.ping();
    res.json({ ok: true, database: 'reachable' });
  } catch (e) {
    res.status(503).json({
      ok: false,
      database: 'unreachable',
      code: e.code || null,
      host: e.hostname || db.dbHost(),
      hint:
        e.code === 'EAI_AGAIN' || e.code === 'ENOTFOUND'
          ? 'The database hostname in DATABASE_URL does not resolve from this container. Check that the database service is running and on the same network as this app.'
          : 'The database rejected or dropped the connection. Check DATABASE_URL credentials and PGSSL.',
    });
  }
});

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

// The Eesa-owned "appRole" claim is the AUTHORITY for admin/staff/none — derived
// server-side from the acting user's attendance positions (attendance-admin →
// admin, attendance-required → staff, precedence admin > staff). The plugin's
// own membership.role no longer decides access; the membership row survives only
// to carry pay_rate/work_types. During rollout a platform tenant-admin whose
// positions haven't been minted yet still bootstraps as admin so nobody is
// locked out of management. Returns 'admin' | 'staff' | null.
function appRoleOf(ctx) {
  const claim = String(ctx.appRole || '').toLowerCase();
  if (claim === 'admin') return 'admin';
  if (claim === 'staff') return 'staff';
  if (!claim && isPlatformAdmin(ctx)) return 'admin'; // bootstrap fallback
  return null;
}
// The UI shell branches on a 'manager' | 'staff' | null vocabulary; map onto it.
function uiRoleOf(ctx) {
  const r = appRoleOf(ctx);
  return r === 'admin' ? 'manager' : r === 'staff' ? 'staff' : null;
}
function withMember({ manager = false } = {}) {
  return async (req, res, next) => {
    try {
      req.ctx = await verifyToken(req.get('Authorization'));
    } catch (e) {
      return res.status(e.status || 401).json({ ok: false, error: e.message });
    }
    try {
      // The membership row is loaded only for pay_rate/work_types (and as a
      // legacy fallback below); it no longer decides access. The Eesa-owned
      // appRole claim is the authority. UI-session tokens carry appRole; the
      // Flutter hot-path token may not, so we fall back to membership existence
      // there to avoid breaking check-in during rollout.
      const member = await db.getMembership(req.ctx.tenantId, req.ctx.sub);
      const role = appRoleOf(req.ctx); // 'admin' | 'staff' | null (+platform bootstrap)
      if (manager) {
        // appRole is the authority whenever the token carries the claim. The
        // legacy manager-membership fallback applies ONLY to tokens with no
        // appRole claim at all (the Flutter hot-path), so a user demoted to
        // staff in Eesa (appRole='staff') can never regain manager access via a
        // stale membership.role='manager' row.
        const hasAppRoleClaim = req.ctx.appRole != null && String(req.ctx.appRole) !== '';
        if (!(role === 'admin' || (!hasAppRoleClaim && member && member.role === 'manager'))) {
          return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Admin access required.' } });
        }
      } else if (!(role !== null || member)) {
        return res.status(403).json({ ok: false, error: { code: 'NOT_ENROLLED', message: 'You are not enrolled in attendance.' } });
      }
      req.member = member;
      req.appRole = role;
      next();
    } catch (e) {
      // Hand the real error to the central handler rather than flattening every
      // cause into "membership lookup failed". A database that can't be reached
      // is a 503 the client should retry, not a 500 it should give up on — and
      // swallowing it here meant EVERY enrolled-user route reported the wrong
      // status and a message that named nothing.
      return next(e);
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
  // appRole (Eesa authority) decides access; the membership row is kept only for
  // pay_rate/work_types and no longer drives role.
  const appRole = appRoleOf(ctx);
  res.json({ ok: true, data: {
    appRole,                     // 'admin' | 'staff' | null (authority)
    role: uiRoleOf(ctx),         // 'manager' | 'staff' | null (UI vocabulary)
    enrolled: appRole !== null,
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

// ---- Who counts as a manager ----------------------------------------------

/// The people whose word settles whether someone was on site.
///
/// Read from the Eesa ROSTER (`attendanceRole === 'admin'`), not from the
/// plugin's own memberships table. Membership.role is legacy — /api/me says so
/// itself ("appRole (Eesa authority) decides access; the membership row is kept
/// only for pay_rate/work_types and no longer drives role") — and on the live
/// workspace it disagrees badly: the only row marked 'manager' is a dormant
/// Apple review account, while the three actual admins are all 'staff' there.
/// Trusting it sent every "Is X here?" to an account nobody reads, and held the
/// admins' own shifts for a confirmation they were the ones meant to give.
///
/// Falls back to memberships only when the roster cannot be reached, because a
/// stale audience is better than none.
async function managerAudience(tenantId) {
  try {
    const roster = await fetchRoster(tenantId);
    const admins = roster
      .filter((u) => String(u.attendanceRole || '').toLowerCase() === 'admin')
      .map((u) => String(u.id));
    if (admins.length) return admins;
  } catch {
    /* fall through */
  }
  return db.managerRefs(tenantId).catch(() => []);
}

/// Whether this shift needs someone else to vouch for it.
///
/// False for an admin's own arrival — they are the authority the question would
/// be put to — and false when there is no OTHER admin to ask, since a question
/// with nobody to answer it only ever resolves to an alert nobody could have
/// prevented.
async function shouldConfirm(tenantId, employeeRef) {
  const managers = await managerAudience(tenantId);
  if (managers.some((r) => String(r) === String(employeeRef))) return false;
  return managers.length > 0;
}

// ---- Punch notifications ---------------------------------------------------

/// Clock time in the tenant's own timezone, as a person writes it.
///
/// The tenant timezone — not the server's and not the phone's — because this
/// string ends up next to the day totals, and those are already cut on the
/// tenant's local midnight. A push saying "checked in at 01:03" for a 18:03
/// shift is how you lose someone's trust in the whole timesheet.
function clockAt(when, timezone) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone || 'UTC',
    }).format(when instanceof Date ? when : new Date(when));
  } catch {
    return '';
  }
}

/// "8h 09m", the way hours are said out loud rather than "489 minutes".
function spanOf(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

/// Tell the employee — and, depending on the tenant's policy, the managers —
/// that a punch was recorded.
///
/// Every send is fire-and-forget and the whole function is wrapped: this runs
/// after the punch is already committed, so nothing in here is allowed to turn
/// a recorded shift into a failed request. The caller does not await it.
async function announcePunch(tenantId, employeeRef, type, status) {
  try {
    const isIn = type === 'check_in';
    const { timezone, managerNotify } = await db.getTenantSettings(tenantId);
    const at = clockAt(isIn ? (status.since || new Date()) : new Date(), timezone);
    const where = status.zoneName ? ` · ${status.zoneName}` : '';
    const worked = status.today && status.today.totalMinutes;

    // The employee. This is the disclosure that matters most: the geofence can
    // punch someone in while their phone is in their pocket, and until now the
    // only notification said "Are you here to work?" without ever confirming
    // what was actually recorded, or when.
    notifyUser(tenantId, employeeRef, {
      title: isIn ? `Checked in at ${at}` : `Checked out at ${at}`,
      body: isIn
        ? `Your arrival was recorded${where}.`
        : `${spanOf(worked)} today${where}.`,
      type: isIn ? 'attendance_check_in' : 'attendance_check_out',
      data: { punch: type, at, zone: status.zoneName || '', minutes: String(worked || 0) },
    });

    if (managerNotify === 'off') return;

    // An exception is a punch a manager would actually do something about. Right
    // now that means one whose location could not be confirmed — someone punched
    // with no usable GPS fix, or outside the zone they claimed. "Late" and
    // "never checked out" are deliberately NOT here: both need the day to be
    // over (or a schedule to compare against) and belong to an end-of-day pass,
    // not to the moment of the punch. Guessing at them with a hard-coded 9am
    // would be wrong for every workspace that doesn't start at nine.
    const unverified = status.verification && status.verification !== 'verified';
    if (managerNotify === 'exceptions' && !unverified) return;

    const managers = (await managerAudience(tenantId)).filter((r) => String(r) !== String(employeeRef));
    if (!managers.length) return;
    const who = await db.displayName(tenantId, employeeRef);
    notifyUsers(tenantId, managers, {
      title: unverified
        ? `${who} — unconfirmed ${isIn ? 'check-in' : 'check-out'}`
        : `${who} ${isIn ? 'checked in' : 'checked out'} at ${at}`,
      body: unverified
        ? `Recorded at ${at}${where}, but the location could not be confirmed.`
        : isIn ? `Arrived${where}.` : `${spanOf(worked)} today${where}.`,
      type: 'attendance_manager',
      data: { punch: type, employeeRef: String(employeeRef), at, unverified: String(Boolean(unverified)) },
    });
  } catch (e) {
    console.error('[attendance] punch notification failed:', e && e.message);
  }
}

/// Ask the managers to vouch that this person is actually on site.
///
/// The clock is ALREADY running — confirmation never gates it. Someone who has
/// walked into work should not have their pay wait on a manager reading a
/// notification, and a system that stops the clock when nobody answers punishes
/// the wrong person. What confirmation buys is a record of who vouched, and a
/// loud gap when nobody did.
async function askManagersToConfirm(tenantId, employeeRef, ev, status) {
  try {
    const managers = (await managerAudience(tenantId)).filter((r) => String(r) !== String(employeeRef));
    if (!managers.length) return;
    const { timezone } = await db.getTenantSettings(tenantId);
    const who = await db.displayName(tenantId, employeeRef);
    const at = clockAt(ev.at || new Date(), timezone);
    const where = status.zoneName ? ` at ${status.zoneName}` : '';
    notifyUsers(tenantId, managers, {
      title: `Is ${who} here?`,
      body: `Checked in at ${at}${where}. Confirm it in Attendance — the clock is already running.`,
      type: 'attendance_confirm',
      data: { eventId: String(ev.id || ''), employeeRef: String(employeeRef), at },
    });
  } catch (e) {
    console.error('[attendance] confirmation request failed:', e && e.message);
  }
}

/// Nobody answered, and the shift is now over. Tell both sides, once.
///
/// Both — not just the manager — because the hours are the employee's. A shift
/// that goes onto a timesheet marked unconfirmed can be queried later, and the
/// person it belongs to is entitled to know that before payday rather than
/// after it.
async function flagUnconfirmedShift(tenantId, employeeRef, checkIn, status) {
  try {
    const { timezone } = await db.getTenantSettings(tenantId);
    const worked = spanOf(status.today && status.today.totalMinutes);
    const at = clockAt(checkIn.at, timezone);
    const who = await db.displayName(tenantId, employeeRef);

    notifyUser(tenantId, employeeRef, {
      title: `${worked} recorded, not confirmed`,
      body: `Your check-in at ${at} was never confirmed by a manager. The hours are recorded — ask them to approve the day.`,
      type: 'attendance_unconfirmed',
      data: { minutes: String((status.today && status.today.totalMinutes) || 0), at },
    });

    const managers = (await managerAudience(tenantId)).filter((r) => String(r) !== String(employeeRef));
    if (!managers.length) return;
    notifyUsers(tenantId, managers, {
      title: `${who} clocked ${worked} — unconfirmed`,
      body: `Checked in at ${at} and has now left. Nobody confirmed they were there.`,
      type: 'attendance_unconfirmed',
      data: { employeeRef: String(employeeRef), minutes: String((status.today && status.today.totalMinutes) || 0), at },
    });
  } catch (e) {
    console.error('[attendance] unconfirmed-shift alert failed:', e && e.message);
  }
}

// ---- Employee REST hot path (Flutter) — any enrolled user -----------------
app.post('/api/checkIn', emp, async (req, res) => {
  const { zoneId = null, lat = null, lng = null, accuracyM = null, forWork = true, source = 'geofence', workType = null } = req.body || {};
  // Whether a human has to vouch for this shift. Read BEFORE the insert, because
  // it decides how the punch is stored — not just who gets told about it.
  const { requireConfirmation } = await db.getTenantSettings(req.ctx.tenantId).catch(() => ({}));
  // Three things have to be true before a shift is held for someone's word:
  // the workspace asks for it, this is a real shift (a visit marked "not for
  // work" claims no hours, so there is nothing to vouch for), and there is
  // actually somebody whose answer would mean anything — which excludes a
  // manager's own arrival and a roster with no other manager on it.
  const needsConfirm = Boolean(requireConfirmation)
    && forWork !== false
    && await shouldConfirm(req.ctx.tenantId, req.ctx.sub).catch(() => false);
  const ev = await db.recordEvent(req.ctx.tenantId, req.ctx.sub, 'check_in', {
    zoneId, lat, lng, accuracyM, forWork, source, workType,
    requireConfirm: needsConfirm,
  });
  const status = await db.myStatus(req.ctx.tenantId, req.ctx.sub);
  // A repeated arrival records nothing, so it announces nothing. The OS fires
  // "entered" every time it re-registers a fence you are standing inside — six
  // in a morning is normal — and six identical pushes would be the fastest way
  // to get attendance notifications muted.
  if (!ev.duplicate) {
    announcePunch(req.ctx.tenantId, req.ctx.sub, 'check_in', status);
    if (ev.pending) askManagersToConfirm(req.ctx.tenantId, req.ctx.sub, ev, status);
  }
  res.json({ ok: true, data: status });
});
app.post('/api/checkOut', emp, async (req, res) => {
  const { zoneId = null, lat = null, lng = null, accuracyM = null, source = 'geofence' } = req.body || {};
  // Look for the outstanding question BEFORE recording the departure: the punch
  // that closes the shift is also the moment the chance to confirm it in person
  // has gone.
  const outstanding = await db.unconfirmedOpenCheckIn(req.ctx.tenantId, req.ctx.sub).catch(() => null);
  const ev = await db.recordEvent(req.ctx.tenantId, req.ctx.sub, 'check_out', { zoneId, lat, lng, accuracyM, source });
  const status = await db.myStatus(req.ctx.tenantId, req.ctx.sub);
  if (!ev.duplicate) {
    announcePunch(req.ctx.tenantId, req.ctx.sub, 'check_out', status);
    if (outstanding) {
      // Settle it before anyone is told. The alert says the shift went
      // unconfirmed, and it must be true of the record by the time it lands —
      // not a claim the timesheet still contradicts because the punch is
      // sitting in 'pending' waiting for an answer the day has run out of.
      await db.markUnconfirmed(req.ctx.tenantId, outstanding.id).catch(() => null);
      flagUnconfirmedShift(req.ctx.tenantId, req.ctx.sub, outstanding, status);
    }
  }
  res.json({ ok: true, data: status });
});

// Employee taps a LOCATION NFC tag with their OWN phone → check-in, or check-out
// if already in (tap-to-toggle). The tag maps to a zone; the event is source=nfc.
app.post('/api/checkInNfc', emp, async (req, res) => {
  const { uid, lat = null, lng = null, accuracyM = null, workType = null } = req.body || {};
  const tag = await db.resolveNfcTag(req.ctx.tenantId, uid);
  if (!tag) {
    return res.status(404).json({ ok: false, error: { code: 'UNKNOWN_TAG', message: 'This NFC tag is not registered for your workspace.' } });
  }
  if (tag.kind !== 'location') {
    return res.status(400).json({ ok: false, error: { code: 'WRONG_TAG', message: 'That is an employee badge, not a location tag — tap it on the kiosk instead.' } });
  }
  const before = await db.myStatus(req.ctx.tenantId, req.ctx.sub);
  const type = before.checkedIn ? 'check_out' : 'check_in';
  await db.recordEvent(req.ctx.tenantId, req.ctx.sub, type, { zoneId: tag.zoneId, lat, lng, accuracyM, source: 'nfc', workType });
  res.json({ ok: true, data: { action: type, tag: tag.label || tag.uid, status: await db.myStatus(req.ctx.tenantId, req.ctx.sub) } });
});

// Kiosk mode: a shared device taps an employee BADGE → check-in/out for that
// employee. Manager/admin-authed (a dedicated kiosk-device token can replace
// this later). Physical badge + attended device resists buddy-punching.
app.post('/api/kiosk/nfc', manager, async (req, res) => {
  const { uid, lat = null, lng = null, accuracyM = null } = req.body || {};
  const tag = await db.resolveNfcTag(req.ctx.tenantId, uid);
  if (!tag || tag.kind !== 'badge' || !tag.employeeRef) {
    return res.status(404).json({ ok: false, error: { code: 'UNKNOWN_BADGE', message: 'This badge is not registered to an employee.' } });
  }
  const before = await db.myStatus(req.ctx.tenantId, tag.employeeRef);
  const type = before.checkedIn ? 'check_out' : 'check_in';
  await db.recordEvent(req.ctx.tenantId, tag.employeeRef, type, { zoneId: tag.zoneId, lat, lng, accuracyM, source: 'nfc' });
  res.json({ ok: true, data: { action: type, employeeRef: tag.employeeRef, status: await db.myStatus(req.ctx.tenantId, tag.employeeRef) } });
});
app.get('/api/getMyStatus', emp, async (req, res) => res.json({ ok: true, data: await db.myStatus(req.ctx.tenantId, req.ctx.sub) }));
app.get('/api/getMyZones', emp, async (req, res) => res.json({ ok: true, data: await db.listZones(req.ctx.tenantId) }));
app.get('/api/getMyHistory', emp, async (req, res) =>
  res.json({ ok: true, data: await db.myHistory(req.ctx.tenantId, req.ctx.sub, Number(req.query.days) || 7, {
    from: req.query.from || null, to: req.query.to || null,
  }) }));
// A staff member's OWN punches, with where each happened and whether that
// location could be confirmed. Self-scoped by the token — this never exposes
// anyone else's movements. Unverified punches are returned like any other; the
// client marks them rather than hiding them.
app.get('/api/getMyEvents', emp, async (req, res) =>
  res.json({ ok: true, data: await db.myEvents(req.ctx.tenantId, req.ctx.sub, {
    from: req.query.from || null, to: req.query.to || null, days: req.query.days || null,
  }) }));
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
      // The saved job-type assignment has to come back, or the Team tab's
      // checkboxes render unticked for someone who HAS types assigned — and the
      // next Save (even one that only touched the pay rate) posts that empty
      // set straight back and wipes the assignment.
      workTypeIds: (m && m.workTypeIds) || [],
    };
  });
  for (const m of members) {
    if (!roster.some((u) => String(u.id) === m.employeeRef)) {
      rows.push({
        employeeRef: m.employeeRef, name: m.name, email: m.email,
        role: m.role, payRate: m.payRate, workTypeIds: m.workTypeIds || [],
      });
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
  res.json({ ok: true, data: await db.getTenantSettings(req.ctx.tenantId) }));
app.put('/api/admin/settings', manager, async (req, res) => {
  const body = req.body || {};
  // Only touch what was sent. Saving the timezone from the Setup screen must not
  // silently reset a notification policy the screen didn't show.
  res.json({ ok: true, data: await db.setTenantSettings(req.ctx.tenantId, {
    ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
    ...(body.managerNotify !== undefined ? { managerNotify: body.managerNotify } : {}),
  }) });
});

app.get('/api/admin/zones', manager, async (req, res) => res.json({ ok: true, data: await db.listZones(req.ctx.tenantId) }));
app.post('/api/admin/zones', manager, async (req, res) => res.json({ ok: true, data: await db.createZone(req.ctx.tenantId, req.body || {}) }));
app.delete('/api/admin/zones/:id', manager, async (req, res) =>
  res.json({ ok: true, data: await db.deleteZone(req.ctx.tenantId, req.params.id) }));
// Who's in today + where each person last was. The plugin only knows the names
// it happens to have on a membership row (usually blank), so merge the tenant
// roster over the top exactly as /admin/members does — a table of bare numeric
// employeeRefs is unreadable to the admin who has to act on it.
// Who is waiting on you right now. The whole point of the Today screen.
app.get('/api/admin/confirmations', manager, async (req, res) =>
  res.json({ ok: true, data: await db.pendingConfirmations(req.ctx.tenantId) }));

// "Yes, they're here" / "No, they aren't."
app.post('/api/admin/confirm', manager, async (req, res) => {
  const { eventId, status = 'confirmed' } = req.body || {};
  if (!eventId) return res.status(400).json({ ok: false, error: 'eventId required' });
  const result = await db.setConfirmation(req.ctx.tenantId, eventId, status, req.ctx.sub);
  if (!result) {
    // Already answered, or not a pending check-in. A screen left open since this
    // morning must not be able to overwrite a decision someone else made since.
    return res.status(409).json({ ok: false, error: { code: 'ALREADY_HANDLED', message: 'That check-in has already been answered.' } });
  }
  // Tell the employee either way. Being vouched for is worth knowing, and being
  // marked absent is something they must not first discover on a payslip.
  const confirmed = result.confirmStatus === 'confirmed';
  notifyUser(req.ctx.tenantId, result.employeeRef, {
    title: confirmed ? 'Your shift was confirmed' : 'Your check-in was marked "not here"',
    body: confirmed
      ? 'A manager confirmed you are on site.'
      : 'A manager recorded that you were not on site at check-in. Speak to them if that is wrong.',
    type: 'attendance_confirmed',
    data: { status: result.confirmStatus },
  });
  res.json({ ok: true, data: result });
});

app.get('/api/admin/presence', manager, async (req, res) => {
  const tenantId = req.ctx.tenantId;
  const [data, roster] = await Promise.all([
    db.presence(tenantId),
    fetchRoster(tenantId).catch(() => []),
  ]);
  const byId = new Map(roster.map((u) => [String(u.id), u]));
  const employees = data.employees.map((e) => {
    const u = byId.get(String(e.employeeRef));
    return { ...e, name: (u && u.name) || e.name || '', email: (u && u.email) || '' };
  });
  res.json({ ok: true, data: { ...data, employees } });
});

// The raw punch log with positions — every event, where it was recorded, and
// how far that was from the zone centre. Manager-gated; staff read their own
// days (without other people's positions) via /getMyHistory.
app.get('/api/admin/events', manager, async (req, res) => {
  const tenantId = req.ctx.tenantId;
  const [rows, roster] = await Promise.all([
    db.eventLog(tenantId, {
      employeeRef: req.query.employeeRef || null,
      from: req.query.from || null,
      to: req.query.to || null,
      limit: req.query.limit || 500,
    }),
    fetchRoster(tenantId).catch(() => []),
  ]);
  const byId = new Map(roster.map((u) => [String(u.id), u]));
  res.json({ ok: true, data: rows.map((r) => {
    const u = byId.get(String(r.employeeRef));
    return { ...r, name: (u && u.name) || r.name || '' };
  }) });
});

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
// Every employee — including admins and anyone with no attendance yet — with
// their totals for the window. The raw report only covers people who already
// have day_summaries or a schedule, and carries whatever name the membership
// row happens to hold (usually blank), so merge the tenant roster over it the
// same way /admin/members does. Without this the report was a list of bare
// employeeRef numbers with everyone quiet simply missing.
app.get('/api/admin/report', manager, async (req, res) => {
  const tenantId = req.ctx.tenantId;
  const from = req.query.from || null;
  const to = req.query.to || null;
  const [rows, roster] = await Promise.all([
    db.report(tenantId, { from, to }),
    fetchRoster(tenantId).catch(() => []),
  ]);
  const byRef = new Map(rows.map((r) => [String(r.employeeRef), r]));
  const named = roster.map((u) => {
    const r = byRef.get(String(u.id));
    byRef.delete(String(u.id));
    return {
      ...(r || {
        employeeRef: String(u.id), days: 0, totalMinutes: 0, approvedMinutes: 0,
        expectedMinutes: 0, hasSchedule: false, differenceMinutes: 0,
        payRate: null, approvedPay: null,
      }),
      name: u.name || (r && r.name) || '',
      email: u.email || '',
    };
  });
  // Anyone with attendance who is no longer on the roster still has to appear.
  const orphans = [...byRef.values()];
  const data = [...named, ...orphans].sort((a, b) =>
    String(a.name || a.employeeRef).localeCompare(String(b.name || b.employeeRef)));
  res.json({ ok: true, data });
});

// One person's attendance in detail — every day in the window plus a monthly
// rollup — so an admin can click a name in the report and see how the total was
// made up. Manager-gated: staff read their own via /getMyHistory.
app.get('/api/admin/employee-report', manager, async (req, res) => {
  const employeeRef = String(req.query.employeeRef || '').trim();
  if (!employeeRef) return res.status(400).json({ ok: false, error: 'employeeRef required' });
  const tenantId = req.ctx.tenantId;
  const [detail, roster] = await Promise.all([
    db.employeeDetail(tenantId, employeeRef, {
      from: req.query.from || null, to: req.query.to || null,
    }),
    fetchRoster(tenantId).catch(() => []),
  ]);
  const who = roster.find((u) => String(u.id) === employeeRef);
  res.json({ ok: true, data: { ...detail, name: (who && who.name) || '', email: (who && who.email) || '' } });
});

// The same report as a spreadsheet, because payroll happens in a spreadsheet.
//
// Served as a real download (Content-Disposition) with the range in the
// filename, so a month's export doesn't land in Downloads as "export.csv" next
// to last month's. Manager-gated exactly like the report it mirrors.
app.get('/api/admin/export.csv', manager, async (req, res) => {
  const from = req.query.from || null;
  const to = req.query.to || null;
  const [rows, roster] = await Promise.all([
    db.report(req.ctx.tenantId, { from, to }),
    fetchRoster(req.ctx.tenantId).catch(() => []),
  ]);
  const nameOf = new Map(roster.map((u) => [String(u.id), u.name || '']));
  const emailOf = new Map(roster.map((u) => [String(u.id), u.email || '']));

  // Excel reads a leading "=", "+", "-" or "@" as a formula, so a name like
  // "=Sum" would execute on open. Prefix those with a quote — the standard CSV
  // injection guard — and quote every field so a comma in a name can't shift
  // the columns.
  const cell = (v) => {
    let t = v == null ? '' : String(v);
    if (/^[=+\-@]/.test(t)) t = "'" + t;
    return '"' + t.replace(/"/g, '""') + '"';
  };
  const hours = (m) => (Math.round((Number(m) || 0) / 0.6) / 100).toFixed(2);

  const header = ['Name', 'Email', 'Days worked', 'Hours worked', 'Hours approved',
                  'Hours expected', 'Difference', 'Pay rate', 'Approved pay'];
  const lines = [header.map(cell).join(',')];
  for (const r of rows) {
    const ref = String(r.employeeRef);
    lines.push([
      r.name || nameOf.get(ref) || ref,
      emailOf.get(ref) || '',
      r.days,
      hours(r.totalMinutes),
      hours(r.approvedMinutes),
      hours(r.expectedMinutes),
      hours(r.differenceMinutes),
      r.payRate == null ? '' : r.payRate,
      r.approvedPay == null ? '' : r.approvedPay,
    ].map(cell).join(','));
  }
  const span = `${from || 'start'}_${to || 'today'}`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="attendance_${span}.csv"`);
  // A BOM, so Excel opens a name with an accent in it as UTF-8 rather than as
  // mojibake — without it the file is correct and looks broken, which reads to
  // the person opening it as the same thing.
  res.send('\ufeff' + lines.join('\r\n') + '\r\n');
});

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
// Never let a webview keep yesterday's screen.
//
// This page IS the deploy — there is no build step and no hashed filename, so a
// cached copy means a fix that is live on the server is invisible on the phone,
// and the person looking at it reports the old bug as still broken. must-revalidate
// costs one conditional request per open and removes that whole class of ghost.
app.get('/app', (req, res) => {
  res.set('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(join(__dirname, '..', 'public', 'app.html'));
});
app.get('/api/ui/context', authMiddleware({ surface: 'ui' }), async (req, res) => {
  const member = await db.getMembership(req.ctx.tenantId, req.ctx.sub);
  const admin = isPlatformAdmin(req.ctx);
  // Wrap in `data` — the UI's api() helper returns j.data, like every other
  // endpoint. Top-level fields here made CTX undefined → "reading 'name'".
  // appRole (Eesa authority) is what boot() branches on; role is the mapped
  // UI vocabulary kept for backwards-compat.
  res.json({
    ok: true,
    data: {
      tenant: req.ctx.tenantId,
      name: req.ctx.email || req.ctx.sub,
      appRole: appRoleOf(req.ctx),   // 'admin' | 'staff' | null (authority)
      role: uiRoleOf(req.ctx),       // 'manager' | 'staff' | null
      isPlatformAdmin: admin,
    },
  });
});

// ---- Error handler: last stop before the process would have died -----------
// Must be registered AFTER every route. Anything a handler rejects with lands
// here and becomes a JSON 500 in the plugin's standard envelope. The message is
// deliberately generic (it can carry connection strings and internals); the log
// line keeps the detail for whoever is reading the container output.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const isDbUnreachable = ['EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT'].includes(err && err.code);
  console.error(
    `[attendance] ${req.method} ${req.path} failed:`,
    err && err.code ? `${err.code} ${err.message}` : err,
  );
  if (res.headersSent) return;
  res.status(isDbUnreachable ? 503 : 500).json({
    ok: false,
    error: {
      code: isDbUnreachable ? 'DATABASE_UNREACHABLE' : 'INTERNAL',
      message: isDbUnreachable
        ? 'The attendance database is unreachable right now. Please try again shortly.'
        : 'Something went wrong handling that request.',
    },
  });
});

// A rejection with no owner (a background task, a callback outside a request)
// would otherwise terminate the process on Node >= 15. Log and keep serving —
// the routes above each answer for themselves.
process.on('unhandledRejection', (reason) => {
  console.error('[attendance] unhandled rejection:', reason);
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`attendance plugin listening on :${port}`);
  // Say plainly, at boot, whether the database is actually reachable. Without
  // this the first sign of a bad DATABASE_URL is a stack trace on whichever
  // request happens to arrive first.
  db.ping()
    .then(() => console.log(`[attendance] database OK (${db.dbHost()})`))
    .catch((e) =>
      console.error(
        `[attendance] DATABASE UNREACHABLE at "${e.hostname || db.dbHost()}" (${e.code || e.message}). ` +
          'Requests needing data will return 503 until this is fixed. ' +
          'Check DATABASE_URL and that the database service is running on the same network as this container.',
      ),
    );
});
