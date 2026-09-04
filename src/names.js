// Who a row is about, in words.
//
// The plugin's `memberships` table only has a row for somebody it has been told
// about, so anyone enrolled through Eesa alone comes back nameless and every
// screen falls through to their raw employee ref. A manager approving a
// timesheet was shown "36" — not a person they can recognise, let alone vouch
// for. The roster is the authority; this is what fills the gap it leaves.

/// Said instead of an id when nothing anywhere knows the name. A number reads
/// as data a manager is expected to recognise; this reads as what it is.
export const UNKNOWN_NAME = 'Unnamed member';

/// Build ref → name from a roster payload.
export function nameMapOf(roster) {
  return new Map(
    (Array.isArray(roster) ? roster : [])
      .map((u) => [String(u.id), String(u.name || u.email || '').trim()])
      .filter(([, n]) => n !== ''),
  );
}

/// Fill in the names the plugin's own table could not. A row that already has
/// one keeps it — the plugin's membership name is what an admin typed, and it
/// wins over anything derived.
export function withNames(rows, byRef) {
  return (rows || []).map((r) => {
    const own = String(r.name || '').trim();
    if (own) return r;
    return { ...r, name: byRef.get(String(r.employeeRef)) || UNKNOWN_NAME };
  });
}
