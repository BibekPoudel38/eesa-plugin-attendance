/// The phone's log and the punch lock against a real Postgres — the SQL, not
/// just the rules: two check-ins in the same second leave one row, a log sent
/// twice is filed once, and a phone away while checked in flags the day
/// without touching the hours.
///
/// Runs only when TEST_DATABASE_URL points at a database with the attendance
/// schema (a local copy, never production):
///   TEST_DATABASE_URL=postgres://tester@127.0.0.1:55499/attendance PGSSL=disable npm test
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEntry, entryDigest } from '../src/presence.js';

const URL_ = process.env.TEST_DATABASE_URL;
const skip = !URL_ && 'set TEST_DATABASE_URL to run the database tests';
if (URL_) { process.env.DATABASE_URL = URL_; process.env.PGSSL = process.env.PGSSL || 'disable'; }

const T = 'int-test-presence';
const TZ = 'America/Los_Angeles';
const C = { lat: 33.831389, lng: -118.00459 };
const MIN = 60 * 1000;
let db;
let zoneId;

const daysAgo = (n) => new Date(Date.now() - n * 864e5).toLocaleDateString('en-CA', { timeZone: TZ });
/// 1 PM on a local day, as epoch ms.
function onePm(ymd) {
  const guess = Date.parse(`${ymd}T20:00:00Z`); // 13:00 PDT
  return guess;
}
const dayRow = async (ref, day) =>
  (await db.listApprovals(T, { from: day, to: day })).find((r) => r.employeeRef === ref);

/// A phone's log, chained the way the app chains it.
function log(rows) {
  let prev = '';
  return rows.map((r, i) => {
    const e = normalizeEntry({ seq: i + 1, online: true, accuracyM: 8, lat: C.lat, lng: C.lng, ...r });
    const out = { ...r, seq: e.seq, at: e.at, online: e.online, accuracyM: e.accuracyM, lat: e.lat, lng: e.lng, prevHash: prev };
    out.hash = entryDigest(prev, { ...e, prevHash: prev });
    prev = out.hash;
    return out;
  });
}

describe('presence log and punch lock on a real database', { skip }, () => {
  const D = daysAgo(2);
  const T0 = onePm(D);

  before(async () => {
    db = await import('../src/db.js');
    await db.ensureSimplifyTables();
    for (const t of ['events', 'day_summaries', 'zones', 'tenant_settings', 'day_corrections']) {
      await db.pool.query(`delete from ${t} where tenant_id = $1`, [T]);
    }
    // Not there yet on a fresh database: recordPresence builds it on first use.
    await db.pool.query(`delete from presence_log where tenant_id = $1`, [T]).catch(() => {});
    await db.pool.query(`delete from presence_checks where tenant_id = $1`, [T]).catch(() => {});
    for (const t of ['presence_check_log', 'integrity_alerts']) {
      await db.pool.query(`delete from ${t} where tenant_id = $1`, [T]).catch(() => {});
    }
    await db.setTenantTimezone(T, TZ);
    const z = await db.pool.query(
      `insert into zones (tenant_id, name, center_lat, center_lng, radius_m) values ($1, 'Chups Anaheim', $2, $3, 100) returning id`,
      [T, C.lat, C.lng],
    );
    zoneId = z.rows[0].id;
  });
  after(async () => { if (db) await db.pool.end(); });

  test('two check-ins in the same second leave one row (23 Sep, 13:05:24 and :25)', async () => {
    const at = new Date(T0).toISOString();
    const base = { zoneId, lat: C.lat, lng: C.lng, accuracyM: 3.5, at };
    await Promise.all([
      db.recordEvent(T, '39', 'check_in', { ...base, source: 'geofence', clientId: 'd85c1045' }),
      db.recordEvent(T, '39', 'check_in', { ...base, source: 'banner', at: new Date(T0 + 1000).toISOString() }),
    ]);
    const { rows } = await db.pool.query(
      `select source from events where tenant_id = $1 and employee_ref = '39' and type = 'check_in'`, [T]);
    assert.equal(rows.length, 1, `one arrival is one row, got ${rows.map((r) => r.source)}`);
  });

  test('a phone 1.4 km away while checked in flags the day; the hours stay', async () => {
    await db.recordEvent(T, '39', 'check_out', {
      zoneId, lat: C.lat, lng: C.lng, accuracyM: 5, source: 'geofence', at: new Date(T0 + 240 * MIN).toISOString(),
    });
    const entries = log([
      { at: T0 + 20 * MIN },
      { at: T0 + 80 * MIN, elapsedMs: 60 * MIN, lat: C.lat + 0.0135 }, // ~1.4 km north
      { at: T0 + 140 * MIN, elapsedMs: 60 * MIN },
    ]);
    const first = await db.recordPresence(T, '39', { deviceId: 'iphone-39', entries });
    assert.deepEqual(first, { accepted: 3, lastSeq: 3 });
    const again = await db.recordPresence(T, '39', { deviceId: 'iphone-39', entries });
    assert.deepEqual(again, { accepted: 0, lastSeq: 3 }, 'a batch sent twice is filed once');

    const row = await dayRow('39', D);
    assert.equal(row.totalMinutes, 240, 'never a cut in the hours');
    assert.deepEqual(row.flags, ['away']);
    assert.equal(row.needsFix, true);
    const [ev] = row.integrity;
    assert.equal(ev.flag, 'away');
    assert.equal(ev.zone, 'Chups Anaheim');
    assert.ok(ev.meters > 1200 && ev.meters < 1500, String(ev.meters));
  });

  test('airplane mode alone is shown on the day, not held against anyone', async () => {
    const D2 = daysAgo(3);
    const T2 = onePm(D2);
    await db.recordEvent(T, '41', 'check_in', { zoneId, lat: C.lat, lng: C.lng, accuracyM: 5, source: 'geofence', at: new Date(T2).toISOString() });
    await db.recordEvent(T, '41', 'check_out', { zoneId, lat: C.lat, lng: C.lng, accuracyM: 5, source: 'geofence', at: new Date(T2 + 180 * MIN).toISOString() });
    await db.recordPresence(T, '41', { deviceId: 'iphone-41', entries: log([
      { at: T2 + 30 * MIN, online: false },
      { at: T2 + 60 * MIN, online: true },
    ]) });
    const row = await dayRow('41', D2);
    assert.deepEqual(row.flags, ['offline']);
    assert.equal(row.needsFix, false);
    assert.equal(row.totalMinutes, 180);
  });

  test('the upload puts the log on the server\'s clock: a clock set ahead offline is caught', async () => {
    const D3 = daysAgo(4);
    const T3 = onePm(D3);
    const now = Date.now();
    await db.recordEvent(T, '46', 'check_in', { zoneId, lat: C.lat, lng: C.lng, accuracyM: 5, source: 'geofence', at: new Date(T3).toISOString() });
    await db.recordEvent(T, '46', 'check_out', { zoneId, lat: C.lat, lng: C.lng, accuracyM: 5, source: 'geofence', at: new Date(T3 + 240 * MIN).toISOString() });
    // Written at 13:20 and 13:40; the second with the clock five hours ahead.
    const entries = log([
      { at: T3 + 20 * MIN, online: false },
      { at: T3 + 340 * MIN, online: false, elapsedMs: 20 * MIN },
    ]).map((e, i) => ({ ...e, ageMs: now - (T3 + [20, 40][i] * MIN), serverAt: T3 }));
    assert.deepEqual(await db.recordPresence(T, '46', { deviceId: 'iphone-46', entries, now }), { accepted: 2, lastSeq: 2 });
    const { rows } = await db.pool.query(
      `select seq, extract(epoch from server_at) * 1000 as s from presence_log where tenant_id = $1 and employee_ref = '46' order by seq`, [T]);
    assert.deepEqual(rows.map((r) => Math.round(Number(r.s))), [T3 + 20 * MIN, T3 + 40 * MIN], 'the phone cannot claim a server time');
    const row = await dayRow('46', D3);
    assert.deepEqual([...row.flags].sort(), ['clock_changed', 'offline']);
    assert.equal(row.needsFix, true);
    assert.equal(row.totalMinutes, 240, 'never a cut in the hours');
    const clock = row.integrity.find((x) => x.flag === 'clock_changed');
    assert.equal(clock.at, new Date(T3 + 40 * MIN).toISOString());
  });

  test('a presence log that cannot be read leaves the days standing, without it', async () => {
    const D = daysAgo(2);
    await db.pool.query('alter table presence_log rename to presence_log_away');
    try {
      const row = await dayRow('39', D);
      assert.equal(row.totalMinutes, 240, 'the manager still sees the day');
      assert.deepEqual(row.integrity, []);
    } finally {
      await db.pool.query('alter table presence_log_away rename to presence_log');
    }
    assert.deepEqual((await dayRow('39', D)).flags, ['away'], 'and the evidence is back once it can be read');
  });

  test('the tenant agent reads who needs a look, and one day in full', async () => {
    const { handleRpc } = await import('../src/mcp.js');
    const names = async () => new Map([['39', 'Jeeva'], ['46', 'Anbu']]);
    const call = (name, args, appRole = 'admin') => handleRpc(
      { method: 'tools/call', params: { name, arguments: args } }, { tenantId: T, appRole, sub: 'gateway' }, {}, { names });
    const read = (r) => JSON.parse(r.content[0].text);

    const listed = await handleRpc({ method: 'tools/list' }, { tenantId: T, appRole: 'admin' }, {}, { names });
    for (const t of ['attendance_needs_a_look', 'attendance_day_evidence']) {
      assert.ok(listed.tools.some((x) => x.name === t), `${t} is offered to admins`);
    }
    for (const t of listed.tools) {
      assert.equal(t.annotations?.readOnlyHint, true, `${t.name} says it is a read, or Eesa asks "shall I?" first`);
    }
    const catalogue = await handleRpc({ method: 'tools/list' }, { tenantId: T }, {}, { names });
    assert.ok(!catalogue.tools.some((x) => x.name === 'mark_attendance'), 'the one write is never listed');
    const staffList = await handleRpc({ method: 'tools/list' }, { tenantId: T, appRole: 'staff' }, {}, { names });
    assert.ok(!staffList.tools.some((x) => x.name === 'attendance_needs_a_look'), 'never to staff');

    const look = read(await call('attendance_needs_a_look', { from: daysAgo(5), to: daysAgo(1) }));
    const jeeva = look.days.find((d) => d.employeeRef === '39');
    assert.equal(jeeva.name, 'Jeeva');
    assert.ok(jeeva.flags.includes('Away from the zone'), JSON.stringify(jeeva));
    assert.ok(jeeva.evidence.some((l) => /^Away from the zone .*km from Chups Anaheim/.test(l)), JSON.stringify(jeeva.evidence));
    assert.ok(look.days.some((d) => d.employeeRef === '46' && d.flags.includes('Clock changed by hand')));

    const day = read(await call('attendance_day_evidence', { name: 'jee', day: daysAgo(2) }));
    assert.equal(day.found, true);
    assert.equal(day.hours, '4h 00m');
    assert.deepEqual(day.punches.map((x) => x.what), ['Checked in', 'Checked out']);

    const denied = await call('attendance_needs_a_look', {}, 'staff');
    assert.equal(denied.isError, true, 'a staff member cannot read everyone');
  });

  test('phone evidence older than a year is deleted, as the privacy policy says; newer is kept', async () => {
    const put = (table, cols, vals) => db.pool.query(
      `insert into ${table} (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, vals);
    const old = new Date(Date.now() - 400 * 864e5).toISOString();
    const recent = new Date(Date.now() - 10 * 864e5).toISOString();
    await db.integrityAlerted(T, '99', daysAgo(1)); // makes the table
    for (const [at, seq] of [[old, 900001], [recent, 900002]]) {
      await put('presence_log', ['tenant_id', 'employee_ref', 'device_id', 'seq', 'at'], [T, '99', 'iphone-99', seq, at]);
      await put('presence_check_log', ['tenant_id', 'employee_ref', 'sent_at'], [T, '99', at]);
      await put('integrity_alerts', ['tenant_id', 'employee_ref', 'day', 'flag', 'alerted_at'], [T, '99', at.slice(0, 10), `away-${seq}`, at]);
    }
    const removed = await db.pruneOldEvidence();
    assert.ok(removed.presence_log >= 1 && removed.presence_check_log >= 1 && removed.integrity_alerts >= 1, JSON.stringify(removed));
    const left = async (table) => Number((await db.pool.query(
      `select count(*) as n from ${table} where tenant_id = $1 and employee_ref = '99'`, [T])).rows[0].n);
    assert.equal(await left('presence_log'), 1, 'the recent entry stays');
    assert.equal(await left('presence_check_log'), 1);
    assert.equal(await left('integrity_alerts'), 1);
  });

  test('"still here?" goes to whoever is on the clock and quiet, once per twenty minutes', async () => {
    const now = Date.now();
    const every = 20 * MIN;
    const mine = async (at) => (await db.claimPresenceChecks({ everyMs: every, now: at }))
      .filter((p) => p.tenantId === T).map((p) => p.employeeRef).sort();
    const punch = (ref, type, minsAgo) => db.recordEvent(T, ref, type, {
      zoneId, lat: C.lat, lng: C.lng, accuracyM: 5, source: 'geofence', at: new Date(now - minsAgo * MIN).toISOString(),
    });
    await punch('43', 'check_in', 90);                         // on the clock, phone quiet
    await punch('44', 'check_in', 90); await punch('44', 'check_out', 30); // went home
    await punch('45', 'check_in', 90);                         // on the clock, phone just logged
    await db.recordPresence(T, '45', { deviceId: 'iphone-45', entries: log([{ at: now - 5 * MIN }]) });

    assert.deepEqual(await mine(now), ['43']);
    assert.deepEqual(await mine(now + 60 * 1000), [], 'asked a minute ago: not again');
    assert.deepEqual(await mine(now + 21 * MIN), ['43', '45'], 'twenty minutes on, both are due');
    await punch('43', 'check_out', -22);                       // 43 leaves at now+22
    assert.deepEqual(await mine(now + 45 * MIN), ['45'], 'nobody asked after they left');
  });
});
