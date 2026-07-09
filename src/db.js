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
});

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
export async function recordEvent(
  tenantId, employeeRef, type,
  { zoneId = null, lat = null, lng = null, forWork = true, source = 'geofence', workType = null } = {},
) {
  const rows = await q(
    `insert into events (tenant_id, employee_ref, type, zone_id, lat, lng, for_work, source, work_type)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id, type, at`,
    [tenantId, employeeRef, type, zoneId, lat, lng, forWork !== false, String(source || 'geofence'),
     workType ? String(workType).slice(0, 120) : null],
  );
  await upsertDaySummary(tenantId, employeeRef);
  return { id: String(rows[0].id), type: rows[0].type, at: iso(rows[0].at) };
}

// Today's raw events, ascending — the basis for status + the day summary.
// "Today" is the tenant's LOCAL day (not the DB/UTC day).
async function todaysEvents(tenantId, employeeRef) {
  const tz = await tenantTz(tenantId);
  return q(
    `select type, zone_id, at, for_work from events
      where tenant_id = $1 and employee_ref = $2
        and at >= (date_trunc('day', now() at time zone $3) at time zone $3)
      order by at asc`,
    [tenantId, employeeRef, tz],
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
      // "Here but not for work" (the geofence prompt's No / banner toggle) stops
      // counting work time from this point — it closes any open interval and does
      // NOT reopen one.
      if (e.for_work === false) {
        if (openIn) { ms += at - openIn; openIn = null; }
        continue;
      }
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
  const tz = await tenantTz(tenantId);
  const events = await todaysEvents(tenantId, employeeRef);
  const t = computeToday(events);
  const today = events.length
    ? {
        date: new Date().toLocaleDateString('en-CA', { timeZone: tz }),
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

export async function presence(tenantId) {
  const tz = await tenantTz(tenantId);
  const rows = await q(
    `select distinct on (employee_ref) employee_ref, type, at from events
      where tenant_id = $1 and at >= (date_trunc('day', now() at time zone $2) at time zone $2)
      order by employee_ref, at desc`,
    [tenantId, tz],
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

// ---- tenant settings (timezone) -------------------------------------------
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
  return rows.map((r) => ({
    employeeRef: r.employee_ref,
    name: r.name,
    day: dayStr(r.day),
    firstIn: iso(r.first_in),
    lastOut: iso(r.last_out),
    totalMinutes: Number(r.total_minutes || 0),
    expectedMinutes: r.expected_minutes == null ? null : Number(r.expected_minutes),
    approvalStatus: r.approval_status || 'pending',
    approvedBy: r.approved_by || null,
    approvedAt: iso(r.approved_at),
    payRate: r.pay_rate == null ? null : Number(r.pay_rate),
  }));
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
