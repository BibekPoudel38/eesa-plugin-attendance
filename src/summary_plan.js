/// What managers and staff are told on a schedule, instead of on every punch.
///
/// Pure, like notify_plan.js: the words and the timing live here and are
/// tested without a database or a phone. summaries.js only fetches and sends.
///
///   Managers, every morning at 9:00 — yesterday in one line.
///   Managers, Monday at 9:00        — last week's timesheets are ready.
///   Staff, when their week is approved — their hours for that week.
///
/// These replace a push to every manager on every arrival and departure
/// (about 18 a day each at ten staff) and a push to staff on every approved day.

export const SUMMARY_HOUR = 9;

/// "8h 09m", the way hours are said out loud rather than "489 minutes".
export function spanOf(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

/// The workplace's own date, hour and weekday for an instant.
export function localParts(now, tz) {
  const d = now instanceof Date ? now : new Date(now);
  const ymd = d.toLocaleDateString('en-CA', { timeZone: tz || 'UTC' });
  const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz || 'UTC' }).format(d));
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: tz || 'UTC' }).format(d);
  return { ymd, hour, weekday };
}

/// YYYY-MM-DD plus n days, on the calendar (no timezone involved).
export function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

// Spelled out rather than taken from Intl: locale data differs between Node
// builds ("Sep" on one, "Sept" on another), and these words end up on phones.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/// "Tue 15 Sep".
export function dayLabel(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WEEKDAYS[wd]} ${d} ${MONTHS[m - 1]}`;
}

/// "8–14 Sep", or "28 Sep – 4 Oct" across a month.
export function rangeLabel(from, to) {
  const [, fm, fd] = from.split('-').map(Number);
  const [, tm, td] = to.split('-').map(Number);
  return fm === tm
    ? `${fd}–${td} ${MONTHS[tm - 1]}`
    : `${fd} ${MONTHS[fm - 1]} – ${td} ${MONTHS[tm - 1]}`;
}

/// Which summaries are due at this moment. Daily from 9:00; weekly from 9:00
/// on Monday, covering the Monday-to-Sunday that just ended. Being due is not
/// the same as being sent — the caller claims each one first.
export function dueSummaries(now, tz) {
  const { ymd, hour, weekday } = localParts(now, tz);
  if (hour < SUMMARY_HOUR) return [];
  const due = [{ kind: 'daily', day: addDays(ymd, -1), periodKey: addDays(ymd, -1) }];
  if (weekday === 'Mon') {
    const from = addDays(ymd, -7);
    due.push({ kind: 'weekly', from, to: addDays(ymd, -1), periodKey: from });
  }
  return due;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/// Roll a list of days (from db.listApprovals) up to what a summary says.
export function rollUp(days) {
  const worked = days.filter((d) => d.totalMinutes > 0 || d.open || d.needsFix);
  return {
    people: new Set(worked.map((d) => String(d.employeeRef))).size,
    minutes: worked.reduce((n, d) => n + (d.totalMinutes || 0), 0),
    needsFix: worked.filter((d) => d.needsFix).length,
  };
}

/// The morning line. Null when there is nothing to say — no empty summaries.
export function dailySummary(day, { people, minutes, needsFix }) {
  if (!people && !needsFix) return null;
  const fix = needsFix ? `${plural(needsFix, 'day needs', 'days need')} a fix` : 'all look right';
  return {
    title: `Attendance · ${dayLabel(day)}`,
    body: `${plural(people, 'person', 'people')} · ${spanOf(minutes)} · ${fix}`,
  };
}

/// Monday's line: last week is ready to approve, or what stands in the way.
export function weeklySummary(from, to, { people, minutes, needsFix }) {
  if (!people && !needsFix) return null;
  const next = needsFix
    ? `fix ${plural(needsFix, 'day', 'days')} before approving`
    : 'ready to approve';
  return {
    title: `Timesheets for ${rangeLabel(from, to)}`,
    body: `${plural(people, 'person', 'people')} · ${spanOf(minutes)} · ${next}`,
  };
}

/// What a staff member hears once their week is approved.
export function weekApprovedMessage(from, to, minutes) {
  return {
    title: `Your hours for ${rangeLabel(from, to)}`,
    body: `${spanOf(minutes)} · approved`,
  };
}
