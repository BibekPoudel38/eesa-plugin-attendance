/// Who is told what when somebody punches — the rule, as it was given.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { planFor, MIN_SHIFT_MINUTES } from '../src/notify_plan.js';

const base = { who: 'Jeeva', at: '09:11', zone: 'Chups Anaheim', worked: '5h 06m', minutes: 306, firstIn: '09:11', employeeRef: '39', day: '2026-09-11' };
const kinds = (plan, to) => plan.filter((i) => i.to === to).map((i) => i.kind);

describe('what staff hear', () => {
  test('an arrival the phone made is not pushed a second time', () => {
    const plan = planFor({ ...base, type: 'check_in', source: 'geofence', pending: true });
    assert.deepEqual(kinds(plan, 'employee'), []);
  });

  test('an arrival a manager entered by hand IS told to them, in plain words', () => {
    const [msg] = planFor({ ...base, type: 'check_in', source: 'manual' }).filter((i) => i.to === 'employee');
    assert.equal(msg.title, "You've reached Chups Anaheim");
    assert.match(msg.body, /Checked in at 09:11/);
  });

  test('a departure says the total, and nothing else', () => {
    const [msg] = planFor({ ...base, type: 'check_out', source: 'nfc', at: '14:17' }).filter((i) => i.to === 'employee');
    assert.equal(msg.title, "You've checked out of Chups Anaheim");
    assert.equal(msg.body, '5h 06m today.');
  });

  test('staff are never asked to confirm their own arrival', () => {
    for (const source of ['geofence', 'banner', 'manual', 'nfc', 'replay']) {
      const plan = planFor({ ...base, type: 'check_in', source, pending: true });
      assert.ok(!plan.some((i) => i.to === 'employee' && /confirm|Is Jeeva/i.test(i.title + i.body)), source);
    }
  });

  test("staff are not told their day went unconfirmed — that is the manager's to answer", () => {
    const plan = planFor({ ...base, type: 'check_out', source: 'manual', unconfirmed: true, at: '14:17', shiftMinutes: 306 });
    const toStaff = plan.filter((i) => i.to === 'employee');
    assert.equal(toStaff.length, 1);
    assert.doesNotMatch(toStaff[0].title + toStaff[0].body, /unconfirmed|never confirmed/i);
  });
});

describe('what managers hear', () => {
  test('an arrival that asks for confirmation asks them', () => {
    const [msg] = planFor({ ...base, type: 'check_in', pending: true, eventId: 'e1' }).filter((i) => i.to === 'managers');
    assert.equal(msg.kind, 'attendance_confirm');
    assert.equal(msg.title, 'Is Jeeva here?');
    assert.equal(msg.data.eventId, 'e1');
  });

  test('a departure asks them to approve the day, with both times', () => {
    const [msg] = planFor({ ...base, type: 'check_out', at: '14:17', shiftMinutes: 306 }).filter((i) => i.to === 'managers');
    assert.equal(msg.kind, 'attendance_day_review');
    assert.equal(msg.title, 'Jeeva clocked 5h 06m today');
    assert.match(msg.body, /In at 09:11, out at 14:17 at Chups Anaheim/);
    assert.equal(msg.data.day, '2026-09-11');
  });

  test('a day nobody confirmed says so', () => {
    const [msg] = planFor({ ...base, type: 'check_out', at: '14:17', shiftMinutes: 306, unconfirmed: true }).filter((i) => i.to === 'managers');
    assert.match(msg.title, /needs a look/);
    assert.match(msg.body, /Nobody confirmed they were there/);
    assert.equal(msg.data.unverified, 'true');
  });

  test('the review names the arrival nobody vouched for, and keeps the day\'s first in', () => {
    // Confirmed 3:44 arrival, out at 4:25, back at 4:30 with nobody answering,
    // out at 4:42: the day is 3:44 → 4:42 and the question is about 4:30.
    const [msg] = planFor({
      ...base, type: 'check_out', firstIn: '3:44 AM', at: '4:42 AM',
      unconfirmed: true, arrivedAt: '4:30 AM', shiftMinutes: 12, worked: '53m',
    }).filter((m) => m.to === 'managers');
    assert.match(msg.body, /^In at 3:44 AM, out at 4:42 AM/);
    assert.match(msg.body, /Nobody confirmed the 4:30 AM arrival\./);
  });

  test('the forty-second shift wakes nobody', () => {
    const plan = planFor({ ...base, type: 'check_out', shiftMinutes: 1 });
    assert.deepEqual(kinds(plan, 'managers'), []);
    assert.ok(MIN_SHIFT_MINUTES >= 5);
  });

  test('a shift long enough to be real does', () => {
    const plan = planFor({ ...base, type: 'check_out', shiftMinutes: MIN_SHIFT_MINUTES });
    assert.deepEqual(kinds(plan, 'managers'), ['attendance_day_review']);
  });

  test("manager notifications 'off' means off — the employee is still told", () => {
    const plan = planFor({ ...base, type: 'check_out', source: 'manual', managerNotify: 'off', shiftMinutes: 300 });
    assert.deepEqual(kinds(plan, 'managers'), []);
    assert.equal(kinds(plan, 'employee').length, 1);
  });

  test("'exceptions' skips an ordinary arrival and keeps an unverified one", () => {
    assert.deepEqual(kinds(planFor({ ...base, type: 'check_in', managerNotify: 'exceptions' }), 'managers'), []);
    assert.deepEqual(kinds(planFor({ ...base, type: 'check_in', managerNotify: 'exceptions', unverified: true }), 'managers'), ['attendance_manager']);
  });
});
