/// Who is an attendance admin and who is staff is decided in Eesa AI →
/// Management → Attendance, and only there.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { appRoleOf, uiRoleOf, rosterRoleOf } from '../src/roles.js';

describe("roles come from Eesa's Management → Attendance and nowhere else", () => {
  test('an attendance admin in Eesa is an admin here', () => {
    assert.equal(appRoleOf({ appRole: 'admin' }), 'admin');
    assert.equal(uiRoleOf({ appRole: 'admin' }), 'manager');
  });

  test('staff in Eesa is staff here', () => {
    assert.equal(appRoleOf({ appRole: 'staff' }), 'staff');
    assert.equal(uiRoleOf({ appRole: 'STAFF' }), 'staff');
  });

  test("Eesa's none, or no claim at all, is no role — even for a workspace ADMIN", () => {
    // Being an admin of the Eesa workspace does not make anyone an attendance
    // admin; only Management → Attendance does.
    assert.equal(appRoleOf({ appRole: 'none', role: 'ADMIN' }), null);
    assert.equal(appRoleOf({ role: 'ADMIN' }), null);
    assert.equal(uiRoleOf({}), null);
  });

  test('nothing the plugin stores takes part', () => {
    // Anbu, 18 Sep 2026: an attendance admin in Eesa whose old membership row
    // here said "staff", and who was shown the staff page because of it.
    assert.equal(appRoleOf({ appRole: 'admin', member: { role: 'staff' } }), 'admin');
    assert.equal(appRoleOf.length, 1, 'decided from the token alone');
  });

  test("someone Eesa's roster lists as none is not enrolled", () => {
    // 18 Sep: "Not in 29" on the Today screen, of whom eleven had no
    // attendance at all. The roster says 'none'; passed on, that is a truthy
    // string and every "is enrolled?" check on the page said yes.
    assert.equal(rosterRoleOf({ attendanceRole: 'none' }), null);
    assert.equal(rosterRoleOf({ attendanceRole: 'Staff' }), 'staff');
    assert.equal(rosterRoleOf({ attendanceRole: 'admin' }), 'admin');
    assert.equal(rosterRoleOf({}), null);
  });
});
