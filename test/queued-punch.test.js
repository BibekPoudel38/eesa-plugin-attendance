/// A punch that could not be sent when it happened.
///
/// Jeeva's week is the specification. Sep 8 read "0 min worked today" for a day
/// he worked: the morning arrival was refused because the session had expired,
/// the phone dropped it, and the departure that evening closed nothing. Sep 9
/// lost 3h44m the same way. The phone is being changed to queue those punches —
/// which only helps if the server files them at the time they HAPPENED, not the
/// moment the queue finally drained.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { punchedAt } from '../src/db.js';

const NOW = Date.parse('2026-09-11T21:00:00Z');
const minutes = (n) => n * 60 * 1000;
const hours = (n) => n * 60 * minutes(1);

test('a punch from four hours ago is filed four hours ago', () => {
  const when = NOW - hours(4);
  assert.equal(punchedAt(when, NOW), new Date(when).toISOString());
});

test('no clientAt means now — an ordinary live punch is untouched', () => {
  assert.equal(punchedAt(null, NOW), null);
  assert.equal(punchedAt(undefined, NOW), null);
  assert.equal(punchedAt('', NOW), null);
  assert.equal(punchedAt(0, NOW), null);
});

test('a handset clock cannot punch into the future', () => {
  assert.equal(punchedAt(NOW + hours(2), NOW), null);
});

test('small forward skew is tolerated, but never recorded ahead of now', () => {
  // Phones drift by seconds. Refusing those would drop good punches; trusting
  // them would file a shift that has not started.
  const skewed = NOW + 20 * 1000;
  assert.equal(punchedAt(skewed, NOW), new Date(NOW).toISOString());
});

test('a phone cannot rewrite last week', () => {
  assert.equal(punchedAt(NOW - hours(72), NOW), null);
});

test('the boundary holds on both sides', () => {
  assert.equal(punchedAt(NOW - hours(48) + minutes(1), NOW) === null, false);
  assert.equal(punchedAt(NOW - hours(48) - minutes(1), NOW), null);
});

test('rubbish is ignored rather than thrown', () => {
  for (const bad of ['tomorrow', NaN, {}, [], -5, Infinity]) {
    assert.equal(punchedAt(bad, NOW), null);
  }
});
