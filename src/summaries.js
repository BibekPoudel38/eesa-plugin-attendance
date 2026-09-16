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

export function startSummaries({ managerAudience }) {
  const tick = () => runDue(new Date(), { managerAudience })
    .catch((e) => console.error('[attendance] summaries failed:', e && e.message));
  setTimeout(tick, 20 * 1000).unref?.();
  setInterval(tick, TICK_MS).unref?.();
}

export async function runDue(now, { managerAudience }) {
  for (const t of await db.tenantsWithSettings()) {
    for (const due of dueSummaries(now, t.timezone)) {
      if (!(await db.claimSummary(t.tenantId, due.kind, due.periodKey))) continue;
      const from = due.kind === 'daily' ? due.day : due.from;
      const to = due.kind === 'daily' ? due.day : due.to;
      const totals = rollUp(await db.listApprovals(t.tenantId, { from, to }));
      const msg = due.kind === 'daily'
        ? dailySummary(due.day, totals)
        : weeklySummary(due.from, due.to, totals);
      if (!msg) continue;
      const managers = await managerAudience(t.tenantId);
      if (!managers.length) continue;
      notifyUsers(t.tenantId, managers, {
        ...msg,
        type: MANAGER_TYPE,
        data: { employeeRef: 'team', summary: due.kind, from, to },
      });
      console.log(`[attendance] sent ${due.kind} summary for ${from}…${to} to ${managers.length} manager(s)`);
    }
  }
}
