// Who is told that somebody's location could not be confirmed.
//
// On 7 Sep an hourly employee was receiving those alerts for every colleague,
// because Eesa's ADMIN role and the attendance roster's role are different
// things and disagreed. Their colleagues' movements were none of their
// business.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

/// The rule, lifted out so it can be tested without a database or an HTTP
/// round trip to the roster. server.js applies exactly this.
function audience({ roster, staff, managers }) {
  const admins = roster
    .filter((u) => String(u.attendanceRole || '').toLowerCase() === 'admin')
    .map((u) => String(u.id))
    .filter((id) => !new Set(staff).has(id));
  return [...new Set([...managers.map(String), ...admins])];
}

// The live workspace on the day this was found.
const ROSTER = [
  { id: 39, attendanceRole: 'admin' },  // Jeeva — but 'staff' on the roster
  { id: 36, attendanceRole: 'admin' },  // chupy@admin.com — not on the roster
  { id: 38, attendanceRole: 'staff' },  // Anbu
];
const STAFF = ['37', '38', '39', '49', '74'];
const MANAGERS = ['55'];

describe('managerAudience', () => {
  test('an hourly employee stops hearing about their colleagues', () => {
    assert.equal(audience({ roster: ROSTER, staff: STAFF, managers: MANAGERS }).includes('39'), false);
  });

  test('an admin who does not clock in still hears everything', () => {
    // Not on the attendance roster at all, so the roster has not spoken and
    // Eesa's word stands. Losing this recipient would silence the alerts
    // entirely on this workspace.
    assert.ok(audience({ roster: ROSTER, staff: STAFF, managers: MANAGERS }).includes('36'));
  });

  test('a roster manager is always included', () => {
    assert.ok(audience({ roster: ROSTER, staff: STAFF, managers: MANAGERS }).includes('55'));
  });

  test('nobody is told twice', () => {
    const out = audience({
      roster: [{ id: 55, attendanceRole: 'admin' }],
      staff: [], managers: ['55'],
    });
    assert.deepEqual(out, ['55']);
  });

  test('the whole audience, for this workspace', () => {
    assert.deepEqual(
      audience({ roster: ROSTER, staff: STAFF, managers: MANAGERS }).sort(),
      ['36', '55'],
    );
  });
});
