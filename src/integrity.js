/// A shift that needs a manager's look, in words — for the tenant agent's tools
/// and for the alert a flow sends — and the watcher that says so when one
/// appears.
///
/// This service never messages anyone about it. It fires one event,
/// attendance.needs_a_look, and the workspace's flows in Eesa decide who hears
/// about it, how and whether at all (/flows: visible, editable, switchable off
/// by the people receiving it). The page keeps its own words for the screen
/// (public/app.html); these are the ones that leave the service.
import * as db from './db.js';
import { STRONG_FLAGS } from './presence.js';
import { recordEvent } from './telemetry.js';

const API_BASE = (process.env.EESA_API_BASE || 'https://eesa.ai/api/v1').replace(/\/+$/, '');
const GATEWAY_SECRET = process.env.PLUGIN_GATEWAY_SECRET || '';

export const EVENT = 'attendance.needs_a_look';
/// What a manager should hear about as it happens: the phone's strong evidence,
/// and Location switched off. The rest waits for the timesheet.
export const ALERT_FLAGS = new Set([...STRONG_FLAGS, 'location_off']);
const TICK_MS = 5 * 60 * 1000;

export const FLAG_WORDS = {
  away: 'Away from the zone',
  simulated: 'Location not from GPS',
  clock_changed: 'Clock changed by hand',
  log_gap: "Part of the phone's log missing or changed",
  phone_off: 'Phone switched off',
  went_quiet: 'Stopped answering',
  silent: 'No answer',
  offline: 'No network',
  restarted: 'Phone restarted',
  location_off: 'Location off',
  no_check_out: 'No check-out',
  no_check_in: 'No check-in',
  over_12h: 'Over 12 hours',
  left_later: 'Left later than recorded',
  changed: 'Changed by a manager',
};

const clock = (at, tz) => new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz || 'UTC' });
const span = (from, to, tz) => (to && to !== from ? `${clock(from, tz)} – ${clock(to, tz)}` : clock(from, tz));
const metres = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
export const hours = (min) => `${Math.floor((min || 0) / 60)}h ${String(Math.round(min || 0) % 60).padStart(2, '0')}m`;

/// One piece of the phone's evidence as a manager reads it.
export function evidenceLine(e, tz) {
  const what = FLAG_WORDS[e.flag] || e.flag;
  const when = span(e.at, e.until, tz);
  const detail = {
    away: () => (e.meters != null ? `${metres(e.meters)} from ${e.zone || 'the zone'}` : ''),
    clock_changed: () => (e.byMs ? `moved ${hours(Math.abs(e.byMs) / 60000)} ${e.byMs > 0 ? 'ahead' : 'back'}` : ''),
    log_gap: () => (e.edited ? 'an entry was changed on the phone' : e.missing ? `${e.missing} missing` : ''),
    phone_off: () => `${e.missed} checks unanswered, then restarted`,
    went_quiet: () => `${e.missed} checks unanswered, then answered again`,
    silent: () => `${e.missed} checks unanswered`,
  }[e.flag];
  const extra = detail ? detail() : '';
  return `${what} ${when}${extra ? ` (${extra})` : ''}`;
}

/// A stretch the phone could not see them leave.
export function locationOffLine(w, tz) {
  return `Location off ${w.open ? `since ${clock(w.from, tz)}` : span(w.from, w.to, tz)}`;
}

/// One person's day for the agent and for an alert.
export function dayReport(row, { name, tz }) {
  const evidence = [
    ...(row.locationOff || []).map((w) => ({ at: w.from, line: locationOffLine(w, tz) })),
    ...(row.integrity || []).map((e) => ({ at: e.at, line: evidenceLine(e, tz) })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at)).map((x) => x.line);
  return {
    employeeRef: String(row.employeeRef),
    name: name || row.name || 'A team member',
    day: row.day,
    hours: hours(row.totalMinutes),
    needsFix: Boolean(row.needsFix),
    flags: (row.flags || []).map((f) => FLAG_WORDS[f] || f),
    evidence,
  };
}

const dayName = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/// The alert, ready to send as it is.
export function summaryOf(report) {
  const lines = report.evidence.length ? report.evidence.join('; ') : report.flags.join(', ');
  return `${report.name}'s shift on ${dayName(report.day)} needs a look: ${lines}. `
    + `The hours stand at ${report.hours} until a manager decides.`;
}

/// Tell Eesa a shift needs a look. The flows decide the rest.
export async function fireFlowEvent(tenantId, payload) {
  if (!GATEWAY_SECRET) return false;
  let ok = false;
  let code = '';
  try {
    const res = await fetch(`${API_BASE}/gateway/flow-event/`, {
      method: 'POST',
      headers: { 'X-Eesa-Gateway-Secret': GATEWAY_SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant: tenantId, event: EVENT, payload }),
    });
    ok = res.ok;
    if (!ok) code = `http_${res.status}`;
  } catch (e) {
    code = 'unreachable';
  }
  recordEvent('attendance.notify.sent', {
    outcome: ok ? 'ok' : 'fail', tenantId, userRef: payload.employee_ref, errorCode: code,
    context: { kind: 'flow_event' },
  });
  return ok;
}

export function startIntegrityAlerts({ names }) {
  const tick = () => runIntegrityAlerts({ names })
    .catch((e) => console.error('[attendance] integrity alerts failed:', e && e.message));
  setTimeout(tick, 45 * 1000).unref?.();
  setInterval(tick, TICK_MS).unref?.();
}

/// Every shift of yesterday and today that newly needs a look, told once per
/// kind of evidence. Marked told only after Eesa took it, so a backend that
/// was down is tried again on the next tick.
export async function runIntegrityAlerts({ store = db, names = null, fire = fireFlowEvent, now = Date.now() } = {}) {
  let fired = 0;
  for (const t of await store.tenantsWithSettings()) {
    const today = db.localDay(now, t.timezone);
    const yesterday = db.localDay(now - 864e5, t.timezone);
    const rows = await store.listApprovals(t.tenantId, { from: yesterday, to: today });
    let byRef = null;
    for (const row of rows) {
      if (!row.needsFix) continue;
      const kinds = [...new Set((row.flags || []).filter((f) => ALERT_FLAGS.has(f)))];
      if (!kinds.length) continue;
      const told = await store.integrityAlerted(t.tenantId, row.employeeRef, row.day);
      if (!told) continue;
      const fresh = kinds.filter((k) => !told.has(k)).sort();
      if (!fresh.length) continue;
      if (!byRef && names) byRef = await names(t.tenantId).catch(() => new Map());
      const report = dayReport(row, { name: byRef && byRef.get(String(row.employeeRef)), tz: t.timezone });
      const payload = {
        employee_ref: report.employeeRef,
        name: report.name,
        day: report.day,
        flags: fresh.map((f) => FLAG_WORDS[f] || f),
        evidence: report.evidence,
        hours: report.hours,
        summary: summaryOf(report),
        dedupe_key: `${report.employeeRef}|${report.day}|${fresh.join(',')}`,
      };
      if (await fire(t.tenantId, payload)) {
        await store.markIntegrityAlerted(t.tenantId, row.employeeRef, row.day, fresh);
        fired += 1;
      }
    }
  }
  return fired;
}
