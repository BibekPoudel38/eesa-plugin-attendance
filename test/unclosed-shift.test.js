// A shift that never gets a check-out.
//
// Six of them in thirty days on the live workspace. Each was recorded as
// whatever the clock said at the last punch to land that day, because
// day_summaries is only rewritten by a punch: 112 minutes for one, 0 for
// another, from the same defect. The admin timesheet pays the stored number.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { computeToday } from '../src/db.js';

const at = (iso) => ({ at: iso, type: 'check_in', for_work: true, zone_id: 'z1' });
const out = (iso) => ({ at: iso, type: 'check_out' });
const DAY = '2026-09-04T';

describe('an unfinished shift', () => {
  test('bills what it has run, not what it will run', () => {
    const t = computeToday([at(DAY + '15:00:00Z')], { now: Date.parse(DAY + '18:00:00Z') });
    assert.equal(t.totalMinutes, 180);
    assert.equal(t.unclosed, true);
    assert.equal(t.openTooLong, false);
  });

  test('is capped once it passes any real shift length', () => {
    // Gopal checked in at 16:46 and never checked out. Without a ceiling this
    // is "every minute since 13 August".
    const t = computeToday([at(DAY + '00:46:00Z')], { now: Date.parse('2026-09-08T00:00:00Z') });
    assert.equal(t.totalMinutes, 12 * 60, 'capped at twelve hours');
    assert.equal(t.openTooLong, true, 'and says the number is a ceiling, not a measurement');
  });

  test('a past day is not billed every hour since', () => {
    // The old code read Date.now() unconditionally; the only thing stopping a
    // past day from accruing four days of pay was a comment asking callers not
    // to do it.
    const t = computeToday([at('2026-08-13T23:46:00Z')], { now: Date.parse('2026-09-08T00:00:00Z') });
    assert.ok(t.totalMinutes <= 12 * 60, `billed ${t.totalMinutes} minutes for one unclosed shift`);
  });

  test('a normal closed day is untouched and not flagged', () => {
    const t = computeToday([at(DAY + '16:00:00Z'), out(DAY + '20:30:00Z')],
                           { now: Date.parse('2026-09-08T00:00:00Z') });
    assert.equal(t.totalMinutes, 270);
    assert.equal(t.unclosed, false);
    assert.equal(t.openTooLong, false);
  });

  test('the clock never runs backwards', () => {
    // A punch stamped in the future (clock skew on a phone) must not subtract.
    const t = computeToday([at(DAY + '18:00:00Z')], { now: Date.parse(DAY + '15:00:00Z') });
    assert.equal(t.totalMinutes, 0);
  });
});
