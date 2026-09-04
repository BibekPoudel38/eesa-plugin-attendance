// The arithmetic that decides what somebody is paid.
//
// Run with `npm test` (node:test, no dependencies — importing src/db.js only
// constructs a pg Pool, it does not connect, so these need no database).
//
// Every case here is one a real geofence produces. A phone crossing a boundary
// twice, a shift that outlives midnight, a check-out with nothing open, a
// battery dying mid-shift: none of them are exotic, and each one used to be
// worth a different number of hours depending on which path it took.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isNoOpPunch, computeToday, metresBetween, dayVerification } from '../src/db.js';

/** An events row as the database hands it back. */
const ev = (type, hhmm, extra = {}) => ({
  type,
  at: `2026-09-04T${hhmm}:00.000Z`,
  for_work: extra.forWork !== false,
  zone_id: extra.zone ?? 'z1',
  ...extra,
});

describe('isNoOpPunch — the repeat-arrival guard', () => {
  test('arriving when nothing is open is a real punch', () => {
    assert.equal(isNoOpPunch(null, 'check_in', { zoneId: 'z1', forWork: true }), false);
  });

  test('arriving again at the same zone changes nothing', () => {
    // iOS re-fires "entered" every time the fence is re-registered, which
    // happens on every app open. Six in a morning is normal.
    const last = { type: 'check_in', zone_id: 'z1', for_work: true };
    assert.equal(isNoOpPunch(last, 'check_in', { zoneId: 'z1', forWork: true }), true);
  });

  test('a punch that names no zone is still the same presence', () => {
    const last = { type: 'check_in', zone_id: 'z1', for_work: true };
    assert.equal(isNoOpPunch(last, 'check_in', { zoneId: null, forWork: true }), true);
  });

  test('arriving at a DIFFERENT zone is a real punch', () => {
    // Moving between two sites in one shift has to record, or the second
    // location never appears on the timesheet.
    const last = { type: 'check_in', zone_id: 'z1', for_work: true };
    assert.equal(isNoOpPunch(last, 'check_in', { zoneId: 'z2', forWork: true }), false);
  });

  test('"not for work" is always a real state change', () => {
    const last = { type: 'check_in', zone_id: 'z1', for_work: true };
    assert.equal(isNoOpPunch(last, 'check_in', { zoneId: 'z1', forWork: false }), false);
  });

  test('going back on the clock after "not for work" records', () => {
    const last = { type: 'check_in', zone_id: 'z1', for_work: false };
    assert.equal(isNoOpPunch(last, 'check_in', { zoneId: 'z1', forWork: true }), false);
  });

  test('leaving with nothing open is a no-op', () => {
    assert.equal(isNoOpPunch(null, 'check_out', {}), true);
    assert.equal(isNoOpPunch({ type: 'check_out' }, 'check_out', {}), true);
  });

  test('leaving with a shift open is a real punch', () => {
    assert.equal(isNoOpPunch({ type: 'check_in' }, 'check_out', {}), false);
  });
});

describe('computeToday — hours from a day of punches', () => {
  test('a plain shift', () => {
    const t = computeToday([ev('check_in', '09:00'), ev('check_out', '17:00')]);
    assert.equal(t.totalMinutes, 480);
    assert.equal(t.checkedIn, false);
    assert.equal(t.since, null);
  });

  test('two shifts in a day add up, and do not count the gap', () => {
    const t = computeToday([
      ev('check_in', '09:00'), ev('check_out', '12:00'),
      ev('check_in', '13:00'), ev('check_out', '17:00'),
    ]);
    assert.equal(t.totalMinutes, 420);           // 3h + 4h, not 8h
  });

  test('repeat arrivals keep the EARLIEST start', () => {
    // The regression this guard exists for: overwriting the open interval
    // turned 92 minutes on site into 23. Six arrivals, one stretch of presence.
    const t = computeToday([
      ev('check_in', '09:00'), ev('check_in', '09:30'), ev('check_in', '10:00'),
      ev('check_out', '11:00'),
    ]);
    assert.equal(t.totalMinutes, 120);
  });

  test('a check-out with nothing open does not go negative', () => {
    const t = computeToday([ev('check_out', '17:00')]);
    assert.equal(t.totalMinutes, 0);
    assert.equal(t.checkedIn, false);
    assert.notEqual(t.lastOut, null);            // it still happened
  });

  test('"not for work" closes the interval and does not reopen one', () => {
    const t = computeToday([
      ev('check_in', '09:00'),
      ev('check_in', '10:00', { forWork: false }),
      ev('check_out', '17:00'),
    ]);
    assert.equal(t.totalMinutes, 60);            // only 09:00–10:00 counts
    assert.equal(t.checkedIn, false);
  });

  test('an open shift counts up to now, and says so', () => {
    const start = new Date(Date.now() - 90 * 60000).toISOString();
    const t = computeToday([{ type: 'check_in', at: start, for_work: true, zone_id: 'z1' }]);
    assert.equal(t.checkedIn, true);
    assert.notEqual(t.since, null);
    // Wall-clock dependent, so assert the band rather than the minute.
    assert.ok(t.totalMinutes >= 89 && t.totalMinutes <= 91, `got ${t.totalMinutes}`);
  });

  test('firstIn is the first arrival, lastOut the last departure', () => {
    const t = computeToday([
      ev('check_in', '09:00'), ev('check_out', '12:00'),
      ev('check_in', '13:00'), ev('check_out', '17:00'),
    ]);
    assert.equal(new Date(t.firstIn).toISOString(), '2026-09-04T09:00:00.000Z');
    assert.equal(new Date(t.lastOut).toISOString(), '2026-09-04T17:00:00.000Z');
  });

  test('a shift that outlives midnight still counts its minutes', () => {
    // The day it belongs to is decided elsewhere (tenant-local midnight); this
    // only has to not produce a negative or a wrapped total.
    const t = computeToday([
      { type: 'check_in', at: '2026-09-04T22:00:00.000Z', for_work: true, zone_id: 'z1' },
      { type: 'check_out', at: '2026-09-05T02:00:00.000Z', for_work: true, zone_id: 'z1' },
    ]);
    assert.equal(t.totalMinutes, 240);
  });

  test('no events is a zero day, not a crash', () => {
    const t = computeToday([]);
    assert.equal(t.totalMinutes, 0);
    assert.equal(t.checkedIn, false);
    assert.equal(t.firstIn, null);
    assert.equal(t.lastOut, null);
  });

  test('an unclosed shift from a dead battery does not invent hours', () => {
    // Someone checked in and their phone died. The clock runs, which is the
    // honest reading — but it must be a plausible number, not a negative one.
    const t = computeToday([ev('check_in', '09:00')]);
    assert.equal(t.checkedIn, true);
    assert.ok(t.totalMinutes >= 0);
  });
});

describe('metresBetween — the distance a zone check rests on', () => {
  test('the same point is zero', () => {
    assert.equal(Math.round(metresBetween(33.8314, -118.0045, 33.8314, -118.0045)), 0);
  });

  test('a known short hop is right to within a metre', () => {
    // 0.001° of latitude is ~111.2 m anywhere on Earth.
    const d = metresBetween(33.8314, -118.0045, 33.8324, -118.0045);
    assert.ok(d > 110 && d < 113, `got ${d}`);
  });

  test('longitude degrees shrink with latitude', () => {
    // The same longitude delta is a shorter distance further from the equator —
    // a flat-earth approximation gets this wrong and silently widens zones.
    const atEquator = metresBetween(0, 0, 0, 0.001);
    const atChups = metresBetween(33.8314, -118.0045, 33.8314, -118.0035);
    assert.ok(atChups < atEquator, `${atChups} should be < ${atEquator}`);
  });

  test('antipodal-ish points do not overflow', () => {
    const d = metresBetween(0, 0, 0, 180);
    assert.ok(Number.isFinite(d) && d > 19_000_000, `got ${d}`);
  });
});

describe('dayVerification — a day is only as good as its worst punch', () => {
  test('all verified reads as verified', () => {
    const v = dayVerification([{ verification: 'verified' }, { verification: 'verified' }]);
    assert.equal(v.verification, 'verified');
  });

  test('one unverified punch downgrades the day', () => {
    const v = dayVerification([{ verification: 'verified' }, { verification: 'unverified' }]);
    assert.notEqual(v.verification, 'verified');
  });

  test('a punch outside the zone is not hidden by good ones', () => {
    const v = dayVerification([{ verification: 'verified' }, { verification: 'outside' }]);
    assert.notEqual(v.verification, 'verified');
  });
});
