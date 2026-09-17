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

/// What someone is told when a manager taps Nudge: the one change that lets
/// their phone record their hours, in the words of the screen they will open.
/// `device` is the roster's summary of their newest phone (null = none yet).
export function setupNudge(device) {
  const title = 'Your hours aren’t recording yet';
  switch (device ? device.code : 'no_phone') {
    case 'location':
      return { title, body: 'On your iPhone open Settings › Eesa AI › Location and choose Always. That’s all — your hours then record themselves.' };
    case 'location_services_off':
      return { title, body: 'On your iPhone open Settings › Privacy & Security › Location Services, turn it on, then set Eesa AI to Always.' };
    case 'not_seen':
      return { title, body: 'Open Eesa AI once so it can check your attendance setup.' };
    case 'attendance_off':
    case 'no_phone':
      return { title, body: 'Open Eesa AI › Settings › Attendance and turn it on.' };
    default:
      return { title, body: 'Open Eesa AI › Settings › Attendance and tap Check my setup.' };
  }
}
