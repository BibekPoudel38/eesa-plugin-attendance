/// Who is an attendance admin and who is staff.
///
/// Decided in exactly one place: Eesa AI → Management → Attendance. Eesa puts
/// the answer on every token it issues to this plugin, from the website and the
/// app alike, as the `appRole` claim ('admin' | 'staff' | 'none'). Nothing the
/// plugin stores can change it — not a membership row, not a role saved here —
/// so the two places can never disagree about who sees the team's hours.
///
/// A token with no claim at all answers "no role": Eesa has stamped the claim on
/// every token since the attendance positions shipped.
export function appRoleOf(ctx) {
  const claim = String((ctx && ctx.appRole) || '').toLowerCase();
  if (claim === 'admin') return 'admin';
  if (claim === 'staff') return 'staff';
  return null;
}

/// The same answer in the page's older vocabulary.
export function uiRoleOf(ctx) {
  const r = appRoleOf(ctx);
  return r === 'admin' ? 'manager' : r === 'staff' ? 'staff' : null;
}
