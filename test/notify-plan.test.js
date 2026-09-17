/// Who is told what when somebody punches — the simplified rule.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { planFor, setupNudge } from '../src/notify_plan.js';

const base = { at: '9:11 AM', zone: 'Chups Anaheim', worked: '5h 06m', minutes: 306 };

describe('what staff hear from the server', () => {
  test('nothing for a punch the phone made — the phone already said it', () => {
    for (const source of ['geofence', 'banner', 'replay']) {
      assert.deepEqual(planFor({ ...base, type: 'check_in', source }), [], source);
      assert.deepEqual(planFor({ ...base, type: 'check_out', source }), [], source);
    }
  });

  test('an arrival a manager entered by hand is told to them, in plain words', () => {
    const [msg] = planFor({ ...base, type: 'check_in', source: 'manual' });
    assert.equal(msg.to, 'employee');
    assert.equal(msg.title, "You've reached Chups Anaheim");
    assert.equal(msg.body, 'Checked in at 9:11 AM. Your hours are being recorded.');
  });

  test('a departure says the total, and nothing else', () => {
    const [msg] = planFor({ ...base, type: 'check_out', source: 'nfc' });
    assert.equal(msg.title, "You've checked out of Chups Anaheim");
    assert.equal(msg.body, '5h 06m today.');
  });

  test('nobody is ever asked a question', () => {
    for (const source of ['geofence', 'banner', 'manual', 'nfc', 'replay']) {
      for (const type of ['check_in', 'check_out']) {
        const plan = planFor({ ...base, type, source });
        assert.ok(!plan.some((i) => /confirm|approve|reject|here\?/i.test(i.title + i.body)), `${source} ${type}`);
      }
    }
  });
});

describe('what managers hear per punch', () => {
  test('nothing — they get a morning summary instead', () => {
    for (const source of ['geofence', 'banner', 'manual', 'nfc', 'replay']) {
      for (const type of ['check_in', 'check_out']) {
        assert.ok(!planFor({ ...base, type, source }).some((i) => i.to === 'managers'), `${source} ${type}`);
      }
    }
  });
});

describe('a nudge names the one thing to change', () => {
  test('location short of Always sends them to the iPhone setting', () => {
    const m = setupNudge({ ready: false, code: 'location', reason: 'Location is set to Never — it needs Always' });
    assert.match(m.body, /Settings › Eesa AI › Location/);
    assert.match(m.body, /Always/);
  });
  test('Location Services off is a different switch', () => {
    assert.match(setupNudge({ code: 'location_services_off' }).body, /Location Services/);
  });
  test('a phone that has not reported just needs Eesa opened', () => {
    assert.match(setupNudge({ code: 'not_seen' }).body, /Open Eesa AI once/);
  });
  test('attendance off, or no phone at all, is turned on in the app', () => {
    assert.match(setupNudge({ code: 'attendance_off' }).body, /Settings › Attendance and turn it on/);
    assert.match(setupNudge(null).body, /Settings › Attendance and turn it on/);
  });
  test('anything else runs the built-in check', () => {
    assert.match(setupNudge({ code: 'no_zones' }).body, /Check my setup/);
    assert.equal(setupNudge({ code: 'unreachable' }).title, 'Your hours aren’t recording yet');
  });
});
