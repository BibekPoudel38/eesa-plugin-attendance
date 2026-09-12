/// Being asked to confirm something, then scolded for not confirming it.
///
/// 9 Sep, the live workspace: a shift opened at 14:04:13 and closed at
/// 14:04:53. Five managers were asked "Is Jeeva here? Confirm it — the clock is
/// already running", and forty seconds later the same five, plus Jeeva, were
/// told nobody had confirmed he was there. Eleven notifications for forty
/// seconds of work, and the second batch blamed people for not answering a
/// question they had barely received.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { worthFlaggingUnconfirmed } from '../src/db.js';

const NOW = Date.parse('2026-09-09T21:04:53Z');
const minutesAgo = (n) => new Date(NOW - n * 60 * 1000).toISOString();

describe('whether the unconfirmed alert is worth sending', () => {
  test('the forty-second shift says nothing', () => {
    assert.equal(worthFlaggingUnconfirmed(new Date(NOW - 40 * 1000).toISOString(), NOW), false);
  });

  test('a shift nobody had a chance to confirm says nothing', () => {
    assert.equal(worthFlaggingUnconfirmed(minutesAgo(9), NOW), false);
  });

  test('a real shift still says so — this is the whole point of the alert', () => {
    assert.ok(worthFlaggingUnconfirmed(minutesAgo(11), NOW));
    assert.ok(worthFlaggingUnconfirmed(minutesAgo(60 * 5), NOW));
  });

  test('the boundary holds', () => {
    assert.ok(worthFlaggingUnconfirmed(minutesAgo(10), NOW));
    assert.equal(worthFlaggingUnconfirmed(minutesAgo(10 - 1 / 60), NOW), false);
  });

  test('an unreadable time is spoken, not swallowed', () => {
    // Silence has to be a decision, never an accident of parsing. If the
    // check-in time cannot be read the alert still goes — a false alarm is
    // recoverable, an unconfirmed shift nobody mentions is not.
    for (const bad of [null, undefined, '', 'yesterday']) {
      assert.ok(worthFlaggingUnconfirmed(bad, NOW));
    }
  });
});
