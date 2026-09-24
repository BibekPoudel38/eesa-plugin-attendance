/// A punch that could not be sent when it happened.
///
/// Jeeva's week is the specification. Sep 8 read "0 min worked today" for a day
/// he worked: the morning arrival was refused because the session had expired,
/// the phone dropped it, and the departure that evening closed nothing. Sep 9
/// lost 3h44m the same way. The phone keeps those punches and sends them when it
/// can — which only helps if the server files them at the time they HAPPENED,
/// not the moment they finally got through.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { punchTime } from '../src/db.js';

const NOW = Date.parse('2026-09-11T21:00:00Z');
const minutes = (n) => n * 60 * 1000;
const hours = (n) => n * 60 * minutes(1);
const days = (n) => n * 24 * hours(1);
const iso = (ms) => new Date(ms).toISOString();

test('a punch from four hours ago is filed four hours ago', () => {
  const when = NOW - hours(4);
  assert.deepEqual(punchTime({ clientAt: when, sentAt: NOW }, NOW), { at: iso(when), skewMs: 0 });
});

test('no clientAt means now — an ordinary live punch is untouched', () => {
  for (const none of [null, undefined, '', 0]) {
    assert.equal(punchTime({ clientAt: none }, NOW).at, null);
  }
});

test('a Friday departure kept on the phone over a weekend outage is Friday\'s', () => {
  // It used to be filed at the moment it arrived once it was two days old: a
  // shift that "ran" from Friday until Monday morning.
  const friday = NOW - days(3);
  assert.equal(punchTime({ clientAt: friday, sentAt: NOW }, NOW).at, iso(friday));
});

test('a phone whose clock is wrong still files the right time', () => {
  // Ten minutes fast: the punch says 10 min later than it happened, and the
  // phone's clock says so too as it sends.
  const truly = NOW - hours(2);
  const fast = punchTime({ clientAt: truly + minutes(10), sentAt: NOW + minutes(10) }, NOW);
  assert.deepEqual(fast, { at: iso(truly), skewMs: -minutes(10) });
  const slow = punchTime({ clientAt: truly - hours(1), sentAt: NOW - hours(1) }, NOW);
  assert.deepEqual(slow, { at: iso(truly), skewMs: hours(1) });
});

test('seconds of difference are the network, not the clock', () => {
  const when = NOW - hours(1);
  assert.deepEqual(punchTime({ clientAt: when, sentAt: NOW - 20 * 1000 }, NOW), { at: iso(when), skewMs: 0 });
});

test('nothing is filed after now', () => {
  assert.equal(punchTime({ clientAt: NOW + hours(2) }, NOW).at, iso(NOW));
  assert.equal(punchTime({ clientAt: NOW + 20 * 1000 }, NOW).at, iso(NOW));
});

test('older than a week is refused and said so, never moved to today', () => {
  assert.equal(punchTime({ clientAt: NOW - days(8), sentAt: NOW }, NOW).error, 'PUNCH_TOO_OLD');
  assert.equal(punchTime({ clientAt: NOW - days(7) + minutes(1) }, NOW).at, iso(NOW - days(7) + minutes(1)));
  assert.equal(punchTime({ clientAt: NOW - days(7) - minutes(1) }, NOW).error, 'PUNCH_TOO_OLD');
});

test('a clock set back cannot make a punch look older than a week', () => {
  // The phone's clock reads a week behind; the punch happened an hour ago.
  const r = punchTime({ clientAt: NOW - hours(1) - days(8), sentAt: NOW - days(8) }, NOW);
  assert.equal(r.at, iso(NOW - hours(1)));
});

test('rubbish is ignored rather than thrown', () => {
  for (const bad of ['tomorrow', NaN, {}, [], -5, Infinity]) {
    assert.equal(punchTime({ clientAt: bad }, NOW).at, null);
  }
  assert.equal(punchTime({ clientAt: NOW - hours(1), sentAt: 'garbage' }, NOW).at, iso(NOW - hours(1)));
});

// The clock trick: offline, the clock set five hours ahead, the departure at
// 12:00 written as "17:00", the clock put back, sent at 17:05. clientAt is
// wrong and sentAt is right, so no skew shows. The phone's stopwatch knows the
// punch is 5h05m old.
test('a clock moved offline and put back cannot move a punch: the stopwatch places it', () => {
  const left = NOW - hours(5) - minutes(5);
  const r = punchTime({ clientAt: left + hours(5), sentAt: NOW, ageMs: hours(5) + minutes(5) }, NOW);
  assert.equal(r.at, iso(left));
});

test('without the stopwatch the old rule still stands', () => {
  const when = NOW - hours(4);
  assert.equal(punchTime({ clientAt: when, sentAt: NOW, ageMs: null }, NOW).at, iso(when));
  assert.equal(punchTime({ clientAt: when, sentAt: NOW, ageMs: '' }, NOW).at, iso(when));
});

test('a stopwatch reading that makes no sense is not trusted', () => {
  const when = NOW - hours(4);
  for (const bad of [-1, 'soon', NaN, Infinity]) {
    assert.equal(punchTime({ clientAt: when, sentAt: NOW, ageMs: bad }, NOW).at, iso(when), String(bad));
  }
});

test('a punch older than a week by the stopwatch is refused, as by the clock', () => {
  assert.equal(punchTime({ clientAt: NOW, sentAt: NOW, ageMs: days(8) }, NOW).error, 'PUNCH_TOO_OLD');
});
