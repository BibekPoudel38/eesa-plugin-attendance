/// Sends the scheduled summaries. Everything worded or timed lives in
/// summary_plan.js; this only asks what is due, claims it, and sends it.
import * as db from './db.js';
import { notifyUsers } from './notify.js';
import { dueSummaries, rollUp, dailySummary, weeklySummary } from './summary_plan.js';

const TICK_MS = 60 * 1000;

/// Notification types the phone already routes to a manager's Attendance tab
/// (a manager-kind with an employeeRef). The data says which summary it is;
/// the next app release gives summaries a type of their own.
const MANAGER_TYPE = 'attendance_day_review';

export function startSummaries({ managerAudience, names = null }) {
  const tick = () => runDue(new Date(), { managerAudience, names })
    .catch((e) => console.error('[attendance] summaries failed:', e && e.message));
  setTimeout(tick, 20 * 1000).unref?.();
  setInterval(tick, TICK_MS).unref?.();
}

/// Claims a summary only once it is ready to send. Claiming first meant a
/// database or roster hiccup between the claim and the send lost that day's
/// summary for good (16 Sep: the pooler refused connections at 10:32). Now a
/// failure leaves nothing claimed and the next minute tries again; the claim
/// still guarantees two instances never both send.
export async function runDue(now, { managerAudience, names = null, store = db, notify = notifyUsers }) {
  for (const t of await store.tenantsWithSettings()) {
    for (const due of dueSummaries(now, t.timezone)) {
      const from = due.kind === 'daily' ? due.day : due.from;
      const to = due.kind === 'daily' ? due.day : due.to;
      const totals = rollUp(await store.listApprovals(t.tenantId, { from, to }));
      // Names from the roster: the plugin's own rows are blank for anyone it
      // never enrolled itself, and "Location off: 1h 05m" names nobody.
      if (names && totals.locationOff.length) {
        const byRef = await names(t.tenantId).catch(() => new Map());
        totals.locationOff = totals.locationOff.map((p) => ({ ...p, name: byRef.get(p.employeeRef) || p.name }));
      }
      const msg = due.kind === 'daily'
        ? dailySummary(due.day, totals)
        : weeklySummary(due.from, due.to, totals);
      // An empty day is a settled answer: claim it so it isn't recomputed all day.
      if (!msg) { await store.claimSummary(t.tenantId, due.kind, due.periodKey); continue; }
      // No managers may be a roster that failed to load — try again next minute.
      const managers = await managerAudience(t.tenantId);
      if (!managers.length) continue;
      if (!(await store.claimSummary(t.tenantId, due.kind, due.periodKey))) continue;
      notify(t.tenantId, managers, {
        ...msg,
        type: MANAGER_TYPE,
        data: { employeeRef: 'team', summary: due.kind, from, to },
      });
      console.log(`[attendance] sent ${due.kind} summary for ${from}…${to} to ${managers.length} manager(s)`);
    }
  }
}
