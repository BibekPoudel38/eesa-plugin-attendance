// Attendance data layer — Supabase (Postgres) via pg. Every query is scoped to
// tenant_id (from the verified token); employee_ref is the token `sub`.
import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase requires SSL; set PGSSL=disable only for a local Postgres.
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
});

async function q(text, params) {
  const r = await pool.query(text, params);
  return r.rows;
}

// ---- zones ----
export async function listZones(tenantId) {
  return q(
    `select id, name, center_lat, center_lng, radius_m, active
       from zones where tenant_id = $1 and active = true order by name`,
    [tenantId],
  );
}

export async function createZone(tenantId, { name, lat, lng, radius }) {
  const rows = await q(
    `insert into zones (tenant_id, name, center_lat, center_lng, radius_m)
     values ($1, $2, $3, $4, $5)
     returning id, name, center_lat, center_lng, radius_m, active`,
    [tenantId, name, lat, lng, radius || 100],
  );
  return rows[0];
}

// ---- events / check-in-out ----
export async function recordEvent(tenantId, employeeRef, type, { zoneId = null, lat = null, lng = null } = {}) {
  const rows = await q(
    `insert into events (tenant_id, employee_ref, type, zone_id, lat, lng)
     values ($1, $2, $3, $4, $5, $6) returning id, type, at`,
    [tenantId, employeeRef, type, zoneId, lat, lng],
  );
  await upsertDaySummary(tenantId, employeeRef);
  return rows[0];
}

export async function myStatus(tenantId, employeeRef) {
  const rows = await q(
    `select type, at from events
      where tenant_id = $1 and employee_ref = $2 and at >= date_trunc('day', now())
      order by at desc limit 1`,
    [tenantId, employeeRef],
  );
  const last = rows[0] || null;
  return { present: last ? last.type === 'check_in' : false, last_event: last };
}

export async function myHistory(tenantId, employeeRef, days = 7) {
  return q(
    `select day, first_in, last_out, total_minutes from day_summaries
      where tenant_id = $1 and employee_ref = $2 order by day desc limit $3`,
    [tenantId, employeeRef, days],
  );
}

export async function whoIsLate(tenantId, cutoffHour = 9) {
  return q(
    `select employee_ref, min(at) as first_in from events
      where tenant_id = $1 and type = 'check_in' and at >= date_trunc('day', now())
      group by employee_ref
      having extract(hour from min(at)) >= $2
      order by first_in`,
    [tenantId, cutoffHour],
  );
}

export async function presence(tenantId) {
  return q(
    `select distinct on (employee_ref) employee_ref, type, at from events
      where tenant_id = $1 and at >= date_trunc('day', now())
      order by employee_ref, at desc`,
    [tenantId],
  );
}

async function upsertDaySummary(tenantId, employeeRef) {
  await q(
    `insert into day_summaries (tenant_id, employee_ref, day, first_in, last_out, total_minutes, updated_at)
     select $1, $2, current_date,
            min(at) filter (where type = 'check_in'),
            max(at) filter (where type = 'check_out'),
            0, now()
       from events
      where tenant_id = $1 and employee_ref = $2 and at >= date_trunc('day', now())
     on conflict (tenant_id, employee_ref, day)
     do update set first_in = excluded.first_in, last_out = excluded.last_out, updated_at = now()`,
    [tenantId, employeeRef],
  );
}
