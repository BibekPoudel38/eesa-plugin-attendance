// A shift that needs a look: the words the agent and the alert use, and the
// watcher that tells Eesa's flows — once per kind of evidence, and again only
// if Eesa did not take it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidenceLine, dayReport, summaryOf, runIntegrityAlerts, EVENT } from '../src/integrity.js';

const TZ = 'America/Los_Angeles';

test('each piece of evidence reads as a manager would say it', () => {
  assert.equal(
    evidenceLine({ flag: 'phone_off', at: '2026-09-23T19:00:00Z', until: '2026-09-23T20:56:00Z', missed: 6 }, TZ),
    'Phone switched off 12:00 PM – 1:56 PM (6 checks unanswered, then restarted)',
  );
  assert.equal(
    evidenceLine({ flag: 'away', at: '2026-09-23T21:40:00Z', until: '2026-09-23T22:10:00Z', meters: 1400, zone: 'Chups Anaheim' }, TZ),
    'Away from the zone 2:40 PM – 3:10 PM (1.4 km from Chups Anaheim)',
  );
  assert.equal(
    evidenceLine({ flag: 'clock_changed', at: '2026-09-23T19:00:00Z', byMs: 5 * 3600e3 }, TZ),
    'Clock changed by hand 12:00 PM (moved 5h 00m ahead)',
  );
});

const ROW = {
  employeeRef: '39', day: '2026-09-23', totalMinutes: 480, needsFix: true,
  flags: ['location_off', 'offline'],
  locationOff: [{ from: '2026-09-23T19:01:00Z', to: '2026-09-23T21:21:00Z' }],
  integrity: [{ flag: 'offline', at: '2026-09-23T18:00:00Z', until: '2026-09-23T18:20:00Z' }],
};

test('a day reads in time order, with the hours that stand', () => {
  const r = dayReport(ROW, { name: 'Jeeva', tz: TZ });
  assert.deepEqual(r.evidence, ['No network 11:00 AM – 11:20 AM', 'Location off 12:01 PM – 2:21 PM']);
  assert.equal(r.hours, '8h 00m');
  assert.equal(summaryOf(r),
    "Jeeva's shift on Wed, Sep 23 needs a look: No network 11:00 AM – 11:20 AM; Location off 12:01 PM – 2:21 PM. The hours stand at 8h 00m until a manager decides.");
});

function store(rows, { told = new Map() } = {}) {
  const marked = [];
  return {
    marked,
    async tenantsWithSettings() { return [{ tenantId: 't1', timezone: TZ }]; },
    async listApprovals() { return rows; },
    async integrityAlerted(t, ref, day) { return new Set(told.get(`${ref}|${day}`) || []); },
    async markIntegrityAlerted(t, ref, day, flags) {
      marked.push(`${ref}|${day}|${flags}`);
      told.set(`${ref}|${day}`, [...(told.get(`${ref}|${day}`) || []), ...flags]);
    },
  };
}
const NOW = Date.parse('2026-09-23T23:00:00Z');

test('a shift that needs a look is told to the flows once', async () => {
  const s = store([ROW]);
  const sent = [];
  const fire = async (tenant, payload) => { sent.push(payload); return true; };
  assert.equal(await runIntegrityAlerts({ store: s, fire, now: NOW, names: async () => new Map([['39', 'Jeeva']]) }), 1);
  assert.equal(await runIntegrityAlerts({ store: s, fire, now: NOW }), 0, 'the next tick says nothing new');
  assert.equal(sent.length, 1);
  const p = sent[0];
  assert.equal(p.name, 'Jeeva');
  assert.deepEqual(p.flags, ['Location off'], 'only what needs a look, not the no-network line');
  assert.equal(p.dedupe_key, '39|2026-09-23|location_off');
  assert.match(p.summary, /^Jeeva's shift on Wed, Sep 23 needs a look/);
  assert.equal(EVENT, 'attendance.needs_a_look');
});

test('new evidence on the same day is told, and only the new', async () => {
  const told = new Map([['39|2026-09-23', ['location_off']]]);
  const sent = [];
  await runIntegrityAlerts({
    store: store([{ ...ROW, flags: ['location_off', 'phone_off'] }], { told }), now: NOW,
    fire: async (t, p) => { sent.push(p); return true; },
  });
  assert.deepEqual(sent.map((p) => p.dedupe_key), ['39|2026-09-23|phone_off']);
});

test('Eesa not taking it means it is tried again, not forgotten', async () => {
  const s = store([ROW]);
  await runIntegrityAlerts({ store: s, fire: async () => false, now: NOW });
  assert.deepEqual(s.marked, []);
  let tries = 0;
  await runIntegrityAlerts({ store: s, fire: async () => { tries += 1; return true; }, now: NOW });
  assert.equal(tries, 1);
});

test('a day with nothing that needs a look is not told', async () => {
  const sent = [];
  await runIntegrityAlerts({
    store: store([{ ...ROW, needsFix: false, flags: ['offline', 'silent'] }]), now: NOW,
    fire: async (t, p) => { sent.push(p); return true; },
  });
  assert.deepEqual(sent, []);
});

test('when it cannot remember what it told, it says nothing rather than repeat', async () => {
  const s = store([ROW]);
  s.integrityAlerted = async () => null;
  const sent = [];
  await runIntegrityAlerts({ store: s, fire: async (t, p) => { sent.push(p); return true; }, now: NOW });
  assert.deepEqual(sent, []);
});
