/// The scheduled summaries — the words, and when they are due.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  spanOf, addDays, dayLabel, rangeLabel, dueSummaries, rollUp,
  dailySummary, weeklySummary,
} from '../src/summary_plan.js';

const LA = 'America/Los_Angeles';

describe('when summaries are due', () => {
  test('nothing before 9 in the morning, restaurant time', () => {
    assert.deepEqual(dueSummaries(new Date('2026-09-16T15:59:00Z'), LA), []); // 8:59 AM PDT
  });

  test('from 9:00, yesterday is due', () => {
    const due = dueSummaries(new Date('2026-09-16T16:00:00Z'), LA); // Wed 9:00 AM PDT
    assert.deepEqual(due, [{ kind: 'daily', day: '2026-09-15', periodKey: '2026-09-15' }]);
  });

  test('on Monday, last Monday-to-Sunday is due as well', () => {
    const due = dueSummaries(new Date('2026-09-21T16:30:00Z'), LA); // Mon 9:30 AM PDT
    assert.deepEqual(due.map((d) => d.kind), ['daily', 'weekly']);
    assert.equal(due[1].from, '2026-09-14');
    assert.equal(due[1].to, '2026-09-20');
  });

  test("the restaurant's date decides, not the server's", () => {
    // 01:00 UTC Thursday is still Wednesday 6 PM in Anaheim — nothing new is due.
    const due = dueSummaries(new Date('2026-09-17T01:00:00Z'), LA);
    assert.equal(due[0].day, '2026-09-15');
  });
});

describe('the words', () => {
  const day = (ref, minutes, extra = {}) => ({ employeeRef: ref, totalMinutes: minutes, open: false, needsFix: false, ...extra });

  test('a normal morning', () => {
    const msg = dailySummary('2026-09-15', rollUp([day('1', 480), day('2', 463), day('3', 300, { needsFix: true })]));
    assert.equal(msg.title, 'Attendance · Tue 15 Sep');
    assert.equal(msg.body, '3 people · 20h 43m · 1 day needs a fix');
  });

  test('all good says so', () => {
    const msg = dailySummary('2026-09-15', rollUp([day('1', 60)]));
    assert.equal(msg.body, '1 person · 1h 00m · all look right');
  });

  test('an empty day sends nothing', () => {
    assert.equal(dailySummary('2026-09-15', rollUp([day('1', 0)])), null);
  });

  test('a day with only a problem still reaches the manager', () => {
    const msg = dailySummary('2026-09-15', rollUp([day('1', 0, { needsFix: true })]));
    assert.match(msg.body, /1 day needs a fix/);
  });

  test("Monday's hours — nothing to approve, only what looks wrong", () => {
    const msg = weeklySummary('2026-09-14', '2026-09-20', rollUp([day('1', 2400), day('2', 1800, { needsFix: true })]));
    assert.equal(msg.title, 'Hours for 14–20 Sep');
    assert.equal(msg.body, '2 people · 70h 00m · 1 day needs a fix');
    assert.doesNotMatch(msg.body, /approv/);
    assert.match(weeklySummary('2026-09-14', '2026-09-20', rollUp([day('1', 2400)])).body, /all look right$/);
  });

  test('a week across two months', () => {
    assert.equal(rangeLabel('2026-09-28', '2026-10-04'), '28 Sep – 4 Oct');
  });

  test('helpers', () => {
    assert.equal(spanOf(489), '8h 09m');
    assert.equal(spanOf(9), '9m');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(dayLabel('2026-09-16'), 'Wed 16 Sep');
  });
});
