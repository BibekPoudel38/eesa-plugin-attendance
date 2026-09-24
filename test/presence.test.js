import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeEntry, entryDigest, presenceEvidence, metersOutside, STRONG_FLAGS,
} from '../src/presence.js';

// Chups Anaheim, 100 m, and a shift from 13:05 to 17:00.
const ZONE = { name: 'Chups Anaheim', lat: 33.8318, lng: -117.9955, radiusM: 100 };
const T0 = Date.parse('2026-09-23T20:05:00Z');
const MIN = 60 * 1000;
const SHIFT = [{ from: T0, to: T0 + 235 * MIN, zone: ZONE }];

/// A phone's log, chained the way the app chains it.
function chain(rows, deviceId = 'phone-1') {
  let prev = '';
  return rows.map((r, i) => {
    const e = normalizeEntry({ seq: i + 1, online: true, accuracyM: 8, lat: ZONE.lat, lng: ZONE.lng, ...r });
    e.prevHash = prev;
    e.hash = entryDigest(prev, e);
    prev = e.hash;
    // serverAt is the server's own placement from the upload, never the phone's word.
    return { ...e, deviceId, serverAt: r.serverAt ?? null };
  });
}

test('an honest afternoon on site says nothing', () => {
  const log = chain([
    { at: T0 + 1 * MIN, serverAt: T0 + 1 * MIN },
    { at: T0 + 31 * MIN, serverAt: T0 + 31 * MIN, elapsedMs: 30 * MIN },
    { at: T0 + 61 * MIN, elapsedMs: 30 * MIN },
  ]);
  assert.deepEqual(presenceEvidence(SHIFT, log), []);
});

test('a phone 1.4 km away while checked in is caught, with how far', () => {
  const log = chain([
    { at: T0 + 10 * MIN },
    { at: T0 + 40 * MIN, lat: 33.8444, lng: -117.9955 }, // ~1.4 km north
    { at: T0 + 55 * MIN, lat: 33.8450, lng: -117.9955 },
    { at: T0 + 90 * MIN },
  ]);
  const ev = presenceEvidence(SHIFT, log);
  assert.equal(ev.length, 1, JSON.stringify(ev));
  assert.equal(ev[0].flag, 'away');
  assert.equal(ev[0].at, T0 + 40 * MIN);
  assert.equal(ev[0].until, T0 + 55 * MIN, 'two readings away are one stretch');
  assert.ok(ev[0].meters > 1300 && ev[0].meters < 1500, String(ev[0].meters));
  assert.equal(ev[0].zone, 'Chups Anaheim');
});

test('a vague reading is not held against anyone', () => {
  const e = normalizeEntry({ seq: 1, at: T0, lat: 33.8444, lng: -117.9955, accuracyM: 400 });
  assert.equal(metersOutside(e, ZONE), null, 'a 400 m fix says nothing');
  const carPark = normalizeEntry({ seq: 1, at: T0, lat: 33.8328, lng: -117.9955, accuracyM: 10 });
  assert.equal(metersOutside(carPark, ZONE), null, 'just past the fence is not away');
});

test('airplane mode shows as an offline stretch, ending when it came back', () => {
  const log = chain([
    { at: T0 + 10 * MIN },
    { at: T0 + 20 * MIN, online: false },
    { at: T0 + 35 * MIN, online: false },
    { at: T0 + 50 * MIN, online: true },
  ]);
  const ev = presenceEvidence(SHIFT, log);
  assert.deepEqual(ev.map((x) => x.flag), ['offline']);
  assert.equal(ev[0].at, T0 + 20 * MIN);
  assert.equal(ev[0].until, T0 + 50 * MIN);
  assert.ok(!STRONG_FLAGS.has('offline'), 'offline alone is shown, not held against them');
});

test('offline AND away — the phone logged where it went while it could not send', () => {
  const log = chain([
    { at: T0 + 10 * MIN },
    { at: T0 + 30 * MIN, online: false, lat: 33.8600, lng: -117.9955 },
    { at: T0 + 60 * MIN, online: true },
  ]);
  const flags = presenceEvidence(SHIFT, log).map((x) => x.flag).sort();
  assert.deepEqual(flags, ['away', 'offline']);
});

test('a restart shows as the stretch between the entries either side of it', () => {
  const log = chain([
    { at: T0 + 10 * MIN },
    { at: T0 + 70 * MIN, restarted: true }, // the phone's stopwatch started again
  ]);
  const ev = presenceEvidence(SHIFT, log);
  assert.deepEqual(ev.map((x) => x.flag), ['restarted']);
  assert.equal(ev[0].at, T0 + 10 * MIN);
  assert.equal(ev[0].until, T0 + 70 * MIN);
  assert.ok(!STRONG_FLAGS.has('restarted'), 'phones die; shown, not held against anyone');
});

test('a clock moved by hand is caught by the stopwatch between entries', () => {
  const log = chain([
    { at: T0 + 10 * MIN },
    { at: T0 + 40 * MIN, elapsedMs: 1 * MIN }, // 30 min on the wall, 1 min really
  ]);
  const ev = presenceEvidence(SHIFT, log);
  assert.deepEqual(ev.map((x) => x.flag), ['clock_changed']);
  assert.equal(ev[0].byMs, 29 * MIN);
  assert.ok(STRONG_FLAGS.has('clock_changed'));
});

test('a clock moved in airplane mode and put back before going online is still caught', () => {
  // Offline at 13:25, the clock set five hours ahead, the departure written at
  // "18:45", the clock put back, then online. The upload said how long ago each
  // entry was written, which places them at 13:25, 13:45, 14:00 and 14:05.
  const log = chain([
    { at: T0 + 20 * MIN, serverAt: T0 + 20 * MIN, online: false },
    { at: T0 + 340 * MIN, serverAt: T0 + 40 * MIN, online: false, elapsedMs: 20 * MIN },
    { at: T0 + 355 * MIN, serverAt: T0 + 55 * MIN, online: false, elapsedMs: 15 * MIN },
    { at: T0 + 60 * MIN, serverAt: T0 + 60 * MIN, online: true, elapsedMs: 5 * MIN },
  ]);
  const ev = presenceEvidence(SHIFT, log);
  assert.deepEqual(ev.map((x) => x.flag), ['offline', 'clock_changed'], JSON.stringify(ev));
  const clock = ev[1];
  assert.equal(clock.at, T0 + 40 * MIN, 'placed where it happened, not where the phone said');
  assert.equal(clock.byMs, 300 * MIN, 'once, for the whole stretch it was wrong');
  assert.equal(ev[0].until, T0 + 60 * MIN);
});

test('a location iOS says was produced by software is flagged', () => {
  const ev = presenceEvidence(SHIFT, chain([{ at: T0 + 10 * MIN, simulated: true }]));
  assert.deepEqual(ev.map((x) => x.flag), ['simulated']);
});

test('an entry removed from the middle of the log is a break', () => {
  const log = chain([{ at: T0 + 10 * MIN }, { at: T0 + 20 * MIN }, { at: T0 + 30 * MIN }]);
  const ev = presenceEvidence(SHIFT, [log[0], log[2]]);
  assert.deepEqual(ev.map((x) => x.flag), ['log_gap']);
  assert.equal(ev[0].missing, 1);
});

test('an entry edited on the phone no longer matches its link', () => {
  const log = chain([{ at: T0 + 10 * MIN }, { at: T0 + 20 * MIN }, { at: T0 + 30 * MIN }]);
  log[1] = { ...log[1], lat: log[1].lat + 0.01 }; // moved it, kept the old hash
  const ev = presenceEvidence(SHIFT, log);
  assert.ok(ev.some((x) => x.flag === 'log_gap' && x.edited), JSON.stringify(ev));
});

test('nothing outside a shift is anybody\'s business', () => {
  const log = chain([
    { at: T0 - 120 * MIN, lat: 34.2, lng: -118.5, simulated: true, online: false },
    { at: T0 + 300 * MIN, lat: 34.2, lng: -118.5 },
  ]);
  assert.deepEqual(presenceEvidence(SHIFT, log), []);
});

test('junk is dropped, not guessed at', () => {
  assert.equal(normalizeEntry({ at: T0 }), null, 'no sequence number');
  assert.equal(normalizeEntry({ seq: 1 }), null, 'no time');
  assert.equal(normalizeEntry({ seq: 1, at: 9e15 }), null, 'no date at all');
  const e = normalizeEntry({ seq: 1, at: T0, lat: 200, lng: 5, accuracyM: 3 });
  assert.equal(e.lat, null, 'an impossible latitude is no fix at all');
  assert.equal(e.accuracyM, null, 'and has no accuracy to claim');
});

// "Still here?" every 20 minutes through the shift, answered or not.
const ASKED = Array.from({ length: 11 }, (_, i) => T0 + (20 + i * 20) * MIN); // 13:25 … 16:45
const answersTo = (asks, rows = {}) => chain(asks.map((c) => ({ at: c + MIN, ...rows[c] })));

test('every check answered: nothing to say', () => {
  assert.deepEqual(presenceEvidence(SHIFT, answersTo(ASKED), ASKED), []);
});

test('answering, an hour of silence, answering again: airplane mode or Location off, and it needs a look', () => {
  const quiet = ASKED.slice(3, 6); // 14:25, 14:45, 15:05
  const log = answersTo(ASKED.filter((c) => !quiet.includes(c)));
  const ev = presenceEvidence(SHIFT, log, ASKED);
  assert.deepEqual(ev.map((x) => x.flag), ['went_quiet'], JSON.stringify(ev));
  assert.equal(ev[0].at, quiet[0]);
  assert.equal(ev[0].missed, 3);
  assert.ok(STRONG_FLAGS.has('went_quiet'));
});

test('silence that ends in a restart is the phone switched off, said once', () => {
  const quiet = ASKED.slice(3, 7);
  const answered = ASKED.filter((c) => !quiet.includes(c));
  const back = answered.find((c) => c > quiet[quiet.length - 1]);
  const log = answersTo(answered, { [back]: { restarted: true } });
  const ev = presenceEvidence(SHIFT, log, ASKED);
  assert.deepEqual(ev.map((x) => x.flag), ['phone_off'], 'and no separate "restarted" for the same event');
  assert.equal(ev[0].missed, 4);
  assert.ok(STRONG_FLAGS.has('phone_off'));
});

test('a phone that never answers all shift is only shown: swiped away or refresh off', () => {
  const ev = presenceEvidence(SHIFT, [], ASKED);
  assert.deepEqual(ev.map((x) => x.flag), ['silent']);
  assert.ok(!STRONG_FLAGS.has('silent'));
});

test('two checks missed is not silence', () => {
  const log = answersTo(ASKED.filter((c) => c !== ASKED[3] && c !== ASKED[4]));
  assert.deepEqual(presenceEvidence(SHIFT, log, ASKED), []);
});

test('a push iOS held for ten minutes still counts as answered', () => {
  const log = chain(ASKED.map((c) => ({ at: c + 10 * MIN })));
  assert.deepEqual(presenceEvidence(SHIFT, log, ASKED), []);
});

