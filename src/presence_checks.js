/// "Still here?" — while somebody is on the clock, their phone is asked every
/// twenty minutes to write down where it is. It is a silent push: nothing shows
/// on the phone and nothing lands in anybody's inbox. iOS delivers it when it
/// chooses (a few an hour at most, never to an app that was swiped away), so a
/// missing answer is never held against anyone; an answer from 1.4 km away is.
///
/// Off until PRESENCE_CHECKS=on. The backend has to be able to send a push with
/// nothing on screen first, and the app has to know what to do with one.
import * as db from './db.js';
import { notifyUser } from './notify.js';

const TICK_MS = 60 * 1000;
export const KIND = 'attendance_presence_check';

export const presenceChecksOn = (env = process.env) => /^(1|on|true|yes)$/i.test(String(env.PRESENCE_CHECKS || '').trim());
/// Apple asks for no more than two or three silent pushes an hour; fifteen
/// minutes is the floor, twenty the default.
export const checkEveryMs = (env = process.env) => Math.max(15, Number(env.PRESENCE_CHECK_MINUTES) || 20) * 60 * 1000;

export function startPresenceChecks() {
  if (!presenceChecksOn()) {
    console.log('[attendance] presence checks off (set PRESENCE_CHECKS=on to ask phones "still here?")');
    return;
  }
  const tick = () => runPresenceChecks()
    .catch((e) => console.error('[attendance] presence checks failed:', e && e.message));
  setInterval(tick, TICK_MS).unref?.();
}

export async function runPresenceChecks({ store = db, notify = notifyUser, now = Date.now(), everyMs = checkEveryMs() } = {}) {
  const due = await store.claimPresenceChecks({ everyMs, now });
  for (const p of due) {
    const sent = await notify(p.tenantId, p.employeeRef, { silent: true, type: KIND, data: { kind: KIND } });
    // Only a push that left is a question asked. One the backend refused
    // cannot go unanswered, and counting it would make an honest phone look quiet.
    if (sent !== false) await store.logPresenceCheck(p.tenantId, p.employeeRef, new Date(now)).catch(() => {});
  }
  return due.length;
}
