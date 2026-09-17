/// The summary job claims a summary only when it is ready to send, so a
/// failure in between is retried instead of losing the day.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runDue } from '../src/summaries.js';

const T = 'chups';
const NINE_AM_LA = new Date('2026-09-17T16:00:30Z'); // Thu 9:00 AM in Los Angeles
const DAY = [{ employeeRef: '39', day: '2026-09-16', totalMinutes: 368, open: false, needsFix: false }];

function fakeStore({ days = DAY, failList = 0 } = {}) {
  const claimed = new Set();
  const calls = { claims: 0 };
  return {
    calls, claimed,
    async tenantsWithSettings() { return [{ tenantId: T, timezone: 'America/Los_Angeles' }]; },
    async listApprovals() {
      if (failList > 0) { failList -= 1; throw new Error('max clients reached in session mode'); }
      return days;
    },
    async claimSummary(tenantId, kind, key) {
      calls.claims += 1;
      const k = `${tenantId}|${kind}|${key}`;
      if (claimed.has(k)) return false;
      claimed.add(k); return true;
    },
  };
}
const recorder = () => { const sent = []; const notify = (tenantId, users, msg) => sent.push({ users, msg }); return { sent, notify }; };

describe('runDue', () => {
  test('a database failure claims nothing, and the next minute sends it', async () => {
    const store = fakeStore({ failList: 1 });
    const { sent, notify } = recorder();
    const managerAudience = async () => ['36'];
    await assert.rejects(runDue(NINE_AM_LA, { managerAudience, store, notify }), /max clients/);
    assert.equal(store.calls.claims, 0);
    assert.equal(sent.length, 0);
    await runDue(new Date(NINE_AM_LA.getTime() + 60e3), { managerAudience, store, notify });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].msg.title, 'Attendance · Wed 16 Sep');
    assert.equal(sent[0].msg.body, '1 person · 6h 08m · all look right');
  });

  test('sends once, however many minutes tick past nine', async () => {
    const store = fakeStore();
    const { sent, notify } = recorder();
    const managerAudience = async () => ['36'];
    for (let i = 0; i < 3; i++) await runDue(new Date(NINE_AM_LA.getTime() + i * 60e3), { managerAudience, store, notify });
    assert.equal(sent.length, 1);
  });

  test('a roster that came back empty is retried, not claimed', async () => {
    const store = fakeStore();
    const { sent, notify } = recorder();
    let managers = [];
    const managerAudience = async () => managers;
    await runDue(NINE_AM_LA, { managerAudience, store, notify });
    assert.equal(store.claimed.size, 0);
    managers = ['36'];
    await runDue(NINE_AM_LA, { managerAudience, store, notify });
    assert.equal(sent.length, 1);
  });

  test('an empty day is claimed without sending', async () => {
    const store = fakeStore({ days: [] });
    const { sent, notify } = recorder();
    await runDue(NINE_AM_LA, { managerAudience: async () => ['36'], store, notify });
    assert.equal(store.claimed.size, 1);
    assert.equal(sent.length, 0);
  });

  test('nothing is due before nine', async () => {
    const store = fakeStore();
    const { sent, notify } = recorder();
    await runDue(new Date('2026-09-17T15:59:00Z'), { managerAudience: async () => ['36'], store, notify });
    assert.equal(store.calls.claims, 0);
    assert.equal(sent.length, 0);
  });
});
