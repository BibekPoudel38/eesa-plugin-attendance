// The 7 Sep punch storm: six punches in four seconds, alternating in/out,
// because one stale fix 32.4 km away kept being replayed between good ones.
//
// The no-op guard could not see it — no punch repeated the state of the one
// before it, so every one was legitimate in isolation. Only the geography
// gives it away.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { implausibleMove } from '../src/db.js';

const CHUPS = { lat: 33.83165, lng: -118.00477 };
const STALE = { lat: 33.95061, lng: -117.68427 }; // 32.4 km away
const secondsAgo = (n) => new Date(Date.now() - n * 1000).toISOString();

describe('implausibleMove', () => {
  test('rejects the fix that caused the storm', () => {
    const jump = implausibleMove(
      { ...CHUPS, accuracy_m: 20, at: secondsAgo(1) },
      { ...STALE, accuracyM: 14 },
    );
    assert.ok(jump, 'a 32 km jump in one second must be refused');
    assert.ok(jump.movedM > 32000);
    assert.ok(jump.kmh > 10000, `implied ${jump.kmh} km/h`);
  });

  test('lets a real commute through', () => {
    // Chups to the same far point, but an hour later: 32 km/h. Ordinary.
    assert.equal(
      implausibleMove(
        { ...CHUPS, accuracy_m: 20, at: secondsAgo(3600) },
        { ...STALE, accuracyM: 14 },
      ),
      null,
    );
  });

  test('two fuzzy fixes at the edge of a zone never trip it', () => {
    // 60 m apart in one second is 216 km/h on its own — but both fixes admit
    // to ±40 m, and the allowance adds them. Blocking this would refuse real
    // punches from anyone standing near a zone boundary.
    assert.equal(
      implausibleMove(
        { lat: 33.83165, lng: -118.00477, accuracy_m: 40, at: secondsAgo(1) },
        { lat: 33.83219, lng: -118.00477, accuracyM: 40 },
      ),
      null,
    );
  });

  test('cannot be asked without both fixes, and says so', () => {
    assert.equal(implausibleMove(null, { ...STALE, accuracyM: 14 }), null);
    assert.equal(
      implausibleMove({ lat: null, lng: null, at: secondsAgo(1) }, { ...STALE, accuracyM: 14 }),
      null,
    );
    assert.equal(
      implausibleMove({ ...CHUPS, accuracy_m: 20, at: secondsAgo(1) }, { lat: null, lng: null }),
      null,
    );
  });

  test('a punch is never lost to a maths error', () => {
    // Same instant, so elapsed is 0 and the speed is infinite. A punch must
    // not be refused because the question could not be asked.
    assert.equal(
      implausibleMove({ ...CHUPS, accuracy_m: 20, at: new Date().toISOString() }, { ...STALE, accuracyM: 14 }),
      null,
    );
    assert.equal(implausibleMove({ at: 'not a date', ...CHUPS }, { ...STALE }), null);
  });
});
