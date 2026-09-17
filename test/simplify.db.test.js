/// The simplified model against a real Postgres — the SQL, not just the rules.
///
/// Runs only when TEST_DATABASE_URL points at a database with the attendance
/// schema (a local copy, never production):
///   TEST_DATABASE_URL=postgres://tester@127.0.0.1:55499/attendance PGSSL=disable npm test
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const URL_ = process.env.TEST_DATABASE_URL;
const skip = !URL_ && 'set TEST_DATABASE_URL to run the database tests';
if (URL_) { process.env.DATABASE_URL = URL_; process.env.PGSSL = process.env.PGSSL || 'disable'; }

const T = 'int-test-tenant';
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
const settle = () => new Promise((r) => setTimeout(r, 300));
const punch = (ref, type, when, extra = {}) =>
  db.recordEvent(T, ref, type, { zoneId, lat: C.lat, lng: C.lng, accuracyM: 5, source: 'geofence', at: when, ...extra });
const dayRow = async (ref, day) =>
  (await db.listApprovals(T, { from: day, to: day })).find((r) => r.employeeRef === ref);

describe('simplified attendance on a real database', { skip }, () => {
  const D3 = daysAgo(3);
  const D2 = daysAgo(2);

  before(async () => {
    db = await import('../src/db.js');
    await db.ensureSimplifyTables();
    for (const t of ['events', 'day_summaries', 'zones', 'tenant_settings', 'presence_signals', 'day_corrections', 'sent_summaries']) {
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

  test("Jeeva's real 15 Sep is flagged, with the phone's evidence", async () => {
    await punch('39', 'check_in', zoned(D2, '09:26'));
    await punch('39', 'check_out', zoned(D2, '10:51'), { source: 'banner' });
    const ignored = await punch('39', 'check_out', zoned(D2, '15:25'), { lat: C.lat + 0.003 });
    assert.equal(ignored.duplicate, true, 'already out — nothing recorded');
    await punch('39', 'check_in', zoned(D2, '15:33'));
    await punch('39', 'check_out', zoned(D2, '17:17'), { lat: C.lat + 0.00376 });
    await settle();
    const r = await dayRow('39', D2);
    assert.equal(r.totalMinutes, 85 + 104);
    assert.deepEqual(r.flags, ['left_later']);
    assert.equal(r.needsFix, true);
    assert.equal(r.leftZoneAt, zoned(D2, '15:25'));
    assert.equal(r.verification, 'verified', 'a 418 m walk-out no longer reads "Location not confirmed"');
  });

  test('Fix times sets the day, and Undo puts it back', async () => {
    const fix = await db.setDayCorrection(T, '39', D2, { firstIn: zoned(D2, '09:26'), lastOut: zoned(D2, '17:17') }, '36');
    assert.equal(fix.ok, true);
    let r = await dayRow('39', D2);
    assert.equal(r.totalMinutes, 471);
    assert.deepEqual(r.flags, ['changed']);
    assert.equal(r.needsFix, false);
    assert.equal(r.correctedBy, '36');

    await db.clearDayCorrection(T, '39', D2);
    r = await dayRow('39', D2);
    assert.equal(r.totalMinutes, 189);
    assert.deepEqual(r.flags, ['left_later']);

    const bad = await db.setDayCorrection(T, '39', D2, { firstIn: zoned(D2, '17:00'), lastOut: zoned(D2, '09:00') }, '36');
    assert.equal(bad.ok, false);
    assert.match(bad.problem, /after the check-in/);
  });

  test('a 10 PM to 2 AM shift is one day, and the next day has no row', async () => {
    const D1 = daysAgo(2); // the calendar day after D3
    await punch('40', 'check_in', zoned(D3, '22:00'));
    await punch('40', 'check_out', zoned(D1, '02:00'));
    const r = await dayRow('40', D3);
    assert.equal(r.totalMinutes, 240);
    assert.deepEqual(r.flags, []);
    assert.equal(await dayRow('40', D1), undefined, 'no "No arrival recorded" day after midnight');
  });

  test('a forgotten check-out bills nothing and asks for a fix', async () => {
    await punch('41', 'check_in', zoned(D3, '09:00'));
    const r = await dayRow('41', D3);
    assert.equal(r.totalMinutes, 0);
    assert.deepEqual(r.flags, ['no_check_out']);
    assert.equal(r.open, false);
  });

  test('a four-minute visit adds no hours and no flag', async () => {
    await punch('42', 'check_in', zoned(D2, '12:33'));
    await punch('42', 'check_out', zoned(D2, '12:37'));
    const r = await dayRow('42', D2);
    assert.equal(r.totalMinutes, 0);
    assert.deepEqual(r.flags, []);
  });

  test('a corrected day counts as corrected, with nothing left to approve', async () => {
    await db.setDayCorrection(T, '39', D2, { firstIn: zoned(D2, '09:26'), lastOut: zoned(D2, '17:17') }, '36');
    const row = await dayRow('39', D2);
    assert.equal(row.totalMinutes, 471);
    assert.deepEqual(row.flags, ['changed']);
    assert.equal(row.needsFix, false);
  });

  test("a check-out with a reason stands, and isn't 'left later'", async () => {
    await punch('47', 'check_in', zoned(D3, '09:00'));
    await punch('47', 'check_out', zoned(D3, '10:00'), { source: 'banner', note: '  Left my keys at home  ' });
    const exit = await punch('47', 'check_out', zoned(D3, '11:30'), { lat: C.lat + 0.003 });
    assert.equal(exit.duplicate, true);
    await settle();
    const row = await dayRow('47', D3);
    assert.equal(row.totalMinutes, 60);
    assert.deepEqual(row.flags, []);
    const log = await db.eventLog(T, { employeeRef: '47', from: D3, to: D3 });
    assert.equal(log.find((e) => e.type === 'check_out').note, 'Left my keys at home');
    assert.equal(log.find((e) => e.type === 'check_in').note, null);
  });

  test('someone on the clock right now reads as open, on the day their shift began', async () => {
    const start = new Date(Date.now() - 3 * 3600e3).toISOString();
    await punch('43', 'check_in', start);
    const st = await db.myStatus(T, '43');
    assert.equal(st.checkedIn, true);
    assert.equal(st.today.date, new Date(start).toLocaleDateString('en-CA', { timeZone: TZ }));
    assert.ok(st.todayMinutes >= 179 && st.todayMinutes <= 181, `got ${st.todayMinutes}`);
    const r = await dayRow('43', st.today.date);
    assert.equal(r.open, true);
    assert.equal(r.needsFix, false);
  });

  test('removing a hand-entered punch recomputes its own day', async () => {
    await db.manualEntry(T, '44', 'check_in', zoned(D2, '08:00'));
    await db.manualEntry(T, '44', 'check_out', zoned(D2, '16:00'));
    assert.equal((await dayRow('44', D2)).totalMinutes, 480);
    const { rows } = await db.pool.query(
      `select id from events where tenant_id = $1 and employee_ref = '44' and type = 'check_out'`, [T]);
    await db.deleteManualEvent(T, rows[0].id);
    assert.deepEqual((await dayRow('44', D2)).flags, ['no_check_out']);
  });

  test('every other read the app and web page use still answers', async () => {
    const presence = await db.presence(T);
    assert.ok(Array.isArray(presence.employees));
    const log = await db.eventLog(T, { from: D3, to: D2 });
    assert.ok(log.length > 0);
    assert.equal(log.find((e) => e.type === 'check_out' && e.source === 'geofence' && e.employeeRef === '39').verification, 'verified');
    const hist = await db.myHistory(T, '39', 7);
    assert.ok(hist.days.length > 0);
    const detail = await db.employeeDetail(T, '39', { from: D3, to: D2 });
    assert.equal(detail.days[0].totalMinutes, 471);
    const mine = await db.myEvents(T, '39', { days: 7 });
    assert.ok(mine.length >= 4);
    const report = await db.report(T, { from: D3, to: D2 });
    assert.ok(report.some((r) => r.employeeRef === '39'));
  });

  test('registering zones at work does not end the shift (Jeeva, 6 Aug)', async () => {
    const other = (await db.pool.query(
      `insert into zones (tenant_id, name, center_lat, center_lng, radius_m) values ($1, 'Dinesh Catering', 33.83048, -117.98238, 16) returning id`,
      [T],
    )).rows[0].id;
    await punch('45', 'check_in', zoned(D3, '12:33'));
    const bogus = await punch('45', 'check_out', zoned(D3, '12:33'), { zoneId: other, lat: C.lat, lng: C.lng });
    assert.equal(bogus.duplicate, true);
    assert.equal(bogus.ignored, 'another_zone');
    await punch('45', 'check_out', zoned(D3, '17:00'), { lat: C.lat + 0.003 });
    const row = await dayRow('45', D3);
    assert.equal(row.totalMinutes, 267);
    assert.deepEqual(row.flags, []);
    await settle();
    const sig = await db.pool.query(
      `select reason from presence_signals where tenant_id = $1 and employee_ref = '45'`, [T]);
    assert.deepEqual(sig.rows.map((r) => r.reason), ['left_another_zone']);
  });

  test("a hand check-out is not 'left later' because of another zone's exit", async () => {
    const other = (await db.pool.query(
      `select id from zones where tenant_id = $1 and name = 'Dinesh Catering'`, [T])).rows[0].id;
    await punch('46', 'check_in', zoned(D3, '09:00'));
    await punch('46', 'check_out', zoned(D3, '10:00'), { source: 'banner' });
    await punch('46', 'check_out', zoned(D3, '11:30'), { zoneId: other, lat: C.lat + 0.02 });
    await settle();
    const row = await dayRow('46', D3);
    assert.deepEqual(row.flags, []);
    assert.equal(row.leftZoneAt, null);
  });

  test('working hours default to 7 AM–10 PM, and a manager can change them', async () => {
    assert.deepEqual(await db.getWorkingHours(T), { start: '07:00', end: '22:00' });
    assert.equal((await db.setWorkingHours(T, { start: '6:00', end: '23:00' })).ok, false);
    assert.equal((await db.setWorkingHours(T, { start: '06:30', end: '23:00' })).ok, true);
    assert.deepEqual(await db.getWorkingHours(T), { start: '06:30', end: '23:00' });
    assert.equal(await db.getTenantTimezone(T), TZ); // the timezone is left alone
    assert.deepEqual((await db.getTenantSettings(T)).workingHours, { start: '06:30', end: '23:00' });
  });

  test('checked in by tapping, with a reason and no zone, the phone leaving still ends the shift', async () => {
    await db.recordEvent(T, '52', 'check_in', { zoneId: null, source: 'banner', note: 'Work', at: zoned(D3, '09:00') });
    const left = await punch('52', 'check_out', zoned(D3, '13:00'), { lat: C.lat + 0.003 });
    assert.equal(left.duplicate, undefined, 'recorded, not ignored as another zone');
    assert.equal((await dayRow('52', D3)).totalMinutes, 240);
    const log = await db.myEvents(T, '52', { from: D3, to: D3 });
    assert.equal(log.find((e) => e.type === 'check_in').note, 'Work');
  });

  test('staff say why they came in or went out, on their own recent punches, and the hours never move', async () => {
    const came = await punch('56', 'check_in', new Date(Date.now() - 2 * 3600e3).toISOString());
    const left = await punch('56', 'check_out', new Date(Date.now() - 3600e3).toISOString(), { lat: C.lat + 0.003 });
    assert.equal(await db.setMyReason(T, '56', left.id, '  Outside work '), true);
    assert.equal(await db.setMyReason(T, '56', came.id, 'Work'), true);
    assert.equal(await db.setMyReason(T, '57', came.id, 'Not mine'), false, "someone else's punch");
    assert.equal(await db.setMyReason(T, '56', 'not-an-id', 'Work'), false);
    const st = await db.myStatus(T, '56');
    assert.deepEqual(st.events.map((e) => e.note), ['Outside work', null], 'Work is the default, so nothing is stored');
    assert.deepEqual(st.events.map((e) => e.zoneName), ['Chups Anaheim', 'Chups Anaheim'], 'each entry names its zone');
    assert.equal(st.todayMinutes, 60, 'a reason never changes the hours');
    assert.equal((await db.presence(T)).employees.find((e) => e.employeeRef === '56').reason, 'Outside work');
    const old = await punch('58', 'check_in', new Date(Date.now() - 3 * 24 * 3600e3).toISOString());
    assert.equal(await db.setMyReason(T, '58', old.id, 'Work'), false, 'too long ago to change');
  });

  test('the attendance admin cannot change who is an admin — that is Eesa\'s', async () => {
    await db.upsertMember(T, { employeeRef: '61', role: 'manager', payRate: 20, name: 'Manager' });
    await db.upsertMemberDetails(T, { employeeRef: '61', payRate: 25, name: 'Manager', email: '' });
    assert.equal((await db.getMembership(T, '61')).role, 'manager', 'the role it already had');
    assert.equal(Number((await db.getMembership(T, '61')).payRate), 25, 'and the pay it was given');
    await db.upsertMemberDetails(T, { employeeRef: '62', payRate: 18, name: 'New', email: '' });
    assert.equal((await db.getMembership(T, '62')).role, 'staff', 'a new row is never a manager');
  });

  test('somebody who says "Not for work" is on site but not counted as at work', async () => {
    const came = await punch('60', 'check_in', new Date(Date.now() - 30 * 60e3).toISOString());
    const mine = async () => (await db.presence(T)).employees.find((e) => e.employeeRef === '60');
    assert.equal((await mine()).checkedIn, true);
    assert.equal(await db.setMyReason(T, '60', came.id, 'Not for work'), true);
    const after = await mine();
    assert.equal(after.checkedIn, false);
    assert.equal(after.reason, 'Not for work');
    assert.equal((await db.myStatus(T, '60')).checkedIn, false, 'their own page agrees');
    assert.equal((await db.myStatus(T, '60')).todayMinutes, 0, 'and the visit is not paid');
  });

  test('saying "Outside work" afterwards counts the trip in the day', async () => {
    const Y = daysAgo(1);
    await punch('59', 'check_in', zoned(Y, '09:00'));
    const out = await punch('59', 'check_out', zoned(Y, '11:00'), { lat: C.lat + 0.003 });
    await punch('59', 'check_in', zoned(Y, '12:30'));
    await punch('59', 'check_out', zoned(Y, '17:00'), { lat: C.lat + 0.003 });
    assert.equal((await dayRow('59', Y)).totalMinutes, 390);
    assert.equal(await db.setMyReason(T, '59', out.id, 'Outside work'), true);
    assert.equal((await dayRow('59', Y)).totalMinutes, 480);
    assert.equal(await db.setMyReason(T, '59', out.id, 'Going home'), true, 'back to the default');
    assert.equal((await db.myEvents(T, '59', { from: Y, to: Y })).find((e) => e.id === String(out.id)).note, null);
    assert.equal((await dayRow('59', Y)).totalMinutes, 390);
  });

  test('checked out by tapping with a reason, the time stops there', async () => {
    await punch('53', 'check_in', zoned(D3, '09:00'));
    await db.recordEvent(T, '53', 'check_out', { zoneId: null, source: 'banner', note: 'Outside work', at: zoned(D3, '11:00') });
    const exit = await punch('53', 'check_out', zoned(D3, '11:05'), { lat: C.lat + 0.003 });
    assert.equal(exit.duplicate, true, 'already out');
    assert.equal((await dayRow('53', D3)).totalMinutes, 120);
  });

  test('a summary is sent once, however many times it is claimed', async () => {
    assert.equal(await db.claimSummary(T, 'daily', D2), true);
    assert.equal(await db.claimSummary(T, 'daily', D2), false);
  });
});
