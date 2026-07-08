// Attendance data layer — Supabase / Postgres via pg. Every query is scoped to
// tenant_id (from the verified token); employee_ref is the token `sub`.
//
// All rows are normalized to the plugin's public v2 JSON contract before they
// leave this layer (camelCase, ISO-8601 timestamps) so the REST/MCP surfaces and
// the Flutter client speak one shape. No Firestore/Firebase concepts remain.
import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Managed Postgres (Supabase/Neon/RDS) needs SSL; set PGSSL=disable for a
  // plain/local Postgres (e.g. a Coolify-hosted database).
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
});

async function q(text, params) {
  const r = await pool.query(text, params);
  return r.rows;
}

// ---- normalizers ----------------------------------------------------------
const iso = (v) => (v == null ? null : (v instanceof Date ? v : new Date(v)).toISOString());
const dayStr = (d) => (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);
const zoneOut = (r) => ({
  id: String(r.id),
  name: r.name,
  lat: Number(r.center_lat),
  lng: Number(r.center_lng),
  radiusM: Number(r.radius_m),
});

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

// ---- events / check-in-out ------------------------------------------------
export async function recordEvent(tenantId, employeeRef, type, { zoneId = null, lat = null, lng = null } = {}) {
  const rows = await q(
    `insert into events (tenant_id, employee_ref, type, zone_id, lat, lng)
     values ($1, $2, $3, $4, $5, $6) returning id, type, at`,
    [tenantId, employeeRef, type, zoneId, lat, lng],
  );
  await upsertDaySummary(tenantId, employeeRef);
  return { id: String(rows[0].id), type: rows[0].type, at: iso(rows[0].at) };
}

// Today's raw events, ascending — the basis for status + the day summary.
async function todaysEvents(tenantId, employeeRef) {
  return q(
    `select type, zone_id, at from events
      where tenant_id = $1 and employee_ref = $2 and at >= date_trunc('day', now())
      order by at asc`,
    [tenantId, employeeRef],
  );
}

// Walk paired check_in→check_out intervals; an unmatched trailing check_in is
// counted as an open interval up to "now" (so hours-worked ticks live).
function computeToday(events) {
  let openIn = null; // Date of an unmatched check_in
  let firstIn = null;
  let lastOut = null;
  let lastZone = null;
  let ms = 0;
  for (const e of events) {
    const at = new Date(e.at);
    if (e.type === 'check_in') {
      firstIn ??= at;
      openIn = at;
      lastZone = e.zone_id;
    } else if (e.type === 'check_out') {
      lastOut = at;
      if (openIn) {
        ms += at - openIn;
        openIn = null;
      }
    }
  }
  const checkedIn = openIn != null;
  if (checkedIn) ms += Date.now() - openIn.getTime();
  return {
    checkedIn,
    since: checkedIn ? openIn : null,
    zoneId: checkedIn && lastZone != null ? String(lastZone) : null,
    firstIn,
    lastOut,
    totalMinutes: Math.max(0, Math.round(ms / 60000)),
  };
}

export async function myStatus(tenantId, employeeRef) {
  const events = await todaysEvents(tenantId, employeeRef);
  const t = computeToday(events);
  const today = events.length
    ? {
        date: dayStr(new Date()),
        totalMinutes: t.totalMinutes,
        firstIn: iso(t.firstIn),
        lastOut: iso(t.lastOut),
        status: t.checkedIn ? 'open' : t.firstIn && t.lastOut ? 'complete' : 'incomplete',
      }
    : null;
  return {
    checkedIn: t.checkedIn,
    since: iso(t.since),
    zoneId: t.zoneId,
    todayMinutes: t.totalMinutes,
    today,
  };
}

export async function myHistory(tenantId, employeeRef, days = 7) {
  const rows = await q(
    `select day, first_in, last_out, total_minutes from day_summaries
      where tenant_id = $1 and employee_ref = $2 order by day desc limit $3`,
    [tenantId, employeeRef, Math.max(1, Math.min(days, 90))],
  );
  return {
    days: rows.map((r) => ({
      date: dayStr(r.day),
      totalMinutes: Number(r.total_minutes || 0),
      firstIn: iso(r.first_in),
      lastOut: iso(r.last_out),
      status: r.last_out ? 'complete' : r.first_in ? 'incomplete' : 'open',
    })),
  };
}

export async function whoIsLate(tenantId, cutoffHour = 9) {
  const rows = await q(
    `select employee_ref, min(at) as first_in from events
      where tenant_id = $1 and type = 'check_in' and at >= date_trunc('day', now())
      group by employee_ref
      having extract(hour from min(at)) >= $2
      order by first_in`,
    [tenantId, cutoffHour],
  );
  return rows.map((r) => ({ employeeRef: r.employee_ref, firstIn: iso(r.first_in) }));
}

export async function presence(tenantId) {
  const rows = await q(
    `select distinct on (employee_ref) employee_ref, type, at from events
      where tenant_id = $1 and at >= date_trunc('day', now())
      order by employee_ref, at desc`,
    [tenantId],
  );
  return {
    employees: rows.map((r) => ({
      employeeRef: r.employee_ref,
      checkedIn: r.type === 'check_in',
      at: iso(r.at),
    })),
  };
}

// Recompute today's summary (first_in, last_out, total_minutes) from events.
async function upsertDaySummary(tenantId, employeeRef) {
  const t = computeToday(await todaysEvents(tenantId, employeeRef));
  await q(
    `insert into day_summaries (tenant_id, employee_ref, day, first_in, last_out, total_minutes, updated_at)
     values ($1, $2, current_date, $3, $4, $5, now())
     on conflict (tenant_id, employee_ref, day)
     do update set first_in = excluded.first_in, last_out = excluded.last_out,
                   total_minutes = excluded.total_minutes, updated_at = now()`,
    [tenantId, employeeRef, t.firstIn, t.lastOut, t.totalMinutes],
  );
}
