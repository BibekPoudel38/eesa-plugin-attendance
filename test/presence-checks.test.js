// "Still here?" — the silent push that keeps a checked-in phone's log going.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PLUGIN_GATEWAY_SECRET = 'test-secret';
process.env.EESA_API_BASE = 'https://backend.test/api/v1';
const { runPresenceChecks, presenceChecksOn, checkEveryMs, KIND } = await import('../src/presence_checks.js');
const { notifyUser } = await import('../src/notify.js');

test('off unless it is switched on', () => {
  assert.equal(presenceChecksOn({}), false);
  assert.equal(presenceChecksOn({ PRESENCE_CHECKS: 'off' }), false);
  assert.equal(presenceChecksOn({ PRESENCE_CHECKS: 'on' }), true);
  assert.equal(presenceChecksOn({ PRESENCE_CHECKS: '1' }), true);
});

test('every twenty minutes, never more often than fifteen', () => {
  assert.equal(checkEveryMs({}), 20 * 60 * 1000);
  assert.equal(checkEveryMs({ PRESENCE_CHECK_MINUTES: '5' }), 15 * 60 * 1000, 'Apple throttles more than a few an hour');
  assert.equal(checkEveryMs({ PRESENCE_CHECK_MINUTES: '30' }), 30 * 60 * 1000);
});

test('each person claimed gets one silent push, with nothing to show', async () => {
  const sent = [];
  const store = { async claimPresenceChecks({ everyMs }) {
    assert.equal(everyMs, 20 * 60 * 1000);
    return [{ tenantId: 't1', employeeRef: '39' }, { tenantId: 't1', employeeRef: '41' }];
  } };
  const n = await runPresenceChecks({ store, notify: (t, u, msg) => sent.push({ t, u, msg }), everyMs: 20 * 60 * 1000 });
  assert.equal(n, 2);
  assert.deepEqual(sent.map((s) => s.u), ['39', '41']);
  for (const { msg } of sent) {
    assert.equal(msg.silent, true);
    assert.equal(msg.title, undefined, 'no title: nothing on screen');
    assert.equal(msg.type, KIND);
    assert.equal(msg.data.kind, KIND, 'the app knows what it is being asked');
  }
});

test('nobody on the clock, nobody asked', async () => {
  const sent = [];
  const n = await runPresenceChecks({ store: { claimPresenceChecks: async () => [] }, notify: () => sent.push(1) });
  assert.equal(n, 0);
  assert.equal(sent.length, 0);
});

test('a silent push reaches the backend without a title, marked silent', async () => {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; };
  try {
    await notifyUser('t1', '39', { silent: true, type: KIND, data: { kind: KIND } });
    await notifyUser('t1', '39', { body: 'no title and not silent is dropped' });
  } finally {
    globalThis.fetch = real;
  }
  const mine = calls.filter((c) => c.url.endsWith('/gateway/notify/'));
  assert.equal(mine.length, 1, 'a visible push with no title is still never sent');
  assert.equal(mine[0].body.silent, true);
  assert.equal(mine[0].body.title, '');
  assert.equal(mine[0].body.type, KIND);
});
