// Who is told that somebody's location could not be confirmed.
//
// On 7 Sep an hourly employee was receiving those alerts for every colleague,
// because Eesa's ADMIN role and the attendance roster's role are different
// things and disagreed. Their colleagues' movements were none of their
// business.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

/// The rule itself, not a copy of it. It used to be restated here, which meant
/// the test could keep passing while server.js did something else.
import { audienceFor as audience } from '../src/db.js';

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

  test('a manager Eesa can no longer name is dropped', () => {
    // Ref 55 is the dormant Apple review account. It is marked 'manager' in
    // memberships and has not been an Eesa user for some time, so every punch
    // spent a notification on it and got a 404 back — five of them in the
    // fortnight this was found. A recipient nobody can address is not an
    // audience, it is a failing request on a loop.
    assert.equal(audience({ roster: ROSTER, staff: STAFF, managers: MANAGERS }).includes('55'), false);
  });

  test('a roster manager Eesa still knows is included', () => {
    const out = audience({
      roster: [{ id: 60, attendanceRole: 'staff' }],
      staff: [], managers: ['60'],
    });
    assert.ok(out.includes('60'));
  });

  test('nobody is told twice', () => {
    const out = audience({
      roster: [{ id: 55, attendanceRole: 'admin' }],
      staff: [], managers: ['55'],
    });
    assert.deepEqual(out, ['55']);
  });

  test('a Set of staff refs is accepted, as server.js passes one', () => {
    const out = audience({
      roster: [{ id: 39, attendanceRole: 'admin' }],
      staff: new Set(['39']), managers: [],
    });
    assert.deepEqual(out, []);
  });

  test('the whole audience, for this workspace', () => {
    // One person, where it used to be two. The second was ref 55, which every
    // punch notified and every notification 404'd on — the workspace's live
    // audience was one real recipient and one guaranteed failure.
    assert.deepEqual(
      audience({ roster: ROSTER, staff: STAFF, managers: MANAGERS }).sort(),
      ['36'],
    );
  });
});

/// The same rule, applied to what a person is allowed to DO and which screen
/// they are shown. server.js applies exactly this in withMember and /api/me.
function rosterDemotes(member) {
  return Boolean(member && member.active !== false && member.role === 'staff');
}

describe('the roster overrules Eesa downward, never upward', () => {
  test('an hourly employee who carries ADMIN in Eesa is staff here', () => {
    // Jeeva: role=ADMIN in Eesa core, role='staff' on the attendance roster,
    // $10/hr. Approving their own colleagues' hours and pay.
    assert.equal(rosterDemotes({ role: 'staff', active: true }), true);
  });

  test('an admin the roster has never heard of keeps everything', () => {
    // chupy@admin.com is not a member here at all. Demoting them would leave
    // this workspace with no attendance manager.
    assert.equal(rosterDemotes(null), false);
    assert.equal(rosterDemotes(undefined), false);
  });

  test('a roster manager is never demoted', () => {
    assert.equal(rosterDemotes({ role: 'manager', active: true }), false);
  });

  test('an inactive staff row does not demote anybody', () => {
    // A former employee who later became the administrator must not be held
    // down by the row they left behind.
    assert.equal(rosterDemotes({ role: 'staff', active: false }), false);
  });

  test('the roster never PROMOTES — that stays Eesa’s call', () => {
    // rosterDemotes only ever answers "should this admin be knocked down".
    // Nothing here can turn a staff member into a manager.
    assert.equal(rosterDemotes({ role: 'manager' }), false);
  });
});
