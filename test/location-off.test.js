/// Location off while on the clock: somebody turns Location off at work, goes
/// out, comes back and turns it on. The phone crossed nothing, so the day reads
/// as one unbroken shift unless the phone says it could not see. These are the
/// rules for what a manager is then shown — never a cut in the hours.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { computeToday, locationOffWindows, dayFlags, correctionProblem } from '../src/db.js';
import { rollUp, locationOffLine, dailySummary } from '../src/summary_plan.js';
import { runDue } from '../src/summaries.js';

// Tue 22 Sep 2026 in Anaheim is UTC-7, so 9:00 AM there is 16:00Z.
const at = (hhmm) => `2026-09-22T${hhmm}:00Z`;
const punch = (type, hhmm, extra = {}) => ({ type, at: at(hhmm), ...extra });
const off = (hhmm, extra = {}) => ({ state: 'off', at: at(hhmm), reason: 'services_off', ...extra });
const on = (hhmm) => ({ state: 'on', at: at(hhmm) });
const shift = (events, now = at('23:59')) => computeToday(events, { now: Date.parse(now) }).intervals;
const NOW = Date.parse(at('23:59'));
const instant = (hhmm) => new Date(at(hhmm)).toISOString();

describe('the stretches that are paid', () => {
  test('a day in and out is one stretch', () => {
    const got = shift([punch('check_in', '16:00'), punch('check_out', '23:00')]);
    assert.deepEqual(got.map((i) => [i.from.toISOString(), i.to.toISOString()]), [[instant('16:00'), instant('23:00')]]);
  });

  test('a shift still running runs to now', () => {
    const got = shift([punch('check_in', '16:00')], at('19:30'));
    assert.equal(got.length, 1);
    assert.equal(got[0].to.toISOString(), new Date(at('19:30')).toISOString());
  });

  test('a four-minute visit is not paid, so it is not a stretch', () => {
    assert.deepEqual(shift([punch('check_in', '16:00'), punch('check_out', '16:04')]), []);
  });

  test('a trip out for work counts until they are back', () => {
    const got = shift([
      punch('check_in', '16:00'),
      punch('check_out', '18:00', { note: 'Outside work' }),
      punch('check_in', '19:00'),
      punch('check_out', '23:00'),
    ]);
    assert.equal(got.length, 1);
    assert.equal(got[0].from.toISOString(), new Date(at('16:00')).toISOString());
    assert.equal(got[0].to.toISOString(), new Date(at('23:00')).toISOString());
  });
});

describe('when location was off on the clock', () => {
  const day = shift([punch('check_in', '16:00'), punch('check_out', '23:00')]);

  test('off at 12, back at 1:30, is one stretch the phone could not see', () => {
    const [w, ...rest] = locationOffWindows([off('19:00'), on('20:30')], day, { now: NOW });
    assert.equal(rest.length, 0);
    assert.equal(w.from, new Date(at('19:00')).toISOString());
    assert.equal(w.to, new Date(at('20:30')).toISOString());
    assert.equal(w.minutes, 90);
    assert.equal(w.open, false);
    assert.equal(w.reason, 'services_off');
  });

  test('only the part on the clock counts', () => {
    const [w] = locationOffWindows([off('14:00'), on('17:00')], day, { now: NOW });
    assert.equal(w.from, new Date(at('16:00')).toISOString(), 'from the check-in, not from before it');
    assert.equal(w.minutes, 60);
  });

  test('off at home, after the shift, is nobody’s business', () => {
    assert.deepEqual(locationOffWindows([off('23:30'), on('23:50')], day, { now: NOW }), []);
  });

  test('never said it was back: off until the shift ended', () => {
    const [w] = locationOffWindows([off('21:00')], day, { now: NOW });
    assert.equal(w.to, new Date(at('23:00')).toISOString());
    assert.equal(w.open, false, 'the shift ended, so the stretch did too');
  });

  test('still off and still at work reads as "since"', () => {
    const now = Date.parse(at('22:00'));
    const running = shift([punch('check_in', '16:00')], at('22:00'));
    const [w] = locationOffWindows([off('21:00')], running, { now });
    assert.equal(w.open, true);
    assert.equal(w.to, new Date(now).toISOString());
  });

  test('a switch flicked off and straight back on is not a trip', () => {
    assert.deepEqual(locationOffWindows([off('19:00'), on('19:04')], day, { now: NOW }), []);
  });

  test('the first report of it being off is when it began; repeats do not move it', () => {
    const [w] = locationOffWindows([off('19:00'), off('19:40', { reason: 'denied' }), on('20:00')], day, { now: NOW });
    assert.equal(w.from, new Date(at('19:00')).toISOString());
    assert.equal(w.reason, 'services_off');
  });

  test('when it was last seen on says how early it may have started', () => {
    const [w] = locationOffWindows([off('19:00', { last_on_at: at('18:10') }), on('20:00')], day, { now: NOW });
    assert.equal(w.earliest, new Date(at('18:10')).toISOString());
    // ...but never before the shift, where it no longer matters.
    const [v] = locationOffWindows([off('19:00', { last_on_at: at('10:00') }), on('20:00')], day, { now: NOW });
    assert.equal(v.earliest, new Date(at('16:00')).toISOString());
  });

  test('an "on" with nothing off before it says nothing', () => {
    assert.deepEqual(locationOffWindows([on('19:00')], day, { now: NOW }), []);
  });
});

describe('what the manager is asked', () => {
  const window = { from: at('19:00'), to: at('20:30'), minutes: 90, reason: 'services_off' };

  test('a day with location off needs a look, and keeps the stretch to show', () => {
    const f = dayFlags({ first_in: at('16:00'), last_out: at('23:00'), total_minutes: 420, location_off: [window] });
    assert.deepEqual(f.flags, ['location_off']);
    assert.equal(f.needsFix, true);
    assert.deepEqual(f.locationOff, [window]);
  });

  test('once a manager fixes the day, that is the answer — the evidence stays', () => {
    const f = dayFlags({ first_in: at('16:00'), last_out: at('23:00'), corrected_by: '36', away_minutes: 90, location_off: [window] });
    assert.deepEqual(f.flags, ['changed']);
    assert.equal(f.needsFix, false);
    assert.equal(f.awayMinutes, 90);
    assert.deepEqual(f.locationOff, [window]);
  });

  test('time away is whole minutes, and shorter than the day', () => {
    const day = '2026-09-22';
    const base = { day, firstIn: at('16:00'), lastOut: at('23:00'), tz: 'America/Los_Angeles' };
    assert.equal(correctionProblem({ ...base, awayMinutes: 90 }), null);
    assert.match(correctionProblem({ ...base, awayMinutes: -5 }), /whole minutes/);
    assert.match(correctionProblem({ ...base, awayMinutes: 7.5 }), /whole minutes/);
    assert.match(correctionProblem({ ...base, awayMinutes: 420 }), /shorter than the day/);
  });
});

describe('the morning summary', () => {
  const day = (ref, name, minutes, windows = [], extra = {}) => ({
    employeeRef: ref, name, totalMinutes: minutes, open: false,
    flags: windows.length ? ['location_off'] : [], needsFix: windows.length > 0,
    locationOff: windows, ...extra,
  });
  const w = (minutes) => ({ minutes });

  test('names who had location off, and for how long', () => {
    const msg = dailySummary('2026-09-22', rollUp([day('39', 'Jeeva', 282, [w(65)]), day('41', 'Sami', 234)]));
    assert.equal(msg.body, '2 people · 8h 36m · 1 day needs a fix · Location off: Jeeva 1h 05m');
  });

  test('three names at most, longest first', () => {
    const line = locationOffLine(rollUp([
      day('1', 'A', 60, [w(10)]), day('2', 'B', 60, [w(40)]), day('3', 'C', 60, [w(20)]), day('4', 'D', 60, [w(30)]),
    ]).locationOff);
    assert.equal(line, 'Location off: B 40m, D 30m, C 20m and 1 more');
  });

  test('a day a manager already fixed is not raised again', () => {
    const fixed = day('39', 'Jeeva', 282, [w(65)], { flags: ['changed'], needsFix: false });
    assert.deepEqual(rollUp([fixed]).locationOff, []);
  });

  test('nobody with location off: the line is as it was', () => {
    assert.match(dailySummary('2026-09-22', rollUp([day('39', 'Jeeva', 282)])).body, /all look right$/);
  });

  test('the roster names people the plugin never enrolled', async () => {
    const sent = [];
    const store = {
      async tenantsWithSettings() { return [{ tenantId: 'chups', timezone: 'America/Los_Angeles' }]; },
      async listApprovals() { return [day('41', '', 234, [w(20)])]; },
      async claimSummary() { return true; },
    };
    await runDue(new Date('2026-09-23T16:00:30Z'), {
      managerAudience: async () => ['36'],
      names: async () => new Map([['41', 'Sami']]),
      store,
      notify: (tenantId, users, msg) => sent.push(msg),
    });
    assert.match(sent[0].body, /Location off: Sami 20m$/);
  });
});
