import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withPersonLock, dayFlags } from '../src/db.js';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test('one person\'s punches run one at a time — the second sees the first', async () => {
  // 23 Sep: a geofence check-in and the app's rescue check-in, a second apart,
  // were both judged against the same last punch and both written.
  const order = [];
  const punch = (name, ms) => withPersonLock('t|anbu', async () => {
    order.push(`${name} starts`);
    await pause(ms);
    order.push(`${name} ends`);
    return name;
  });
  const [a, b] = await Promise.all([punch('geofence', 30), punch('rescue', 1)]);
  assert.deepEqual([a, b], ['geofence', 'rescue']);
  assert.deepEqual(order, ['geofence starts', 'geofence ends', 'rescue starts', 'rescue ends']);
});

test('different people are never held up by each other', async () => {
  const order = [];
  await Promise.all([
    withPersonLock('t|anbu', async () => { order.push('anbu'); await pause(30); order.push('anbu done'); }),
    withPersonLock('t|jeeva', async () => { order.push('jeeva'); await pause(1); order.push('jeeva done'); }),
  ]);
  assert.deepEqual(order, ['anbu', 'jeeva', 'jeeva done', 'anbu done']);
});

test('a punch that fails does not jam the queue behind it', async () => {
  await assert.rejects(withPersonLock('t|anbu', async () => { throw new Error('db down'); }));
  assert.equal(await withPersonLock('t|anbu', async () => 'next one runs'), 'next one runs');
});

const DAY = { first_in: '2026-09-23T20:05:00Z', last_out: '2026-09-24T00:00:00Z', total_minutes: 235 };

test('a phone away while checked in needs a look before the week is approved', () => {
  const d = dayFlags({ ...DAY, integrity: [{ flag: 'away', at: '2026-09-23T21:40:00Z', meters: 1400 }] });
  assert.deepEqual(d.flags, ['away']);
  assert.equal(d.needsFix, true);
  assert.equal(d.integrity[0].meters, 1400, 'the evidence travels with the day');
});

test('airplane mode alone is shown, not held against anyone', () => {
  const d = dayFlags({ ...DAY, integrity: [{ flag: 'offline', at: '2026-09-23T21:10:00Z', until: '2026-09-23T21:50:00Z' }] });
  assert.deepEqual(d.flags, ['offline']);
  assert.equal(d.needsFix, false);
});

test('the same evidence twice is one flag', () => {
  const d = dayFlags({ ...DAY, integrity: [{ flag: 'log_gap', at: 'a' }, { flag: 'log_gap', at: 'b' }] });
  assert.deepEqual(d.flags, ['log_gap']);
});

test('a manager\'s fix resolves it, but the evidence stays on the day', () => {
  const d = dayFlags({ ...DAY, corrected_by: 'manager', integrity: [{ flag: 'simulated', at: 'x' }] });
  assert.deepEqual(d.flags, ['changed']);
  assert.equal(d.needsFix, false);
  assert.equal(d.integrity.length, 1);
});
