/// Location off while on the clock, against a real Postgres — the SQL, not
/// just the rules: a report is filed once, the day is flagged with the stretch
/// the phone could not see, the hours stay as recorded, and a manager's Fix
/// times can take the time away (and Undo puts it back).
///
/// Runs only when TEST_DATABASE_URL points at a database with the attendance
/// schema (a local copy, never production):
///   TEST_DATABASE_URL=postgres://tester@127.0.0.1:55499/attendance PGSSL=disable npm test
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { rollUp, dailySummary } from '../src/summary_plan.js';

const URL_ = process.env.TEST_DATABASE_URL;
const skip = !URL_ && 'set TEST_DATABASE_URL to run the database tests';
if (URL_) { process.env.DATABASE_URL = URL_; process.env.PGSSL = process.env.PGSSL || 'disable'; }

const T = 'int-test-location';
const TZ = 'America/Los_Angeles';
const C = { lat: 33.831389, lng: -118.00459 };
let db;
let zoneId;

/// A wall-clock time on a local day in TZ, as an ISO instant.
function zoned(ymd, hhmm) {
  const [y, m, d] = ymd.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(guess));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return new Date(guess - (asIfUtc - guess)).toISOString();
}
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toLocaleDateString('en-CA', { timeZone: TZ });
const punch = (ref, type, when) =>
  db.recordEvent(T, ref, type, { zoneId, lat: C.lat, lng: C.lng, accuracyM: 5, source: 'geofence', at: when });
const report = (ref, state, when, extra = {}) =>
  db.recordLocationState(T, ref, { state, reason: 'services_off', at: when, ...extra });
const dayRow = async (ref, day) =>
  (await db.listApprovals(T, { from: day, to: day })).find((r) => r.employeeRef === ref);

describe('location off on a real database', { skip }, () => {
  const D = daysAgo(3);

  before(async () => {
    db = await import('../src/db.js');
    await db.ensureSimplifyTables();
    for (const t of ['events', 'day_summaries', 'zones', 'tenant_settings', 'day_corrections', 'location_states']) {
      await db.pool.query(`delete from ${t} where tenant_id = $1`, [T]);
    }
    await db.setTenantTimezone(T, TZ);
    const z = await db.pool.query(
      `insert into zones (tenant_id, name, center_lat, center_lng, radius_m) values ($1, 'Chups Anaheim', $2, $3, 58) returning id`,
      [T, C.lat, C.lng],
    );
    zoneId = z.rows[0].id;
  });
  after(async () => { if (db) await db.pool.end(); });

  test('off at noon and back at 1:30 flags the day; the hours stay as recorded', async () => {
    await punch('39', 'check_in', zoned(D, '09:00'));
    await punch('39', 'check_out', zoned(D, '17:00'));
    assert.deepEqual(await report('39', 'off', zoned(D, '12:00'), { clientId: 'loc-1', lastOnAt: zoned(D, '11:40') }), { recorded: true });
    assert.deepEqual(await report('39', 'off', zoned(D, '12:00'), { clientId: 'loc-1' }), { recorded: false },
      'the same report sent twice is filed once');
    await report('39', 'on', zoned(D, '13:30'), { clientId: 'loc-2' });

    const row = await dayRow('39', D);
    assert.equal(row.totalMinutes, 480, 'never a cut in the hours');
    assert.deepEqual(row.flags, ['location_off']);
    assert.equal(row.needsFix, true);
    assert.equal(row.locationOff.length, 1);
    const [w] = row.locationOff;
    assert.equal(w.from, zoned(D, '12:00'));
    assert.equal(w.to, zoned(D, '13:30'));
    assert.equal(w.minutes, 90);
    assert.equal(w.earliest, zoned(D, '11:40'));
  });

  test('Fix times takes the time away, and Undo puts it back', async () => {
    const fixed = await db.setDayCorrection(T, '39', D,
      { firstIn: zoned(D, '09:00'), lastOut: zoned(D, '17:00'), awayMinutes: 90 }, '36');
    assert.deepEqual(fixed, { ok: true });
    let row = await dayRow('39', D);
    assert.equal(row.totalMinutes, 390);
    assert.deepEqual(row.flags, ['changed']);
    assert.equal(row.awayMinutes, 90);
    assert.equal(row.locationOff.length, 1, 'what the fix was about is still there to see');

    await db.clearDayCorrection(T, '39', D);
    row = await dayRow('39', D);
    assert.equal(row.totalMinutes, 480);
    assert.deepEqual(row.flags, ['location_off']);
  });

  test('time away as long as the day is refused, in words', async () => {
    const r = await db.setDayCorrection(T, '39', D,
      { firstIn: zoned(D, '09:00'), lastOut: zoned(D, '17:00'), awayMinutes: 480 }, '36');
    assert.equal(r.ok, false);
    assert.match(r.problem, /shorter than the day/);
  });

  test('location off after they went home flags nothing', async () => {
    const D2 = daysAgo(2);
    await punch('41', 'check_in', zoned(D2, '10:00'));
    await punch('41', 'check_out', zoned(D2, '14:00'));
    await report('41', 'off', zoned(D2, '18:00'));
    await report('41', 'on', zoned(D2, '21:00'));
    const row = await dayRow('41', D2);
    assert.deepEqual(row.flags, []);
    assert.deepEqual(row.locationOff, []);
  });

  test('an "off" from the night before still covers the next day', async () => {
    const D1 = daysAgo(1);
    await report('49', 'off', zoned(daysAgo(2), '20:00'), { reason: 'while_in_use' });
    await punch('49', 'check_in', zoned(D1, '09:00'));
    await punch('49', 'check_out', zoned(D1, '12:00'));
    const row = await dayRow('49', D1);
    assert.equal(row.locationOff.length, 1);
    assert.equal(row.locationOff[0].minutes, 180);
    assert.equal(row.locationOff[0].reason, 'while_in_use');
  });

  test("the morning summary says whose location was off", async () => {
    const msg = dailySummary(D, rollUp(await db.listApprovals(T, { from: D, to: D })));
    assert.equal(msg.body, '1 person · 8h 00m · 1 day needs a fix · Location off: someone 1h 30m');
  });

  test('a reason the server does not know is kept as none, not refused', async () => {
    await report('39', 'off', zoned(daysAgo(4), '12:00'), { reason: 'something new', source: 'nowhere', clientId: 'loc-odd' });
    const { rows } = await db.pool.query(
      `select reason, source from location_states where tenant_id = $1 and client_id = 'loc-odd'`, [T]);
    assert.deepEqual(rows, [{ reason: '', source: 'app' }]);
  });
});
