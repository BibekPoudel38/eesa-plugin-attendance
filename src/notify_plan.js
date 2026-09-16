/// Who is told what when somebody punches — now, deliberately, almost nobody.
///
/// Pure, so it can be read in one place and tested without a database or a
/// phone. server.js only dispatches what this returns.
///
/// Staff hear two things about a shift: they've reached work, and they've
/// checked out with today's total. The phone says both itself the moment the
/// fence fires, so the server speaks only for punches the phone did NOT make —
/// a manager's entry by hand, an NFC tag.
///
/// Managers hear nothing per punch. Each arrival used to ask "Is X here?" and
/// each departure asked them to approve the day: about 18 pushes a day each at
/// ten staff, answered once in eight. They get one summary each morning and
/// one on Monday instead — see summary_plan.js.

const PHONE_MADE = new Set(['geofence', 'banner', 'replay']);

export function planFor({
  type,                 // 'check_in' | 'check_out'
  source = 'geofence',  // 'geofence' | 'banner' | 'replay' | 'manual' | 'nfc'
  at = '',              // the punch, on the workplace clock
  zone = '',
  worked = '0m',        // today's total, as text
  minutes = 0,          // today's total, as a number
}) {
  if (PHONE_MADE.has(String(source))) return [];
  if (type === 'check_in') {
    return [{
      to: 'employee', kind: 'attendance_check_in',
      title: zone ? `You've reached ${zone}` : "You've reached work",
      body: `Checked in at ${at}. Your hours are being recorded.`,
      data: { punch: type, at, zone, minutes: String(minutes) },
    }];
  }
  return [{
    to: 'employee', kind: 'attendance_check_out',
    title: zone ? `You've checked out of ${zone}` : "You've checked out",
    body: `${worked} today.`,
    data: { punch: type, at, zone, minutes: String(minutes) },
  }];
}
