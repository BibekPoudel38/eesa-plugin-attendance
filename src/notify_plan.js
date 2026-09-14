/// Who is told what when somebody punches — the whole model, as data.
///
/// It lives here, pure, so it can be read in one place and tested without a
/// database or a phone. server.js only dispatches what this returns.
///
/// The rule, in the words it was given:
///
///   Staff hear three things: you've reached work, you've checked out, and
///   today's total. They are never asked to confirm their own arrival.
///
///   Admins are asked to confirm an arrival, and asked to approve the day when
///   the person leaves. If nobody answers either, the times are still recorded
///   and the entry is marked unverified — nothing is ever dropped.
///
/// One consequence worth stating: a punch the PHONE made announces itself on
/// the phone, at once, and only once the plugin has said the row exists. So
/// the server does not push the same arrival a second time. The server speaks
/// to the employee only for punches the phone did not make — a manager's
/// manual entry, an NFC tag.

const PHONE_MADE = new Set(['geofence', 'banner', 'replay']);

/// How long a shift must have run before its end is worth a manager's phone.
/// A shift that opened and closed inside ten minutes is a mis-tap or a test,
/// and four people being asked to approve it is noise, not oversight.
export const MIN_SHIFT_MINUTES = 10;

export function planFor({
  type,                 // 'check_in' | 'check_out'
  source = 'geofence',  // 'geofence' | 'banner' | 'replay' | 'manual' | 'nfc'
  who = 'Someone',
  at = '',              // the punch, on the workplace clock
  zone = '',
  worked = '0m',        // today's total, as text
  minutes = 0,          // today's total, as a number
  firstIn = '',         // when the shift opened, on the workplace clock
  shiftMinutes = null,  // how long the shift that just ended had run
  pending = false,      // check-in: did the record ask for confirmation?
  unconfirmed = false,  // check-out: was the check-in never confirmed?
  unverified = false,   // the location could not be confirmed
  managerNotify = 'exceptions',
  employeeRef = '',
  eventId = '',
  day = '',
}) {
  const out = [];
  const where = zone ? ` at ${zone}` : '';
  const isIn = type === 'check_in';

  // ── the employee ────────────────────────────────────────────────────────
  if (!PHONE_MADE.has(String(source))) {
    out.push(isIn
      ? {
          to: 'employee', kind: 'attendance_check_in',
          title: zone ? `You've reached ${zone}` : "You've reached work",
          body: `Checked in at ${at}. Your hours are being recorded.`,
          data: { punch: type, at, zone, minutes: String(minutes) },
        }
      : {
          to: 'employee', kind: 'attendance_check_out',
          title: zone ? `You've checked out of ${zone}` : "You've checked out",
          body: `${worked} today.`,
          data: { punch: type, at, zone, minutes: String(minutes) },
        });
  }

  if (managerNotify === 'off') return out;

  // ── managers, on arrival ────────────────────────────────────────────────
  if (isIn) {
    if (pending) {
      out.push({
        to: 'managers', kind: 'attendance_confirm',
        title: `Is ${who} here?`,
        body: `Checked in at ${at}${where}. Confirm it in Attendance — the clock is already running.`,
        data: { eventId: String(eventId || ''), employeeRef: String(employeeRef), at },
      });
    } else if (managerNotify === 'all' || unverified) {
      out.push({
        to: 'managers', kind: 'attendance_manager',
        title: unverified ? `${who} — unconfirmed check-in` : `${who} checked in at ${at}`,
        body: unverified
          ? `Recorded at ${at}${where}, but the location could not be confirmed.`
          : `Arrived${where}.`,
        data: { punch: type, employeeRef: String(employeeRef), at, unverified: String(Boolean(unverified)) },
      });
    }
    return out;
  }

  // ── managers, on departure: approve the day ─────────────────────────────
  if (shiftMinutes != null && shiftMinutes < MIN_SHIFT_MINUTES) return out;
  const needsALook = unconfirmed || unverified;
  const reason = unconfirmed
    ? 'Nobody confirmed they were there.'
    : unverified ? 'The location could not be confirmed.' : '';
  out.push({
    to: 'managers', kind: 'attendance_day_review',
    title: needsALook ? `${who} clocked ${worked} — needs a look` : `${who} clocked ${worked} today`,
    body: [
      firstIn ? `In at ${firstIn}, out at ${at}${where}.` : `Checked out at ${at}${where}.`,
      reason,
      'Approve or reject the day in Attendance.',
    ].filter(Boolean).join(' '),
    data: {
      employeeRef: String(employeeRef), minutes: String(minutes), at,
      // The Approve button on this notification signs off a DAY, so the day
      // has to travel with it.
      day: String(day || ''),
      unverified: String(Boolean(needsALook)),
    },
  });
  return out;
}
