/// The simplified model: what counts, which day it belongs to, and what a
/// manager is asked to fix. Real cases from the logs wherever there is one.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { verifyOut, assignShiftDays, correctionProblem, dayFlags, localDay } from '../src/db.js';

const LA = 'America/Los_Angeles';
const H = 60 * 60 * 1000;

describe('a walk-out is verified by the crossing, not the distance', () => {
  const far = { distanceM: 418, radiusM: 58, accuracyM: 5, zoneName: 'Chups Anaheim' };

  test("Jeeva's 5:17 PM departure, 418 m out, is verified", () => {
    assert.equal(verifyOut(far, { type: 'check_out', source: 'geofence' }).state, 'verified');
  });

  test('a queued departure the phone replayed counts the same', () => {
    assert.equal(verifyOut(far, { type: 'check_out', source: 'replay' }).state, 'verified');
  });

  test('an arrival that far out is still outside', () => {
    assert.equal(verifyOut(far, { type: 'check_in', source: 'geofence' }).state, 'outside');
  });

  test('a check-out tapped by hand is still judged by where it was tapped', () => {
    assert.equal(verifyOut(far, { type: 'check_out', source: 'banner' }).state, 'outside');
  });

  test('no punch details keeps the old behaviour', () => {
    assert.equal(verifyOut(far).state, 'outside');
    assert.equal(verifyOut(null).state, 'unverified');
  });
});

describe('a shift belongs to the day it started', () => {
  const ev = (id, type, iso, extra = {}) => ({ id, type, at: iso, for_work: true, ...extra });

  test('10 PM to 2 AM is one day, not two', () => {
    // 22:00 PDT on 15 Sep is 05:00Z on 16 Sep; 02:00 PDT is 09:00Z.
    const days = assignShiftDays([
      ev('a', 'check_in', '2026-09-16T05:00:00Z'),
      ev('b', 'check_out', '2026-09-16T09:00:00Z'),
    ], LA).map((e) => e.shiftDay);
    assert.deepEqual(days, ['2026-09-15', '2026-09-15']);
  });

  test('a check-out that never came does not drag the next day back', () => {
    // In at 9 AM on the 14th, nothing until a departure 26 hours later.
    const days = assignShiftDays([
      ev('a', 'check_in', '2026-09-14T16:00:00Z'),
      ev('b', 'check_out', '2026-09-15T18:00:00Z'),
    ], LA).map((e) => e.shiftDay);
    assert.deepEqual(days, ['2026-09-14', '2026-09-15']);
  });

  test('two shifts in a day stay on that day', () => {
    const days = assignShiftDays([
      ev('a', 'check_in', '2026-09-15T16:26:00Z'), ev('b', 'check_out', '2026-09-15T17:51:00Z'),
      ev('c', 'check_in', '2026-09-15T22:33:00Z'), ev('d', 'check_out', '2026-09-16T00:17:00Z'),
    ], LA).map((e) => e.shiftDay);
    assert.deepEqual(days, ['2026-09-15', '2026-09-15', '2026-09-15', '2026-09-15']);
  });

  test('"not for work" closes the stretch on its own day', () => {
    const days = assignShiftDays([
      ev('a', 'check_in', '2026-09-16T05:00:00Z'),
      ev('b', 'check_in', '2026-09-16T08:00:00Z', { for_work: false }),
    ], LA).map((e) => e.shiftDay);
    assert.deepEqual(days, ['2026-09-15', '2026-09-15']);
  });

  test("local day follows the restaurant's clock", () => {
    assert.equal(localDay('2026-09-16T06:59:00Z', LA), '2026-09-15');
    assert.equal(localDay('2026-09-16T07:00:00Z', LA), '2026-09-16');
  });
});

describe("a manager's fix is checked before it is saved", () => {
  const day = '2026-09-15';
  test("Jeeva's real 15 Sep is accepted", () => {
    assert.equal(correctionProblem({ day, firstIn: '2026-09-15T16:26:00Z', lastOut: '2026-09-15T22:25:00Z', tz: LA }), null);
  });
  test('out before in is refused', () => {
    assert.match(correctionProblem({ day, firstIn: '2026-09-15T22:00:00Z', lastOut: '2026-09-15T16:00:00Z', tz: LA }), /after the check-in/);
  });
  test('more than 16 hours is refused', () => {
    assert.match(correctionProblem({ day, firstIn: '2026-09-15T14:00:00Z', lastOut: '2026-09-16T07:00:00Z', tz: LA }), /16 hours/);
  });
  test('a check-in on another day is refused', () => {
    assert.match(correctionProblem({ day, firstIn: '2026-09-16T16:00:00Z', lastOut: '2026-09-16T20:00:00Z', tz: LA }), /on the day/);
  });
  test('a missing time is refused', () => {
    assert.match(correctionProblem({ day, firstIn: '', lastOut: '2026-09-15T20:00:00Z', tz: LA }), /Both times/);
  });
  test('an overnight fix ending the next morning is fine', () => {
    assert.equal(correctionProblem({ day, firstIn: '2026-09-16T05:00:00Z', lastOut: '2026-09-16T09:00:00Z', tz: LA }), null);
  });
});

describe('what a manager is asked to fix', () => {
  const NOW = Date.parse('2026-09-16T17:00:00Z');
  const row = (extra) => ({
    first_in: '2026-09-15T16:26:00Z', last_out: '2026-09-16T00:17:00Z', total_minutes: 189,
    trailing_in_at: null, corrected_by: null, hand_outs: null, ...extra,
  });

  test('a clean day needs nothing', () => {
    const f = dayFlags(row({}), { now: NOW });
    assert.deepEqual(f.flags, []);
    assert.equal(f.needsFix, false);
    assert.equal(f.open, false);
  });

  test("Jeeva's real 15 Sep: out by hand at 10:51, phone left at 3:25, back at 3:33, out at 5:17", () => {
    // The day's LAST check-out is an ordinary walk-out. The hole is in the middle.
    const f = dayFlags(row({
      hand_outs: [{ out: '2026-09-15T17:51:00Z', left: '2026-09-15T22:25:00Z' }],
    }), { now: NOW });
    assert.deepEqual(f.flags, ['left_later']);
    assert.equal(f.needsFix, true);
    assert.equal(f.leftZoneAt, '2026-09-15T22:25:00.000Z');
    assert.equal(f.handOuts[0].checkedOutAt, '2026-09-15T17:51:00.000Z');
  });

  test('a phone leaving a few minutes after a hand check-out is not worth a flag', () => {
    const f = dayFlags(row({ hand_outs: [{ out: '2026-09-15T22:20:00Z', left: '2026-09-15T22:25:00Z' }] }), { now: NOW });
    assert.equal(f.needsFix, false);
  });

  test('a shift still inside the same-shift window is open, not missing', () => {
    const f = dayFlags(row({ last_out: null, trailing_in_at: '2026-09-16T16:26:00Z' }), { now: NOW });
    assert.equal(f.open, true);
    assert.equal(f.needsFix, false);
  });

  test('past the window it is a check-out that never came', () => {
    const f = dayFlags(row({ last_out: null, trailing_in_at: '2026-09-15T16:26:00Z' }), { now: NOW });
    assert.equal(f.open, false);
    assert.deepEqual(f.flags, ['no_check_out']);
  });

  test('a departure with no arrival', () => {
    assert.deepEqual(dayFlags(row({ first_in: null }), { now: NOW }).flags, ['no_check_in']);
  });

  test('longer than any real shift', () => {
    assert.deepEqual(dayFlags(row({ total_minutes: 13 * 60 }), { now: NOW }).flags, ['over_12h']);
  });

  test("a manager's fix resolves every flag and says it was changed", () => {
    const f = dayFlags(row({ first_in: null, total_minutes: 900, corrected_by: '36' }), { now: NOW });
    assert.deepEqual(f.flags, ['changed']);
    assert.equal(f.needsFix, false);
    assert.equal(f.corrected, true);
  });
});
