// Attendance data layer — Supabase / Postgres via pg. Every query is scoped to
// tenant_id (from the verified token); employee_ref is the token `sub`.
//
// All rows are normalized to the plugin's public v2 JSON contract before they
// leave this layer (camelCase, ISO-8601 timestamps) so the REST/MCP surfaces and
// the Flutter client speak one shape. No Firestore/Firebase concepts remain.
import pg from 'pg';

const { Pool } = pg;

// Return `date` columns (OID 1082) as raw 'YYYY-MM-DD' strings, NOT JS Date
// objects. pg's default parses a bare date as LOCAL midnight, and toISOString()
// would then shift it by a day under a non-UTC process timezone — silently
// breaking day-keyed round-trips (approve/reject + schedule remove by day).
pg.types.setTypeParser(1082, (v) => v);

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Managed Postgres (Supabase/Neon/RDS) needs SSL; set PGSSL=disable for a
  // plain/local Postgres (e.g. a Coolify-hosted database).
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
  // Don't let a request queue forever behind a database that isn't answering:
  // fail fast so the caller gets a 503 instead of hanging until the client
  // times out with nothing to show for it.
  connectionTimeoutMillis: Number(process.env.PGCONNECT_TIMEOUT_MS) || 8000,
});

// An idle client dying (database restarted, network dropped) makes the pool emit
// 'error'. On an EventEmitter an unhandled 'error' is THROWN — which killed the
// whole process for something the next query would have recovered from on a
// fresh connection. Log it and let the pool discard the client.
pool.on('error', (err) => {
  console.error('[attendance] idle database client error:', err && err.code ? `${err.code} ${err.message}` : err);
});

/// The database host we're configured to talk to, for diagnostics. Parsed from
/// the URL so it can be reported WITHOUT ever exposing the password.
export function dbHost() {
  try {
    return new URL(process.env.DATABASE_URL || '').hostname || '(DATABASE_URL not set)';
  } catch {
    return '(DATABASE_URL unparseable)';
  }
}

/// Cheapest possible round trip — is Postgres actually reachable and answering?
export async function ping() {
  await pool.query('select 1');
  return true;
}

async function q(text, params) {
  const r = await pool.query(text, params);
  return r.rows;
}

// Tenant timezone (for LOCAL-day boundaries), cached; invalidated on change.
const _tzCache = new Map();
async function tenantTz(tenantId) {
  if (_tzCache.has(tenantId)) return _tzCache.get(tenantId);
  const rows = await q(`select timezone from tenant_settings where tenant_id = $1`, [tenantId]);
  const tz = (rows[0] && rows[0].timezone) || 'UTC';
  _tzCache.set(tenantId, tz);
  return tz;
}

// ---- normalizers ----------------------------------------------------------
const iso = (v) => (v == null ? null : (v instanceof Date ? v : new Date(v)).toISOString());
const dayStr = (d) =>
  typeof d === 'string'
    ? d.slice(0, 10)
    : (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);
const zoneOut = (r) => ({
  id: String(r.id),
  name: r.name,
  lat: Number(r.center_lat),
  lng: Number(r.center_lng),
  radiusM: Number(r.radius_m),
});

// Metres between two lat/lng pairs (haversine). Zone-scale distances only, so
// the spherical approximation is far more precise than any phone's GPS fix —
// no PostGIS dependency needed just to say "40 m from the centre".
export function metresBetween(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Can this punch be trusted against the zone it claims?
//
//   verified   — the device sent a position and it lands inside the zone.
//   outside    — it sent a position and that position is clearly beyond the
//                zone, further out than the fix's own error could explain.
//   unverified — we have nothing to check: no fix at all (offline, GPS refused,
//                an admin logging it by hand) or no zone on the event.
//
// "unverified" is NOT a rejection and never hides the record — plenty of honest
// punches land here (a basement with no GPS, a manual correction). It only says
// the system couldn't confirm the location itself, and the UI marks it so.
//
// The comparison allows the fix's own accuracy as slack in BOTH directions: a
// ±150 m reading 120 m outside a 100 m zone is not evidence of anything, so it
// stays "verified" rather than accusing someone on the strength of bad GPS.
const VERIFY_SLACK_MAX_M = 250;

function verifyOut(loc) {
  if (!loc) return { state: 'unverified', reason: 'No location was recorded with this punch.' };
  if (loc.distanceM == null) {
    return { state: 'unverified', reason: 'Recorded without a work zone to check against.' };
  }
  const slack = Math.min(loc.accuracyM == null ? 0 : loc.accuracyM, VERIFY_SLACK_MAX_M);
  const radius = loc.radiusM == null ? 0 : loc.radiusM;
  if (loc.distanceM <= radius + slack) {
    return {
      state: 'verified',
      reason: `Location confirmed ${loc.distanceM} m from the centre of ${loc.zoneName || 'the zone'}.`,
    };
  }
  return {
    state: 'outside',
    reason: `Recorded ${loc.distanceM} m from the centre of ${loc.zoneName || 'the zone'}, outside its ${radius} m radius.`,
  };
}

// The position attached to an event, related back to the zone it was recorded
// against: how far from the centre, and whether that puts the person inside.
// Returns null when the device had no fix (older rows, admin manual entries).
function locationOut(r) {
  if (r.lat == null || r.lng == null) return null;
  const lat = Number(r.lat);
  const lng = Number(r.lng);
  const out = {
    lat,
    lng,
    accuracyM: r.accuracy_m == null ? null : Math.round(Number(r.accuracy_m)),
    zoneId: r.zone_id == null ? null : String(r.zone_id),
    zoneName: r.zone_name || null,
    radiusM: r.radius_m == null ? null : Number(r.radius_m),
    distanceM: null,
    inside: null,
  };
  if (r.center_lat != null && r.center_lng != null) {
    const d = metresBetween(lat, lng, Number(r.center_lat), Number(r.center_lng));
    out.distanceM = Math.round(d);
    out.inside = d <= Number(r.radius_m || 0);
  }
  return out;
}

// Roll a day's punches up into one badge. A day is only "verified" when every
// punch in it was; one unconfirmable punch makes the day partial rather than
// silently passing. Days with nothing to check at all read "unverified".
export function dayVerification(events) {
  const counts = { verified: 0, unverified: 0, outside: 0 };
  for (const e of events) counts[e.verification] = (counts[e.verification] || 0) + 1;
  const state = counts.outside > 0
    ? 'outside'
    : counts.verified === 0
      ? 'unverified'
      : counts.unverified > 0
        ? 'partial'
        : 'verified';
  return { verification: state, verificationCounts: counts };
}

// ---- zones ----------------------------------------------------------------
export async function listZones(tenantId) {
  const rows = await q(
    `select id, name, center_lat, center_lng, radius_m from zones
      where tenant_id = $1 and active = true order by name`,
    [tenantId],
  );
  return rows.map(zoneOut);
}

export async function createZone(tenantId, { name, lat, lng, radius, radiusM } = {}) {
  const rows = await q(
    `insert into zones (tenant_id, name, center_lat, center_lng, radius_m)
     values ($1, $2, $3, $4, $5)
     returning id, name, center_lat, center_lng, radius_m`,
    [
      tenantId,
      String(name || 'Work zone').slice(0, 120),
      Number(lat),
      Number(lng),
      Math.max(10, Math.min(Number(radius ?? radiusM ?? 100), 5000)),
    ],
  );
  return zoneOut(rows[0]);
}

// Soft-delete: keep history intact, just stop monitoring it.
export async function deleteZone(tenantId, zoneId) {
  await q(`update zones set active = false where tenant_id = $1 and id = $2`, [tenantId, zoneId]);
  return { id: String(zoneId), deleted: true };
}

// ---- NFC tags: location stickers + employee badges ------------------------
const nfcOut = (t) =>
  t && {
    id: String(t.id),
    uid: t.uid,
    kind: t.kind,
    zoneId: t.zone_id == null ? null : String(t.zone_id),
    employeeRef: t.employee_ref || null,
    label: t.label || '',
    active: t.active,
  };

export async function listNfcTags(tenantId) {
  const rows = await q(
    `select id, uid, kind, zone_id, employee_ref, label, active from nfc_tags
      where tenant_id = $1 and active = true order by kind, label, uid`,
    [tenantId],
  );
  return rows.map(nfcOut);
}

// Register (or re-point) a physical chip. Idempotent on (tenant, UID) so
// re-scanning a known tag updates it in place instead of erroring.
export async function registerNfcTag(
  tenantId,
  { uid, kind = 'location', zoneId = null, employeeRef = null, label = '' } = {},
) {
  const u = String(uid || '').trim();
  if (!u) throw Object.assign(new Error('uid is required'), { status: 400 });
  const k = kind === 'badge' ? 'badge' : 'location';
  const rows = await q(
    `insert into nfc_tags (tenant_id, uid, kind, zone_id, employee_ref, label, active, updated_at)
     values ($1, $2, $3, $4, $5, $6, true, now())
     on conflict (tenant_id, upper(uid)) do update
       set kind = excluded.kind, zone_id = excluded.zone_id,
           employee_ref = excluded.employee_ref, label = excluded.label,
           active = true, updated_at = now()
     returning id, uid, kind, zone_id, employee_ref, label, active`,
    [
      tenantId, u, k,
      k === 'location' ? zoneId : null,
      k === 'badge' ? String(employeeRef || '') : null,
      String(label || '').slice(0, 120),
    ],
  );
  return nfcOut(rows[0]);
}

export async function removeNfcTag(tenantId, id) {
  await q(`update nfc_tags set active = false, updated_at = now() where tenant_id = $1 and id = $2`, [tenantId, id]);
  return { id: String(id), deleted: true };
}

// Resolve a scanned UID to its registration (case-insensitive). null = unknown.
export async function resolveNfcTag(tenantId, uid) {
  const rows = await q(
    `select id, uid, kind, zone_id, employee_ref, label, active from nfc_tags
      where tenant_id = $1 and upper(uid) = upper($2) and active = true`,
    [tenantId, String(uid || '')],
  );
  return nfcOut(rows[0]) || null;
}

// ---- events / check-in-out ------------------------------------------------
// Every punch carries WHERE it happened when the device could supply a fix.
//
// The explicit null/'' check matters more than it looks: Number(null) is 0, so
// a plain `Number.isFinite` guard would quietly turn "this phone had no GPS"
// into the coordinates 0,0 — a point in the Gulf of Guinea that then reads as
// "outside the work zone" and marks an honest punch as a violation. No fix has
// to stay null all the way down.
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const coord = (v, max) => {
  const n = num(v);
  return n != null && Math.abs(n) <= max ? n : null;
};

/// The caller's most recent punch, of any day. Used to decide whether a new one
/// actually changes anything — deliberately NOT day-scoped, so a shift that
/// started before midnight is still recognised as open when the check-out lands
/// the next morning.
async function lastEvent(tenantId, employeeRef) {
  const rows = await q(
    `select type, zone_id, for_work, at from events
      where tenant_id = $1 and employee_ref = $2
      order by at desc limit 1`,
    [tenantId, employeeRef],
  );
  return rows[0] || null;
}

/// Would this punch just repeat the state the person is already in?
///
/// The OS re-fires a geofence "enter" every time the app registers the fence —
/// on launch, on resume, on a zone refresh — so a single morning produced six
/// identical check-ins. That is not a cosmetic problem: each one restarted the
/// open interval, so 92 minutes on site was billed as 23. Presence is a STATE,
/// and a punch that doesn't change the state is not an event.
///
/// A check-in at a DIFFERENT zone is a real move and always recorded. A
/// "not for work" check-in always records, because that genuinely changes the
/// state. A check-out with nothing open closes nothing and is dropped.
/// How long an unclosed check-in can still count as "the same stretch of
/// presence". Past this, a new arrival is a new shift.
///
/// This bound is the whole point. Without it the rule read "your last event was
/// a check-in, so this one is a repeat" with no reference to WHEN — and a
/// check-in that never got its check-out (phone died, left without the exit
/// firing, app killed) made every future arrival a no-op FOREVER. Measured on
/// production 2026-09-04: five people had a dangling check-in, the oldest 54
/// days, and not one of them could clock in again. Nothing errored; the server
/// answered 200 and recorded nothing.
///
/// Twelve hours is longer than any real shift and far longer than the repeats
/// this guard exists for — iOS re-fires "entered" on every fence
/// re-registration, which is minutes apart, not days. Being wrong on the long
/// side costs one extra event row on a genuine double shift, and computeToday
/// keeps the earliest start so the total is unaffected. Being wrong on the
/// short side costs somebody their pay.
const SAME_PRESENCE_MS = 12 * 60 * 60 * 1000;

export function isNoOpPunch(last, type, { zoneId, forWork }, now = Date.now()) {
  if (type === 'check_in') {
    if (forWork === false) return false;           // a real state change
    if (!last || last.type !== 'check_in') return false;
    if (last.for_work === false) return false;     // resuming work after a break
    // Stale open shift → this is a new arrival, not a repeat of the old one.
    const at = last.at ? new Date(last.at).getTime() : null;
    if (at == null || Number.isNaN(at) || now - at > SAME_PRESENCE_MS) return false;
    // Same place (or the new punch names no place) → same presence.
    return zoneId == null || last.zone_id == null || String(last.zone_id) === String(zoneId);
  }
  // check_out: only meaningful if something is actually open.
  return !last || last.type === 'check_out';
}

export async function recordEvent(
  tenantId, employeeRef, type,
  { zoneId = null, lat = null, lng = null, accuracyM = null, forWork = true,
    source = 'geofence', workType = null, requireConfirm = false } = {},
) {
  const la = coord(lat, 90);
  const ln = coord(lng, 180);
  // '' is not a uuid — a client clocking out away from a zone must land as a
  // null FK, not a Postgres type error that loses the punch.
  const zid = zoneId === '' || zoneId === undefined ? null : zoneId;

  // Drop punches that repeat the state the person is already in. Returning the
  // CURRENT status (not an error) keeps every caller idempotent: the phone can
  // re-send an arrival as often as the OS fires one and the record stays true.
  const last = await lastEvent(tenantId, employeeRef);
  if (isNoOpPunch(last, type, { zoneId: zid, forWork })) {
    return { id: null, type, at: iso(last && last.at), duplicate: true };
  }
  // Same trap: a missing accuracy must stay null, not become 0 — "0 m" would
  // claim a perfect fix and remove all the slack the verification allows.
  const rawAcc = num(accuracyM);
  const acc = rawAcc != null && rawAcc >= 0 ? Math.min(rawAcc, 100000) : null;
  // Only a check-in can be pending: a check-out ends a shift someone either
  // vouched for or did not, and asking a manager to confirm a departure adds a
  // decision without adding any information.
  const pending = type === 'check_in' && requireConfirm ? 'pending' : null;
  const hasConfirm = await ensureSettingsColumn();
  const rows = hasConfirm
    ? await q(
        `insert into events (tenant_id, employee_ref, type, zone_id, lat, lng, accuracy_m, for_work, source, work_type, confirm_status)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id, type, at`,
        [tenantId, employeeRef, type, zid, la, ln, acc, forWork !== false,
         String(source || 'geofence'), workType ? String(workType).slice(0, 120) : null, pending],
      )
    : await q(
        `insert into events (tenant_id, employee_ref, type, zone_id, lat, lng, accuracy_m, for_work, source, work_type)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id, type, at`,
        [tenantId, employeeRef, type, zid, la, ln, acc, forWork !== false,
         String(source || 'geofence'), workType ? String(workType).slice(0, 120) : null],
      );
  await upsertDaySummary(tenantId, employeeRef);
  // Gated on hasConfirm, not just on the request. If the DDL never landed (no
  // grant on this database) the punch was inserted WITHOUT confirm_status, so
  // pendingConfirmations can never return it — claiming it is pending would ask
  // every manager to confirm a check-in that will not appear in their queue.
  return {
    id: String(rows[0].id),
    type: rows[0].type,
    at: iso(rows[0].at),
    pending: hasConfirm && pending === 'pending',
  };
}

// Today's raw events, ascending — the basis for status + the day summary.
// "Today" is the tenant's LOCAL day (not the DB/UTC day). The location columns
// and the zone join ride along so myStatus can hand the app a full picture of
// the day (where each punch happened, whether it checks out) in ONE call —
// the detail view opened from the phone's banner is built entirely from this.
async function todaysEvents(tenantId, employeeRef) {
  const tz = await tenantTz(tenantId);
  return q(
    `select e.id, e.employee_ref, e.type, e.zone_id, e.at, e.for_work, e.source,
            e.work_type, e.lat, e.lng, e.accuracy_m,
            z.name as zone_name, z.center_lat, z.center_lng, z.radius_m,
            '' as name, (e.at at time zone $3)::date as day
       from events e
       left join zones z on z.id = e.zone_id
      where e.tenant_id = $1 and e.employee_ref = $2
        and e.at >= (date_trunc('day', now() at time zone $3) at time zone $3)
      order by e.at asc`,
    [tenantId, employeeRef, tz],
  );
}

// Walk paired check_in→check_out intervals; an unmatched trailing check_in is
// counted as an open interval up to "now" (so hours-worked ticks live).
export function computeToday(events) {
  let openIn = null; // Date of an unmatched check_in
  let openEvent = null; // ...and the row it came from, for the detail view
  let firstIn = null;
  let lastOut = null;
  let lastZone = null;
  let ms = 0;
  for (const e of events) {
    const at = new Date(e.at);
    if (e.type === 'check_in') {
      // "Here but not for work" (the geofence prompt's No / banner toggle) stops
      // counting work time from this point — it closes any open interval and does
      // NOT reopen one.
      if (e.for_work === false) {
        if (openIn) { ms += at - openIn; openIn = null; openEvent = null; }
        continue;
      }
      firstIn ??= at;
      // A second check-in with no check-out between them is the SAME stretch of
      // presence, so it must not restart the clock. Overwriting openIn here is
      // what silently discarded the time already worked: six repeat arrivals in
      // one morning turned 92 minutes on site into 23. Keep the earliest start
      // and let the interval run.
      //
      // recordEvent now refuses to write these, but this has to hold anyway —
      // every database already contains them, and those days still have to add
      // up correctly.
      if (openIn == null) {
        openIn = at;
        openEvent = e;
      }
      lastZone = e.zone_id;
    } else if (e.type === 'check_out') {
      lastOut = at;
      if (openIn) {
        ms += at - openIn;
        openIn = null;
        openEvent = null;
      }
    }
  }
  const checkedIn = openIn != null;
  if (checkedIn) ms += Date.now() - openIn.getTime();
  return {
    checkedIn,
    since: checkedIn ? openIn : null,
    openEvent: checkedIn ? openEvent : null,
    zoneId: checkedIn && lastZone != null ? String(lastZone) : null,
    firstIn,
    lastOut,
    totalMinutes: Math.max(0, Math.round(ms / 60000)),
  };
}

export async function myStatus(tenantId, employeeRef) {
  const tz = await tenantTz(tenantId);
  const rows = await todaysEvents(tenantId, employeeRef);
  const t = computeToday(rows);
  const events = rows.map(eventOut).reverse();       // newest first, for display
  const dayV = dayVerification(events);
  const open = t.openEvent ? eventOut(t.openEvent) : null;
  const today = rows.length
    ? {
        date: new Date().toLocaleDateString('en-CA', { timeZone: tz }),
        totalMinutes: t.totalMinutes,
        firstIn: iso(t.firstIn),
        lastOut: iso(t.lastOut),
        status: t.checkedIn ? 'open' : t.firstIn && t.lastOut ? 'complete' : 'incomplete',
        ...dayV,
      }
    : null;
  return {
    // The workplace's own clock.
    //
    // Every timestamp here is an instant in UTC, and the phone rendering it
    // has been using its OWN zone — so a handset brought from India showed an
    // 08:01 arrival at the restaurant as 20:31. The DAY is already decided in
    // tenant time on this side; the hour has to agree with it.
    timezone: tz,
    checkedIn: t.checkedIn,
    since: iso(t.since),
    zoneId: t.zoneId,
    // The open punch's zone by NAME, so the app never has to re-look-up an id
    // just to say where you are.
    zoneName: open && open.location ? open.location.zoneName : null,
    workType: open ? open.workType : null,
    todayMinutes: t.totalMinutes,
    // How the CURRENT shift was verified (null when off the clock), and how the
    // day as a whole came out.
    verification: open ? open.verification : dayV.verification,
    verificationReason: open ? open.verificationReason : null,
    currentPunch: open,
    // Today's punches in full — the phone's detail sheet renders straight from
    // this, so opening it costs nothing extra.
    events,
    today,
  };
}

// Verification badge for every (employee, local day) in a window, in one query.
// day_summaries carries no location, so the badge has to be derived from the
// underlying punches — myHistory, employeeDetail and listApprovals all read it
// from here so they can never disagree about whether a day checks out.
// Key: `${employeeRef}|${YYYY-MM-DD}`.
async function verificationIndex(tenantId, { from = null, to = null, employeeRef = null } = {}) {
  const tz = await tenantTz(tenantId);
  const params = [tenantId, tz, from || '1970-01-01', to || '2999-12-31'];
  const clauses = [
    'e.tenant_id = $1',
    '(e.at at time zone $2)::date between $3::date and $4::date',
  ];
  if (employeeRef) { params.push(employeeRef); clauses.push(`e.employee_ref = $${params.length}`); }
  const rows = await q(
    `select e.employee_ref, e.lat, e.lng, e.accuracy_m, e.zone_id,
            z.name as zone_name, z.center_lat, z.center_lng, z.radius_m,
            (e.at at time zone $2)::date as day
       from events e
       left join zones z on z.id = e.zone_id
      where ${clauses.join(' and ')}`,
    params,
  );
  const grouped = new Map();
  for (const r of rows) {
    const key = `${r.employee_ref}|${dayStr(r.day)}`;
    const list = grouped.get(key) || [];
    list.push({ verification: verifyOut(locationOut(r)).state });
    grouped.set(key, list);
  }
  const out = new Map();
  for (const [key, list] of grouped) out.set(key, dayVerification(list));
  return out;
}

// A day with no punches at all to check against still needs a badge, so the
// caller never renders a blank where a marker belongs.
const NO_EVENTS = { verification: 'unverified', verificationCounts: { verified: 0, unverified: 0, outside: 0 } };

export async function myHistory(tenantId, employeeRef, days = 7, { from = null, to = null } = {}) {
  // Two ways to ask, because the callers genuinely differ. The phone's "last 7
  // days" strip wants a COUNT and does not care which dates those are; a
  // "This month" filter wants a WINDOW and must not silently return 31 days
  // that spill into last month. Passing a window wins when one is given.
  //
  // The window is not capped at 90 the way the count is: an explicit from/to is
  // a deliberate question ("March"), and truncating that answer to the newest 90
  // days would quietly under-report a total the person is checking their pay
  // against. The count stays capped because it has no upper bound of its own.
  const windowed = Boolean(from || to);
  const rows = windowed
    ? await q(
        `select day, first_in, last_out, total_minutes from day_summaries
          where tenant_id = $1 and employee_ref = $2 and day between $3 and $4
          order by day desc`,
        [tenantId, employeeRef, from || '1970-01-01', to || '2999-12-31'],
      )
    : await q(
        `select day, first_in, last_out, total_minutes from day_summaries
          where tenant_id = $1 and employee_ref = $2 order by day desc limit $3`,
        [tenantId, employeeRef, Math.max(1, Math.min(days, 90))],
      );
  const dates = rows.map((r) => dayStr(r.day));
  const window = dates.length
    ? { employeeRef, from: dates[dates.length - 1], to: dates[0] }
    : null;
  const [vi, ci] = window
    ? await Promise.all([verificationIndex(tenantId, window), confirmationIndex(tenantId, window)])
    : [new Map(), new Map()];

  // A shift that has not ended yet.
  //
  // `day_summaries` is only rewritten when a punch lands, so a day whose
  // check-in was its last punch is frozen at the total it had a second after
  // arriving — zero. Printed as-is, the running shift reads "0.0 h" on the row,
  // "0 days worked" in the tile above it and "29m" on the card above that:
  // three numbers for one shift, and the smallest of them next to the word
  // "Incomplete". So today is recounted from its punches, exactly as the status
  // endpoint does, and the two can never disagree.
  //
  // Only for the person's own history, and only for today. The admin timesheet
  // deliberately keeps the stored figure: approving and paying a day that is
  // still running would freeze a number that was never the day's total.
  const tz = await tenantTz(tenantId);
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const live = dates.includes(todayStr)
    ? computeToday(await todaysEvents(tenantId, employeeRef))
    : null;
  const running = live && live.checkedIn ? live : null;

  return {
    days: rows.map((r) => {
      const date = dayStr(r.day);
      const now = running && date === todayStr ? running : null;
      return {
        date,
        totalMinutes: now ? now.totalMinutes : Number(r.total_minutes || 0),
        firstIn: iso(r.first_in),
        lastOut: iso(r.last_out),
        status: now ? 'open' : r.last_out ? 'complete' : r.first_in ? 'incomplete' : 'open',
        // null when confirmation never applied to this day (a manager's own
        // shift, or a workspace with the setting off) — deliberately different
        // from 'unconfirmed', which means it was asked and never answered.
        confirmStatus: ci.get(`${employeeRef}|${date}`) || null,
        ...(vi.get(`${employeeRef}|${date}`) || NO_EVENTS),
      };
    }),
  };
}

/// One employee's attendance in detail: every day in the window plus a monthly
/// rollup, for the admin report's per-person drill-down. Same data `myHistory`
/// gives a staff member about themselves — the caller (server.js) is what
/// restricts this to managers.
export async function employeeDetail(tenantId, employeeRef, { from = null, to = null } = {}) {
  const f = from || '1970-01-01';
  const t = to || '2999-12-31';
  const rows = await q(
    `select day, first_in, last_out, total_minutes, approval_status
       from day_summaries
      where tenant_id = $1 and employee_ref = $2 and day between $3 and $4
      order by day desc`,
    [tenantId, employeeRef, f, t],
  );
  const window = {
    employeeRef,
    from: f === '1970-01-01' ? null : f,
    to: t === '2999-12-31' ? null : t,
  };
  const [vi, ci] = await Promise.all([
    verificationIndex(tenantId, window),
    confirmationIndex(tenantId, window),
  ]);
  const days = rows.map((r) => {
    const date = dayStr(r.day);
    return {
      date,
      totalMinutes: Number(r.total_minutes || 0),
      firstIn: iso(r.first_in),
      lastOut: iso(r.last_out),
      approvalStatus: r.approval_status || null,
      // Whether a person vouched for this shift, as distinct from whether the
      // phone's location backed it up. Both can fail independently and an admin
      // approving a timesheet needs to see which one did.
      confirmStatus: ci.get(`${employeeRef}|${date}`) || null,
      status: r.last_out ? 'complete' : r.first_in ? 'incomplete' : 'open',
      ...(vi.get(`${employeeRef}|${date}`) || NO_EVENTS),
    };
  });
  // Roll the same rows up by calendar month, so the UI never has to re-derive
  // it (and can't disagree with the day list it is showing).
  const byMonth = new Map();
  for (const d of days) {
    const key = d.date.slice(0, 7); // YYYY-MM
    const cur = byMonth.get(key) || { month: key, totalMinutes: 0, daysWorked: 0 };
    cur.totalMinutes += d.totalMinutes;
    if (d.totalMinutes > 0) cur.daysWorked += 1;
    byMonth.set(key, cur);
  }
  const months = [...byMonth.values()].sort((a, b) => (a.month < b.month ? 1 : -1));
  return {
    employeeRef: String(employeeRef),
    days,
    months,
    totalMinutes: days.reduce((n, d) => n + d.totalMinutes, 0),
    daysWorked: days.filter((d) => d.totalMinutes > 0).length,
  };
}

export async function whoIsLate(tenantId, cutoffHour = 9) {
  const tz = await tenantTz(tenantId);
  const rows = await q(
    `select employee_ref, min(at) as first_in from events
      where tenant_id = $1 and type = 'check_in'
        and at >= (date_trunc('day', now() at time zone $3) at time zone $3)
      group by employee_ref
      having extract(hour from min(at) at time zone $3) >= $2
      order by first_in`,
    [tenantId, cutoffHour, tz],
  );
  return rows.map((r) => ({ employeeRef: r.employee_ref, firstIn: iso(r.first_in) }));
}

// Everyone with at least one check-in today (tenant-LOCAL day), regardless of
// approval or whether they're still checked in. Powers the platform's generic
// `present_today` audience (Flow's presence-gated recipients). Returns the bare
// employee_ref list (== the Eesa user id / token sub) so the platform can map
// them straight to users.
export async function presentToday(tenantId) {
  const tz = await tenantTz(tenantId);
  const rows = await q(
    `select distinct employee_ref from events
       where tenant_id = $1 and type = 'check_in'
         and at >= (date_trunc('day', now() at time zone $2) at time zone $2)`,
    [tenantId, tz],
  );
  return rows.map((r) => r.employee_ref);
}

// Who is in today, WHO they are, and where they last were. Three things in one
// query because the "Who's in" table and the live zone map both need all of it:
//   latest  — the most recent event per person (decides in/out + since when)
//   located — their most recent event that actually carried a position, which
//             is usually the same row but survives a locationless punch (an
//             admin manual entry, or a check-out taken with no fix)
// The zones ride along so the map can draw its circles in the same round-trip.
// Names come from the plugin's membership row here; server.js merges the
// authoritative tenant roster over the top.
export async function presence(tenantId) {
  const tz = await tenantTz(tenantId);
  const [rows, zones] = await Promise.all([
    q(
      `with day_start as (
         select (date_trunc('day', now() at time zone $2) at time zone $2) as t
       ),
       latest as (
         select distinct on (employee_ref) employee_ref, type, at
           from events, day_start
          where tenant_id = $1 and at >= day_start.t
          order by employee_ref, at desc
       ),
       located as (
         select distinct on (employee_ref) employee_ref, lat, lng, accuracy_m, zone_id, at
           from events, day_start
          where tenant_id = $1 and at >= day_start.t
            and lat is not null and lng is not null
          order by employee_ref, at desc
       )
       select l.employee_ref, l.type, l.at,
              g.lat, g.lng, g.accuracy_m, g.zone_id, g.at as located_at,
              z.name as zone_name, z.center_lat, z.center_lng, z.radius_m,
              coalesce(m.name, '') as name
         from latest l
         left join located     g on g.employee_ref = l.employee_ref
         left join zones       z on z.id = g.zone_id
         left join memberships m on m.tenant_id = $1 and m.employee_ref = l.employee_ref
        order by l.at desc`,
      [tenantId, tz],
    ),
    listZones(tenantId),
  ]);
  return {
    zones,
    employees: rows.map((r) => {
      const loc = locationOut(r);
      const v = verifyOut(loc);
      return {
        employeeRef: r.employee_ref,
        name: r.name || '',
        checkedIn: r.type === 'check_in',
        at: iso(r.at),
        // Where they were when they last punched — NOT a live position. The
        // device only reports at a geofence trigger, so `lastLocation.at` is
        // what the UI must show alongside the dot.
        lastLocation: loc ? { ...loc, at: iso(r.located_at) } : null,
        verification: v.state,
        verificationReason: v.reason,
      };
    }),
  };
}

// The raw punch log with positions — "when was this person here, and where
// exactly". One row per event (not per day), newest first, over a LOCAL-day
// range. Powers the per-day drill-down under a person's logs.
export async function eventLog(
  tenantId, { employeeRef = null, from = null, to = null, limit = 500 } = {},
) {
  const tz = await tenantTz(tenantId);
  const params = [tenantId, tz];
  const clauses = ['e.tenant_id = $1'];
  if (from) {
    params.push(from);
    clauses.push(`e.at >= ((($${params.length}::date)::timestamp) at time zone $2)`);
  }
  if (to) {
    params.push(to);
    clauses.push(`e.at < ((($${params.length}::date + 1)::timestamp) at time zone $2)`);
  }
  if (employeeRef) { params.push(employeeRef); clauses.push(`e.employee_ref = $${params.length}`); }
  params.push(Math.max(1, Math.min(Number(limit) || 500, 2000)));
  const rows = await q(
    `select e.id, e.employee_ref, e.type, e.at, e.source, e.work_type, e.for_work,
            e.lat, e.lng, e.accuracy_m, e.zone_id,
            z.name as zone_name, z.center_lat, z.center_lng, z.radius_m,
            coalesce(m.name, '') as name,
            (e.at at time zone $2)::date as day
       from events e
       left join zones       z on z.id = e.zone_id
       left join memberships m on m.tenant_id = e.tenant_id and m.employee_ref = e.employee_ref
      where ${clauses.join(' and ')}
      order by e.at desc
      limit $${params.length}`,
    params,
  );
  return rows.map(eventOut);
}

// One punch, normalized: when, what, where, and whether the where checks out.
const eventOut = (r) => {
  const location = locationOut(r);
  const v = verifyOut(location);
  return {
    id: String(r.id),
    employeeRef: r.employee_ref,
    name: r.name || '',
    day: dayStr(r.day),
    type: r.type,
    at: iso(r.at),
    source: r.source || 'geofence',
    workType: r.work_type || null,
    forWork: r.for_work !== false,
    location,
    verification: v.state,          // 'verified' | 'outside' | 'unverified'
    verificationReason: v.reason,
  };
};

// A staff member's OWN punches — the same rows the admin log shows, minus
// anyone else's. This is what lets someone see an unverified punch of theirs
// and understand why it is marked that way instead of just finding it missing.
export async function myEvents(tenantId, employeeRef, { from = null, to = null, days = null } = {}) {
  const tz = await tenantTz(tenantId);
  const params = [tenantId, tz, employeeRef];
  const clauses = ['e.tenant_id = $1', 'e.employee_ref = $3'];
  if (from) {
    params.push(from);
    clauses.push(`e.at >= ((($${params.length}::date)::timestamp) at time zone $2)`);
  } else {
    // Default window: the last N local days, "today" included.
    params.push(Math.max(1, Math.min(Number(days) || 7, 90)));
    // Explicit ::int — the driver sends the bind as untyped text, and
    // make_interval(days => …) needs an integer, not an inference.
    clauses.push(
      `e.at >= ((date_trunc('day', now() at time zone $2) - make_interval(days => $${params.length}::int - 1)) at time zone $2)`,
    );
  }
  if (to) {
    params.push(to);
    clauses.push(`e.at < ((($${params.length}::date + 1)::timestamp) at time zone $2)`);
  }
  const rows = await q(
    `select e.id, e.employee_ref, e.type, e.at, e.source, e.work_type, e.for_work,
            e.lat, e.lng, e.accuracy_m, e.zone_id,
            z.name as zone_name, z.center_lat, z.center_lng, z.radius_m,
            '' as name, (e.at at time zone $2)::date as day
       from events e
       left join zones z on z.id = e.zone_id
      where ${clauses.join(' and ')}
      order by e.at desc
      limit 1000`,
    params,
  );
  return rows.map(eventOut);
}

// One-shot "state of attendance today" for the agent: present / absent / late,
// each carried with the person's NAME (not a bare id). PRESENT = enrolled member
// with >=1 check-in today. ABSENT = enrolled member with none. LATE = checked in
// after the cutoff hour. Reuses the same tenant-LOCAL-day queries as the rest.
export async function attendanceToday(tenantId, cutoffHour = 9) {
  const [members, presentRefs, late] = await Promise.all([
    listMembers(tenantId),
    presentToday(tenantId),
    whoIsLate(tenantId, cutoffHour),
  ]);
  const nameOf = new Map(
    members.map((m) => [String(m.employeeRef), m.name || String(m.employeeRef)]),
  );
  const presentSet = new Set(presentRefs.map(String));
  const named = (ref) => ({ employeeRef: String(ref), name: nameOf.get(String(ref)) || String(ref) });

  const present = [...presentSet].map(named);
  const absent = members
    .filter((m) => !presentSet.has(String(m.employeeRef)))
    .map((m) => named(m.employeeRef));
  const lateNamed = late.map((l) => ({ ...named(l.employeeRef), firstIn: l.firstIn }));

  return {
    date: 'today',
    present,
    absent,
    late: lateNamed,
    counts: {
      enrolled: members.length,
      present: present.length,
      absent: absent.length,
      late: lateNamed.length,
    },
  };
}

// Recompute today's summary (first_in, last_out, total_minutes) from events.
async function upsertDaySummary(tenantId, employeeRef) {
  const tz = await tenantTz(tenantId);
  const t = computeToday(await todaysEvents(tenantId, employeeRef));
  await q(
    `insert into day_summaries (tenant_id, employee_ref, day, first_in, last_out, total_minutes, updated_at)
     values ($1, $2, (now() at time zone $6)::date, $3, $4, $5, now())
     on conflict (tenant_id, employee_ref, day)
     do update set first_in = excluded.first_in, last_out = excluded.last_out,
                   total_minutes = excluded.total_minutes, updated_at = now()`,
    [tenantId, employeeRef, t.firstIn, t.lastOut, t.totalMinutes, tz],
  );
}

// ---- membership / roles (plugin-owned) ------------------------------------
const memberOut = (m) =>
  m && {
    employeeRef: m.employee_ref,
    role: m.role,
    payRate: m.pay_rate == null ? null : Number(m.pay_rate),
    name: m.name,
    email: m.email,
    workTypeIds: Array.isArray(m.work_type_ids) ? m.work_type_ids.map(String) : [],
  };

// The caller's role, or null when they aren't enrolled (→ no access).
export async function getMembership(tenantId, employeeRef) {
  const rows = await q(
    `select employee_ref, role, pay_rate, name, email, work_type_ids from memberships
      where tenant_id = $1 and employee_ref = $2 and active = true`,
    [tenantId, employeeRef],
  );
  return memberOut(rows[0]) || null;
}

export async function listMembers(tenantId) {
  const rows = await q(
    `select employee_ref, role, pay_rate, name, email, work_type_ids from memberships
      where tenant_id = $1 and active = true order by name, employee_ref`,
    [tenantId],
  );
  return rows.map(memberOut);
}

export async function upsertMember(
  tenantId,
  { employeeRef, role = 'staff', payRate = null, name = '', email = '', workTypeIds = null },
) {
  const validRole = role === 'manager' ? 'manager' : 'staff';
  const ids = Array.isArray(workTypeIds) ? workTypeIds.map(String) : [];
  // Keep an existing assignment untouched when the caller doesn't send one
  // (e.g. the Team-row Save that only changes role/pay) — coalesce to current.
  const idsParam = workTypeIds == null ? null : JSON.stringify(ids);
  const rows = await q(
    `insert into memberships (tenant_id, employee_ref, role, pay_rate, name, email, work_type_ids, active, updated_at)
     values ($1, $2, $3, $4, $5, $6, coalesce($7::jsonb, '[]'::jsonb), true, now())
     on conflict (tenant_id, employee_ref) do update
       set role = excluded.role, pay_rate = excluded.pay_rate, name = excluded.name,
           email = excluded.email,
           work_type_ids = coalesce($7::jsonb, memberships.work_type_ids),
           active = true, updated_at = now()
     returning employee_ref, role, pay_rate, name, email, work_type_ids`,
    [tenantId, employeeRef, validRole, payRate,
     String(name || '').slice(0, 200), String(email || '').slice(0, 200), idsParam],
  );
  return memberOut(rows[0]);
}

// ---- work-type catalog + per-user picks -----------------------------------
const workTypeOut = (w) => ({ id: String(w.id), name: w.name });

export async function listWorkTypes(tenantId) {
  const rows = await q(
    `select id, name from work_types where tenant_id = $1 and active = true order by name`,
    [tenantId],
  );
  return rows.map(workTypeOut);
}

export async function upsertWorkType(tenantId, { id = null, name }) {
  const nm = String(name || '').trim().slice(0, 120);
  if (!nm) throw Object.assign(new Error('name required'), { status: 400 });
  if (id) {
    const rows = await q(
      `update work_types set name = $3 where tenant_id = $1 and id = $2 returning id, name`,
      [tenantId, id, nm],
    );
    return rows[0] ? workTypeOut(rows[0]) : null;
  }
  const rows = await q(
    `insert into work_types (tenant_id, name) values ($1, $2) returning id, name`,
    [tenantId, nm],
  );
  return workTypeOut(rows[0]);
}

export async function removeWorkType(tenantId, id) {
  await q(`update work_types set active = false where tenant_id = $1 and id = $2`, [tenantId, id]);
  return { id: String(id), removed: true };
}

// The work types a given user may pick at check-in (their assigned subset,
// resolved to catalog names; silently drops ids no longer in the catalog).
export async function myWorkTypes(tenantId, employeeRef) {
  const m = await getMembership(tenantId, employeeRef);
  const ids = (m && m.workTypeIds) || [];
  if (!ids.length) return [];
  const rows = await q(
    `select id, name from work_types
      where tenant_id = $1 and active = true and id = any($2::uuid[]) order by name`,
    [tenantId, ids],
  );
  return rows.map(workTypeOut);
}

// ---- schedule templates (reusable shift library) --------------------------
const hhmm = (t) => (t == null ? null : String(t).slice(0, 5)); // 'HH:MM'
const toMin = (t) => {
  if (!t) return null;
  const [h, m] = String(t).split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
};
// Paid minutes a template represents: (end-start) minus the optional break,
// wrapping midnight so an overnight shift is positive.
export function templateMinutes(t) {
  const start = toMin(t.start_time ?? t.startTime);
  const end = toMin(t.end_time ?? t.endTime);
  if (start == null || end == null) return 0;
  let mins = end - start;
  if (mins < 0) mins += 1440;
  const bs = toMin(t.break_start ?? t.breakStart);
  const be = toMin(t.break_end ?? t.breakEnd);
  if (bs != null && be != null) {
    let br = be - bs;
    if (br < 0) br += 1440;
    mins -= Math.max(0, br);
  }
  return Math.max(0, mins);
}
const templateOut = (t) => ({
  id: String(t.id),
  name: t.name,
  startTime: hhmm(t.start_time),
  endTime: hhmm(t.end_time),
  breakStart: hhmm(t.break_start),
  breakEnd: hhmm(t.break_end),
  expectedMinutes: templateMinutes(t),
});

export async function listTemplates(tenantId) {
  const rows = await q(
    `select id, name, start_time, end_time, break_start, break_end
       from schedule_templates where tenant_id = $1 and active = true order by name`,
    [tenantId],
  );
  return rows.map(templateOut);
}

export async function getTemplate(tenantId, id) {
  const rows = await q(
    `select id, name, start_time, end_time, break_start, break_end
       from schedule_templates where tenant_id = $1 and id = $2 and active = true`,
    [tenantId, id],
  );
  return rows[0] ? templateOut(rows[0]) : null;
}

export async function upsertTemplate(tenantId, { id = null, name, startTime, endTime, breakStart = null, breakEnd = null }) {
  const nm = String(name || '').trim().slice(0, 120);
  if (!nm || !startTime || !endTime) {
    throw Object.assign(new Error('name, startTime and endTime are required'), { status: 400 });
  }
  const bs = breakStart || null;
  const be = breakEnd || null;
  if ((bs && !be) || (be && !bs)) {
    throw Object.assign(new Error('break needs both a start and an end (or neither)'), { status: 400 });
  }
  if (id) {
    const rows = await q(
      `update schedule_templates
          set name = $3, start_time = $4, end_time = $5, break_start = $6, break_end = $7, updated_at = now()
        where tenant_id = $1 and id = $2
      returning id, name, start_time, end_time, break_start, break_end`,
      [tenantId, id, nm, startTime, endTime, bs, be],
    );
    return rows[0] ? templateOut(rows[0]) : null;
  }
  const rows = await q(
    `insert into schedule_templates (tenant_id, name, start_time, end_time, break_start, break_end)
     values ($1, $2, $3, $4, $5, $6)
     returning id, name, start_time, end_time, break_start, break_end`,
    [tenantId, nm, startTime, endTime, bs, be],
  );
  return templateOut(rows[0]);
}

export async function removeTemplate(tenantId, id) {
  await q(`update schedule_templates set active = false where tenant_id = $1 and id = $2`, [tenantId, id]);
  return { id: String(id), removed: true };
}

export async function removeMember(tenantId, employeeRef) {
  await q(
    `update memberships set active = false, updated_at = now()
      where tenant_id = $1 and employee_ref = $2`,
    [tenantId, employeeRef],
  );
  return { employeeRef: String(employeeRef), removed: true };
}

// ---- tenant settings (timezone + notification policy) ----------------------

/// How much the attendance managers are told, per tenant.
///
///   off         nothing at all
///   exceptions  only punches a manager would actually act on (default)
///   all         every check-in and check-out from everyone
///
/// The default is deliberately NOT `all`. A workspace of ~28 people produces
/// something like 56 punches a day, and a manager who is pushed 56 times a day
/// turns the notifications off — at which point the exceptions they DO need to
/// see are gone too. Anyone who genuinely wants the firehose can still ask for
/// it; nobody gets it by accident.
export const MANAGER_NOTIFY = ['off', 'exceptions', 'all'];
const MANAGER_NOTIFY_DEFAULT = 'exceptions';

/// Add the settings column if this tenant's database predates it.
///
/// The schema lives in Supabase rather than in this repo, so there is no
/// migration to run — and a deploy that assumed the column existed would 500 on
/// every settings read until someone applied DDL by hand. `if not exists` makes
/// this safe to run on every boot, and the catch means a database that refuses
/// it (no DDL grant) still serves every other route: `managerNotify` just falls
/// back to the default until someone adds the column.
let _schemaReady = null;
async function ensureSettingsColumn() {
  if (_schemaReady) return _schemaReady;
  _schemaReady = (async () => {
    try {
      await pool.query(
        `alter table tenant_settings
           add column if not exists manager_notify text not null default '${MANAGER_NOTIFY_DEFAULT}'`,
      );
      await pool.query(
        `alter table tenant_settings
           add column if not exists require_confirmation boolean not null default true`,
      );
      // Human confirmation lives on the check-in event itself, not in a side
      // table: it is a property of that punch, and keeping it here means every
      // query that already reads a punch can see whether a person vouched for
      // it without another join.
      //
      // NULL means "no answer was ever needed" — a check-out, or a punch made
      // while confirmation was switched off. That is deliberately different
      // from 'pending', which means someone still owes an answer.
      await pool.query(`alter table events add column if not exists confirm_status text`);
      await pool.query(`alter table events add column if not exists confirmed_by text`);
      await pool.query(`alter table events add column if not exists confirmed_at timestamptz`);
      return true;
    } catch (e) {
      console.error('[attendance] could not add attendance columns:', e && e.message);
      return false;
    }
  })();
  return _schemaReady;
}

export async function getTenantSettings(tenantId) {
  const timezone = await getTenantTimezone(tenantId);
  if (!(await ensureSettingsColumn())) {
    return { timezone, managerNotify: MANAGER_NOTIFY_DEFAULT, requireConfirmation: true };
  }
  const rows = await q(
    `select manager_notify, require_confirmation from tenant_settings where tenant_id = $1`,
    [tenantId],
  );
  const v = rows[0]?.manager_notify;
  return {
    timezone,
    managerNotify: MANAGER_NOTIFY.includes(v) ? v : MANAGER_NOTIFY_DEFAULT,
    // Absent row → on. A workspace that has never opened the setting should get
    // the safer behaviour (someone vouches for the shift) rather than the
    // quieter one.
    requireConfirmation: rows[0]?.require_confirmation !== false,
  };
}

export async function setTenantSettings(tenantId, { timezone, managerNotify, requireConfirmation } = {}) {
  if (timezone !== undefined) await setTenantTimezone(tenantId, timezone);
  const ready = await ensureSettingsColumn();
  if (managerNotify !== undefined && ready) {
    const v = MANAGER_NOTIFY.includes(managerNotify) ? managerNotify : MANAGER_NOTIFY_DEFAULT;
    await q(
      `insert into tenant_settings (tenant_id, timezone, manager_notify, updated_at)
       values ($1, coalesce((select timezone from tenant_settings where tenant_id = $1), 'UTC'), $2, now())
       on conflict (tenant_id) do update set manager_notify = excluded.manager_notify, updated_at = now()`,
      [tenantId, v],
    );
  }
  if (requireConfirmation !== undefined && ready) {
    await q(
      `insert into tenant_settings (tenant_id, timezone, require_confirmation, updated_at)
       values ($1, coalesce((select timezone from tenant_settings where tenant_id = $1), 'UTC'), $2, now())
       on conflict (tenant_id) do update set require_confirmation = excluded.require_confirmation, updated_at = now()`,
      [tenantId, requireConfirmation !== false],
    );
  }
  return getTenantSettings(tenantId);
}

// ---- human confirmation of a shift ----------------------------------------

/// Whether this shift needs a human to vouch for it at all.
///
/// Two people never need confirming, for the same reason: there is nobody whose
/// word would add anything.
///
///   * A MANAGER checking themselves in. They are the authority the question
///     would be asked of. Marking their own arrival "pending" asks the other
///     managers to police a peer, and in a workspace with one manager it can
///     never be answered at all — the shift would sit pending until check-out
///     and then fire an "unconfirmed" alert every single day, about the one
///     person who cannot be wrong about it.
///   * ANYONE, when there is no other manager on the roster to ask.
///
/// Returning false here is not "skip the check" — it means the check does not
/// apply, and the punch is stored with no confirmation state rather than a
/// pending one nobody can clear.
export async function needsConfirmation(tenantId, employeeRef) {
  const [me, managers] = await Promise.all([
    getMembership(tenantId, employeeRef),
    managerRefs(tenantId),
  ]);
  if (me && me.role === 'manager') return false;
  return managers.some((r) => String(r) !== String(employeeRef));
}

/// A check-in that reached its check-out with nobody having answered.
///
/// Moved out of 'pending' rather than left in it, because the two mean
/// different things to different screens: 'pending' is a question still worth
/// putting in front of an admin today, 'unconfirmed' is a settled fact about a
/// finished shift that belongs on the timesheet. Leaving it pending would keep
/// yesterday's unanswerable questions stacking up in today's queue forever.
export async function markUnconfirmed(tenantId, eventId) {
  if (!(await ensureSettingsColumn())) return null;
  const rows = await q(
    `update events set confirm_status = 'unconfirmed'
      where tenant_id = $1 and id = $2 and confirm_status = 'pending'
      returning id`,
    [tenantId, eventId],
  );
  return rows.length ? String(rows[0].id) : null;
}

/// Per-day confirmation state, keyed `employeeRef|yyyy-mm-dd`, so a day list can
/// say whether anyone vouched for it without a query per row.
///
/// A day is only as good as its worst check-in: one unconfirmed arrival makes
/// the day unconfirmed, exactly as one unverified location does.
async function confirmationIndex(tenantId, { from = null, to = null, employeeRef = null } = {}) {
  const out = new Map();
  if (!(await ensureSettingsColumn())) return out;
  const tz = await tenantTz(tenantId);
  const params = [tenantId, tz, from || '1970-01-01', to || '2999-12-31'];
  const clauses = [
    'tenant_id = $1',
    "type = 'check_in'",
    'confirm_status is not null',
    '(at at time zone $2)::date between $3::date and $4::date',
  ];
  if (employeeRef) { params.push(employeeRef); clauses.push(`employee_ref = $${params.length}`); }
  const rows = await q(
    `select employee_ref, confirm_status, (at at time zone $2)::date as day
       from events where ${clauses.join(' and ')}`,
    params,
  );
  const rank = { rejected: 0, unconfirmed: 1, pending: 2, confirmed: 3 };
  for (const r of rows) {
    const key = `${r.employee_ref}|${dayStr(r.day)}`;
    const prev = out.get(key);
    const v = String(r.confirm_status);
    if (prev === undefined || (rank[v] ?? 9) < (rank[prev] ?? 9)) out.set(key, v);
  }
  return out;
}

/// Check-ins still waiting for a manager to say the person is actually there.
///
/// Scoped to the tenant's LOCAL today: a confirmation nobody answered three
/// weeks ago is a timesheet correction, not something to put in front of an
/// admin as an action for this morning. Those still show as unconfirmed on the
/// timesheet, which is where they belong.
export async function pendingConfirmations(tenantId) {
  const tz = await tenantTz(tenantId);
  if (!(await ensureSettingsColumn())) return [];
  const rows = await q(
    `select e.id, e.employee_ref, e.at, z.name as zone_name,
            coalesce(m.name, '') as name
       from events e
       left join zones z on z.id = e.zone_id
       left join memberships m on m.tenant_id = e.tenant_id and m.employee_ref = e.employee_ref
      where e.tenant_id = $1 and e.type = 'check_in' and e.confirm_status = 'pending'
        and e.at >= (date_trunc('day', now() at time zone $2) at time zone $2)
      order by e.at desc`,
    [tenantId, tz],
  );
  return rows.map((r) => ({
    id: String(r.id),
    employeeRef: String(r.employee_ref),
    name: r.name || '',
    at: iso(r.at),
    zoneName: r.zone_name || null,
    minutesAgo: Math.max(0, Math.round((Date.now() - new Date(r.at).getTime()) / 60000)),
  }));
}

/// Record a manager's answer. Returns null when the punch is not a pending
/// check-in in this tenant — so a stale tap from a screen left open overnight
/// reports "already handled" rather than silently overwriting a decision.
export async function setConfirmation(tenantId, eventId, status, by) {
  if (!(await ensureSettingsColumn())) return null;
  const v = status === 'rejected' ? 'rejected' : 'confirmed';
  const rows = await q(
    `update events set confirm_status = $3, confirmed_by = $4, confirmed_at = now()
      where tenant_id = $1 and id = $2 and type = 'check_in' and confirm_status = 'pending'
      returning id, employee_ref, at, confirm_status`,
    [tenantId, eventId, v, String(by || '')],
  );
  if (!rows.length) return null;
  return {
    id: String(rows[0].id),
    employeeRef: String(rows[0].employee_ref),
    at: iso(rows[0].at),
    confirmStatus: rows[0].confirm_status,
  };
}

/// The check-in that a check-out is closing, if it was never confirmed.
///
/// Looked up by "most recent check_in still pending for this person today",
/// which is the same pairing the day summary walks. Returns null when there is
/// nothing outstanding — the ordinary case, and the one that must stay silent.
export async function unconfirmedOpenCheckIn(tenantId, employeeRef) {
  const tz = await tenantTz(tenantId);
  if (!(await ensureSettingsColumn())) return null;
  const rows = await q(
    `select id, at from events
      where tenant_id = $1 and employee_ref = $2 and type = 'check_in'
        and confirm_status = 'pending'
        and at >= (date_trunc('day', now() at time zone $3) at time zone $3)
      order by at desc limit 1`,
    [tenantId, employeeRef, tz],
  );
  return rows.length ? { id: String(rows[0].id), at: iso(rows[0].at) } : null;
}

/// The employee_refs of everyone who manages attendance here — the audience for
/// a manager notification. Read from memberships (the plugin's own record of who
/// is a manager) rather than from the roster, because the roster describes Eesa
/// platform roles and a platform admin is not necessarily the person who runs
/// the rota.
export async function managerRefs(tenantId) {
  const rows = await q(
    `select employee_ref from memberships
      where tenant_id = $1 and active = true and role = 'manager'`,
    [tenantId],
  );
  return rows.map((r) => String(r.employee_ref));
}

/// The display name for one person, for a notification that has to say who it
/// is about. Falls back to a neutral phrase — a push reading "undefined checked
/// in" is worse than one that is merely vague.
export async function displayName(tenantId, employeeRef) {
  const rows = await q(
    `select name from memberships where tenant_id = $1 and employee_ref = $2`,
    [tenantId, employeeRef],
  );
  const n = (rows[0]?.name || '').trim();
  return n || 'A team member';
}

export async function getTenantTimezone(tenantId) {
  const rows = await q(`select timezone from tenant_settings where tenant_id = $1`, [tenantId]);
  return rows[0]?.timezone || 'UTC';
}

export async function setTenantTimezone(tenantId, timezone) {
  let tz = String(timezone || 'UTC').slice(0, 64);
  // Reject a bad IANA zone before it can break the `at time zone` day math.
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); } catch { tz = 'UTC'; }
  await q(
    `insert into tenant_settings (tenant_id, timezone, updated_at) values ($1, $2, now())
     on conflict (tenant_id) do update set timezone = excluded.timezone, updated_at = now()`,
    [tenantId, tz],
  );
  _tzCache.set(tenantId, tz);
  return { timezone: tz };
}

// ---- approvals + reporting (manager) --------------------------------------
// Day summaries for a period, annotated with the member's name — the approval
// queue the manager acts on. Filter by date range and/or approval status.
export async function listApprovals(tenantId, { from = null, to = null, status = null } = {}) {
  const params = [tenantId];
  const clauses = ['ds.tenant_id = $1'];
  if (from) { params.push(from); clauses.push(`ds.day >= $${params.length}`); }
  if (to) { params.push(to); clauses.push(`ds.day <= $${params.length}`); }
  if (status) { params.push(status); clauses.push(`ds.approval_status = $${params.length}`); }
  const rows = await q(
    `select ds.employee_ref, ds.day, ds.first_in, ds.last_out, ds.total_minutes,
            ds.approval_status, ds.approved_by, ds.approved_at,
            coalesce(m.name, '') as name, m.pay_rate, sc.expected_minutes
       from day_summaries ds
       left join memberships m on m.tenant_id = ds.tenant_id and m.employee_ref = ds.employee_ref
       left join schedules  sc on sc.tenant_id = ds.tenant_id and sc.employee_ref = ds.employee_ref and sc.day = ds.day
      where ${clauses.join(' and ')}
      order by ds.day desc, name`,
    params,
  );
  const vi = await verificationIndex(tenantId, { from, to });
  return rows.map((r) => {
    const day = dayStr(r.day);
    return {
      employeeRef: r.employee_ref,
      name: r.name,
      day,
      firstIn: iso(r.first_in),
      lastOut: iso(r.last_out),
      totalMinutes: Number(r.total_minutes || 0),
      expectedMinutes: r.expected_minutes == null ? null : Number(r.expected_minutes),
      approvalStatus: r.approval_status || 'pending',
      approvedBy: r.approved_by || null,
      approvedAt: iso(r.approved_at),
      payRate: r.pay_rate == null ? null : Number(r.pay_rate),
      // Whether the punches behind this timesheet could be confirmed on
      // location. Surfaced so the manager approves with that in view — it is
      // never a filter, an unverified day is still there to approve.
      ...(vi.get(`${r.employee_ref}|${day}`) || NO_EVENTS),
    };
  });
}

export async function setApproval(tenantId, employeeRef, day, status, approvedBy) {
  const st = ['approved', 'rejected', 'pending'].includes(status) ? status : 'pending';
  const rows = await q(
    `update day_summaries
        set approval_status = $4,
            approved_by = case when $4 = 'pending' then null else $5 end,
            approved_at = case when $4 = 'pending' then null else now() end,
            updated_at = now()
      where tenant_id = $1 and employee_ref = $2 and day = $3
      returning employee_ref`,
    [tenantId, employeeRef, day, st, approvedBy],
  );
  return { employeeRef: String(employeeRef), day: String(day), approvalStatus: st, updated: rows.length > 0 };
}

// Admin logs an event on a staff member's behalf (fallback / correction).
// NOTE: recomputes today's summary; a back-dated entry to a prior day is stored
// but that day's summary is recomputed lazily (v1 limitation).
/// Remove a punch an admin entered by hand.
///
/// **Only `source = 'manual'`.** A device punch is evidence — it has a position,
/// an accuracy and a time the phone stood behind — and the way to correct one is
/// to add the punch that was missed, so the record still shows what happened and
/// what was done about it. An admin's own typo has no such standing: nothing was
/// observed, so there is nothing to preserve, and leaving it on someone's
/// timesheet as a shift they never worked is worse than the gap it was meant to
/// fill.
///
/// Returns the employee and day so the caller can tell them, and so the day's
/// totals can be rebuilt — a deleted check-in that left `day_summaries` alone
/// would keep paying out hours whose punch no longer exists.
export async function deleteManualEvent(tenantId, eventId) {
  const rows = await q(
    `delete from events
      where tenant_id = $1 and id = $2 and source = 'manual'
      returning employee_ref, type, at`,
    [tenantId, eventId],
  );
  if (!rows.length) return null;
  const employeeRef = String(rows[0].employee_ref);
  await upsertDaySummary(tenantId, employeeRef);
  return { employeeRef, type: rows[0].type, at: iso(rows[0].at) };
}

export async function manualEntry(tenantId, employeeRef, type, at = null) {
  const t = type === 'check_out' ? 'check_out' : 'check_in';
  await q(
    `insert into events (tenant_id, employee_ref, type, at, for_work, source)
     values ($1, $2, $3, coalesce($4::timestamptz, now()), true, 'manual')`,
    [tenantId, employeeRef, t, at],
  );
  await upsertDaySummary(tenantId, employeeRef);
  return { employeeRef: String(employeeRef), type: t };
}

// Per-employee totals for a period — the EOD report + the QBO export basis.
// Unions worked days (day_summaries) with scheduled days (schedules) so the
// report shows Actual vs Expected vs Difference even when a scheduled day was
// NOT worked (absence) or a worked day was NOT scheduled.
export async function report(tenantId, { from = null, to = null } = {}) {
  const f = from || '1970-01-01';
  const t = to || '2999-12-31';
  const rows = await q(
    `with keys as (
       select employee_ref, day from day_summaries where tenant_id = $1 and day between $2 and $3
       union
       select employee_ref, day from schedules     where tenant_id = $1 and day between $2 and $3
     )
     select k.employee_ref, coalesce(m.name, '') as name, m.pay_rate,
            sum(coalesce(ds.total_minutes, 0)) as total_minutes,
            sum(case when ds.approval_status = 'approved' then ds.total_minutes else 0 end) as approved_minutes,
            sum(coalesce(sc.expected_minutes, 0)) as expected_minutes,
            count(sc.day) as scheduled_days,
            count(distinct k.day) as days
       from keys k
       left join day_summaries ds on ds.tenant_id = $1 and ds.employee_ref = k.employee_ref and ds.day = k.day
       left join schedules     sc on sc.tenant_id = $1 and sc.employee_ref = k.employee_ref and sc.day = k.day
       left join memberships   m  on m.tenant_id  = $1 and m.employee_ref  = k.employee_ref
      group by k.employee_ref, m.name, m.pay_rate
      order by name`,
    [tenantId, f, t],
  );
  return rows.map((r) => {
    const totalMinutes = Number(r.total_minutes || 0);
    const approvedMinutes = Number(r.approved_minutes || 0);
    const expectedMinutes = Number(r.expected_minutes || 0);
    const rate = r.pay_rate == null ? null : Number(r.pay_rate);
    return {
      employeeRef: r.employee_ref,
      name: r.name,
      days: Number(r.days || 0),
      totalMinutes,
      approvedMinutes,
      expectedMinutes,
      hasSchedule: Number(r.scheduled_days || 0) > 0,
      differenceMinutes: totalMinutes - expectedMinutes,
      payRate: rate,
      approvedPay: rate == null ? null : Math.round((approvedMinutes / 60) * rate * 100) / 100,
    };
  });
}

// ---- schedules (optional per-person, per-day expected minutes) -------------
export async function listSchedules(tenantId, { from = null, to = null, employeeRef = null } = {}) {
  const params = [tenantId];
  const clauses = ['s.tenant_id = $1'];
  if (from) { params.push(from); clauses.push(`s.day >= $${params.length}`); }
  if (to) { params.push(to); clauses.push(`s.day <= $${params.length}`); }
  if (employeeRef) { params.push(employeeRef); clauses.push(`s.employee_ref = $${params.length}`); }
  const rows = await q(
    `select s.employee_ref, s.day, s.expected_minutes, s.note, coalesce(m.name, '') as name
       from schedules s
       left join memberships m on m.tenant_id = s.tenant_id and m.employee_ref = s.employee_ref
      where ${clauses.join(' and ')}
      order by s.day desc, name`,
    params,
  );
  return rows.map((r) => ({
    employeeRef: r.employee_ref,
    name: r.name,
    day: dayStr(r.day),
    expectedMinutes: Number(r.expected_minutes || 0),
    note: r.note || '',
  }));
}

export async function upsertSchedule(
  tenantId, { employeeRef, day, expectedMinutes = null, note = '', templateId = null },
) {
  let mins = expectedMinutes;
  let outNote = note;
  const tplId = templateId || null;
  // Assigning a template drives the expected hours from (end-start)-break, and
  // defaults the note to the template's name for a readable Schedule list.
  if (tplId) {
    const t = await getTemplate(tenantId, tplId);
    if (!t) throw Object.assign(new Error('template not found'), { status: 404 });
    mins = t.expectedMinutes;
    if (!outNote) outNote = t.name;
  }
  const rows = await q(
    `insert into schedules (tenant_id, employee_ref, day, expected_minutes, note, template_id, updated_at)
     values ($1, $2, $3, $4, $5, $6, now())
     on conflict (tenant_id, employee_ref, day) do update
       set expected_minutes = excluded.expected_minutes, note = excluded.note,
           template_id = excluded.template_id, updated_at = now()
     returning employee_ref, day, expected_minutes, note, template_id`,
    [tenantId, employeeRef, day, Math.max(0, Math.round(Number(mins) || 0)),
     String(outNote || '').slice(0, 300), tplId],
  );
  const r = rows[0];
  return {
    employeeRef: r.employee_ref, day: dayStr(r.day),
    expectedMinutes: Number(r.expected_minutes || 0), note: r.note || '',
    templateId: r.template_id ? String(r.template_id) : null,
  };
}

export async function removeSchedule(tenantId, employeeRef, day) {
  await q(`delete from schedules where tenant_id = $1 and employee_ref = $2 and day = $3`, [tenantId, employeeRef, day]);
  return { employeeRef: String(employeeRef), day: String(day), removed: true };
}
