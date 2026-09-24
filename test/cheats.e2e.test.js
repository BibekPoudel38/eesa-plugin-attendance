/// Every way we know to cheat attendance, played against the real service: a
/// private copy on a local database, driven over HTTP exactly as the app drives
/// it, and read back through the manager's own timesheet.
///
/// The phone below behaves as Eesa does (presence_log.dart, presence_recorder.dart,
/// geofence_callback.dart, location_watch.dart). It writes its log at a crossing,
/// when it is opened, and when a "still here?" push reaches it — which needs it to
/// be switched on, online and not swiped away. It keeps punches it could not send
/// and sends everything once it is back online.
///
/// Local database only, never production:
///   TEST_DATABASE_URL=postgres://tester@127.0.0.1:55499/attendance PGSSL=disable \
///     node --test test/cheats.e2e.test.js
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { normalizeEntry, entryDigest } from '../src/presence.js';

const URL_ = process.env.TEST_DATABASE_URL;
const skip = !URL_ && 'set TEST_DATABASE_URL to run the cheating tests';

const T = 'cheats-e2e';
const TZ = 'America/Los_Angeles';
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const WORK = { lat: 33.831389, lng: -118.00459 };
const EDGE = { lat: 33.8328, lng: -118.00459 }; // ~155 m north: where iOS fires the exit
const HOME = { lat: 33.8584, lng: -117.9559 }; // ~5 km away

let base;
let key;
let db;
let zoneId;
let managerTok;
let checkLog = false;

const daysAgo = (n) => new Date(Date.now() - n * 864e5).toLocaleDateString('en-CA', { timeZone: TZ });
/// 9:00 AM in Los Angeles (PDT) on a local day, as epoch ms.
const nineAm = (ymd) => Date.parse(`${ymd}T16:00:00Z`);

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server.address().port;
}

async function token(sub, appRole) {
  return new SignJWT({ tenantId: T, appRole })
    .setProtectedHeader({ alg: 'ES256', kid: 'test' })
    .setIssuer('eesa').setAudience('attendance').setSubject(String(sub))
    .setIssuedAt().setExpirationTime('2h')
    .sign(key.privateKey);
}

async function call(tok, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/// The server's "still here?" at [t] (its scheduler cannot run in the past).
async function asked(ref, t) {
  if (!checkLog) return;
  await db.pool.query(`insert into presence_check_log (tenant_id, employee_ref, sent_at) values ($1, $2, $3)`,
    [T, String(ref), new Date(t).toISOString()]);
}

/// What the manager's timesheet says about [ref] on [ymd].
async function day(ref, ymd) {
  const r = await call(managerTok, 'GET', `/api/admin/approvals?from=${ymd}&to=${ymd}`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const d = (r.json.data || []).find((x) => String(x.employeeRef) === String(ref));
  return d && { minutes: d.totalMinutes, flags: [...d.flags].sort(), needsFix: d.needsFix, integrity: d.integrity };
}

/// A phone running Eesa. [t] is real time; the phone's wall clock can be set
/// wrong, its stopwatch counts from its last boot, and its network, Location,
/// power and the app itself can each be switched off.
class Phone {
  constructor(ref, { stopwatchPunches = false, pushChecksLocation = false } = {}) {
    Object.assign(this, { ref, stopwatchPunches, pushChecksLocation });
    this.device = `iphone-${ref}:log1`;
    this.bootAt = 0;
    this.boot = 'boot-1';
    this.offset = 0;
    this.online = true;
    this.location = 'always';
    this.powered = true;
    this.running = true;
    this.waiting = null; // the last push APNs is holding for it
    this.seq = 0;
    this.prevHash = '';
    this.last = null;
    this.unsent = [];
    this.queue = [];
    this.seen = null;
  }

  async init() {
    this.tok = await token(this.ref, 'staff');
    return this;
  }

  wall(t) { return t + this.offset; }

  log(t, trigger, pos) {
    const fix = this.location === 'always' && pos ? pos : null;
    const mono = t - this.bootAt;
    const same = this.last ? this.last.boot === this.boot : null;
    const raw = {
      seq: ++this.seq, at: this.wall(t), trigger,
      lat: fix ? fix.lat : null, lng: fix ? fix.lng : null, accuracyM: fix ? 8 : null,
      simulated: fix ? Boolean(fix.simulated) : null,
      online: this.online, net: this.online ? 'wifi' : 'none', location: this.location,
      elapsedMs: same ? mono - this.last.mono : null, restarted: same == null ? null : !same,
    };
    const hash = entryDigest(this.prevHash, normalizeEntry(raw));
    this.unsent.push({ ...raw, prevHash: this.prevHash, hash, t, boot: this.boot });
    this.prevHash = hash;
    this.last = { mono, boot: this.boot };
  }

  async upload() {
    if (!this.online || !this.unsent.length) return;
    const entries = this.unsent.map(({ t, boot, ...e }) => ({
      ...e, ...(boot === this.boot ? { ageMs: Date.now() - t } : {}),
    }));
    const r = await call(this.tok, 'POST', '/api/presence', { deviceId: this.device, entries });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    this.unsent = [];
  }

  async punch(t, type, pos, source = 'geofence') {
    const fix = pos || WORK;
    this.queue.push({ t, boot: this.boot, path: type === 'check_in' ? '/api/checkIn' : '/api/checkOut', body: {
      zoneId, lat: fix.lat, lng: fix.lng, accuracyM: 8, source,
      clientAt: this.wall(t), clientId: `${this.ref}-${type}-${t}-${source}`,
    } });
    await this.flush();
  }

  async flush() {
    if (!this.online) return;
    while (this.queue.length) {
      const p = this.queue.shift();
      const ageMs = this.stopwatchPunches && p.boot === this.boot ? Date.now() - p.t : null;
      const r = await call(this.tok, 'POST', p.path, {
        ...p.body, sentAt: Date.now() + this.offset, ...(ageMs != null ? { ageMs } : {}),
      });
      assert.equal(r.status, 200, JSON.stringify(r.json));
    }
  }

  /// A crossing wakes Eesa even after it was swiped away.
  async cross(t, type, pos) {
    this.running = true;
    this.log(t, type === 'check_in' ? 'fence_in' : 'fence_out', pos);
    await this.punch(t, type, pos);
    await this.upload();
  }

  /// "Still here?" from the server. It reaches a phone that is on, online and
  /// not swiped away; otherwise APNs keeps the latest for when it can.
  async ask(t, pos) {
    await asked(this.ref, t);
    if (!this.powered || !this.running || !this.online) { this.waiting = t; return; }
    await this.answer(t + MIN, pos);
  }

  async answer(t, pos) {
    this.waiting = null;
    this.log(t, 'push', pos);
    if (this.pushChecksLocation) await this.watchLocation(t);
    await this.upload();
  }

  /// Opened by the person: the location check always runs (header refresh).
  async open(t, pos) {
    this.running = true;
    await this.watchLocation(t);
    this.log(t, 'app', pos);
    await this.flush();
    await this.upload();
  }

  /// location_watch.dart: say when the phone can no longer see a departure.
  async watchLocation(t) {
    const why = { off: 'services_off', denied: 'denied', while_in_use: 'while_in_use', approximate: 'approximate' };
    const reason = this.location === 'always' ? null : why[this.location];
    const last = this.seen;
    let report = null;
    if (reason == null) {
      if (!last || last.blind) report = { state: 'on' };
    } else if (!(last && last.blind)) {
      report = { state: 'off', reason, ...(last && last.lastOnAt ? { lastOnAt: this.wall(last.lastOnAt) } : {}) };
    }
    if (report && this.online) {
      const r = await call(this.tok, 'POST', '/api/locationState', {
        ...report, source: 'app', clientAt: this.wall(t), sentAt: Date.now() + this.offset, clientId: `loc-${this.ref}-${t}`,
      });
      assert.equal(r.status, 200, JSON.stringify(r.json));
    }
    this.seen = reason == null ? { blind: false, lastOnAt: t } : (last && last.blind ? last : { blind: true, lastOnAt: last ? last.lastOnAt : null });
  }

  async reconnect(t, pos) {
    this.online = true;
    await this.flush();
    await this.upload();
    if (this.waiting != null && this.powered && this.running) await this.answer(t, pos);
  }

  powerOff() { this.powered = false; this.running = false; }

  async powerOn(t, pos) {
    this.powered = true;
    this.running = true; // not swiped away: a push may launch it again
    this.bootAt = t;
    this.boot = `boot-${t}`;
    if (this.waiting != null && this.online) await this.answer(t + MIN, pos);
  }
}

/// The shift's "still here?" pushes, every 20 minutes from 9:20 to 16:40,
/// answered from wherever [where] says the phone is.
async function checks(phone, t0, where, hooks = {}) {
  for (let t = t0 + 20 * MIN; t < t0 + 8 * HOUR; t += 20 * MIN) {
    if (hooks[t - t0]) await hooks[t - t0](t);
    await phone.ask(t, where(t - t0));
  }
}

const at = (h, m = 0) => (h - 9) * HOUR + m * MIN; // offset from 9:00

describe('cheating attendance, end to end', { skip }, () => {
  const fixed = { stopwatchPunches: process.env.CHEATS_APP !== 'current', pushChecksLocation: process.env.CHEATS_APP !== 'current' };
  const seen = [];
  let server;
  let stubs = [];

  before(async () => {
    key = await generateKeyPair('ES256');
    const jwk = { ...(await exportJWK(key.publicKey)), kid: 'test', alg: 'ES256' };
    const jwks = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); });
    // A backend that knows nobody: the service must never reach the real one.
    const backend = http.createServer((req, res) => { res.statusCode = 404; res.end('{}'); });
    stubs = [jwks, backend];
    const [jwksPort, backendPort] = [await listen(jwks), await listen(backend)];
    const probe = http.createServer();
    const port = await listen(probe);
    await new Promise((r) => probe.close(r));
    Object.assign(process.env, {
      DATABASE_URL: URL_, PGSSL: process.env.PGSSL || 'disable', PORT: String(port),
      EESA_JWKS_URL: `http://127.0.0.1:${jwksPort}/jwks`, EESA_API_BASE: `http://127.0.0.1:${backendPort}/api/v1`,
      PLUGIN_GATEWAY_SECRET: '', PRESENCE_CHECKS: '',
    });
    base = `http://127.0.0.1:${port}`;
    db = await import('../src/db.js');
    await db.ensureSimplifyTables();
    for (const table of ['events', 'day_summaries', 'zones', 'tenant_settings', 'day_corrections', 'presence_log', 'presence_checks', 'presence_check_log', 'location_states']) {
      await db.pool.query(`delete from ${table} where tenant_id = $1`, [T]).catch(() => {});
    }
    await db.setTenantTimezone(T, TZ);
    zoneId = (await db.pool.query(
      `insert into zones (tenant_id, name, center_lat, center_lng, radius_m) values ($1, 'Chups Anaheim', $2, $3, 100) returning id`,
      [T, WORK.lat, WORK.lng],
    )).rows[0].id;
    await import('../src/server.js');
    for (let i = 0; i < 50; i++) {
      if ((await fetch(`${base}/health`).catch(() => null))?.ok) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    // Created on first use, as in production: a first read makes the tables.
    managerTok = await token('manager-1', 'admin');
    await call(managerTok, 'GET', `/api/admin/approvals?from=${daysAgo(1)}&to=${daysAgo(1)}`);
    checkLog = (await db.pool.query(`select to_regclass('presence_check_log') as t`)).rows[0].t != null;
  });

  after(async () => {
    console.log('\n' + ['scenario'.padEnd(46) + 'hours    flags → needs a look'].concat(seen).join('\n') + '\n');
    for (const s of stubs) s.close();
    if (db) await db.pool.end();
    setTimeout(() => process.exit(0), 50).unref();
  });

  /// Run one scenario on its own person and day, and remember what it showed.
  async function scenario(name, n, play) {
    const ymd = daysAgo(2 + (n % 5));
    const phone = await new Phone(String(100 + n), fixed).init();
    await play(phone, nineAm(ymd), ymd);
    const d = await day(phone.ref, ymd);
    seen.push(`${name.padEnd(46)}${d ? `${String(Math.floor(d.minutes / 60)).padStart(2)}h${String(d.minutes % 60).padStart(2, '0')}   ${d.flags.join(', ') || '—'}${d.needsFix ? '  → YES' : ''}` : 'no day'}`);
    return d;
  }

  test('an honest day raises nothing', async () => {
    const d = await scenario('honest day', 2, async (p, t0) => {
      await p.cross(t0, 'check_in', WORK);
      await checks(p, t0, () => WORK);
      await p.cross(t0 + 8 * HOUR, 'check_out', EDGE);
    });
    assert.deepEqual(d.flags, []);
    assert.equal(d.minutes, 480);
  });

  test('an hour of airplane mode at work is counted, and needs a look: it is what leaving looks like', async () => {
    const d = await scenario('airplane mode, stays at work', 3, async (p, t0) => {
      await p.cross(t0, 'check_in', WORK);
      await checks(p, t0, () => WORK, {
        [at(12)]: async () => { p.online = false; },
        [at(13)]: async (t) => { await p.reconnect(t, WORK); },
      });
      await p.cross(t0 + 8 * HOUR, 'check_out', EDGE);
    });
    assert.equal(d.minutes, 480);
    assert.ok(d.flags.includes('went_quiet'), JSON.stringify(d));
    assert.equal(d.needsFix, true);
  });

  test('airplane mode and leaving: the departure is kept offline and filed at its real time', async () => {
    const d = await scenario('airplane mode, leaves (exit fires)', 4, async (p, t0) => {
      await p.cross(t0, 'check_in', WORK);
      await checks(p, t0, (o) => (o >= at(12) && o < at(14) ? HOME : WORK), {
        [at(12)]: async (t) => { p.online = false; await p.cross(t + 5 * MIN, 'check_out', EDGE); },
        [at(14)]: async (t) => { await p.cross(t - 5 * MIN, 'check_in', WORK); await p.reconnect(t, WORK); },
      });
      await p.cross(t0 + 8 * HOUR, 'check_out', EDGE);
    });
    assert.equal(d.minutes, 480 - 110, 'the two hours out are not paid');
  });

  test('airplane mode and leaving when iOS never fires the exit: the silence needs a look', async () => {
    const d = await scenario('airplane mode, leaves (no exit fired)', 5, async (p, t0) => {
      await p.cross(t0, 'check_in', WORK);
      await checks(p, t0, (o) => (o >= at(12) && o < at(14) ? HOME : WORK), {
        [at(12)]: async () => { p.online = false; },
        [at(14)]: async (t) => { await p.reconnect(t, WORK); },
      });
      await p.cross(t0 + 8 * HOUR, 'check_out', EDGE);
    });
    assert.ok(d.flags.includes('went_quiet'), JSON.stringify(d));
    assert.equal(d.needsFix, true);
  });

  test('Location switched off to leave unseen is caught by the next "still here?"', async () => {
    const d = await scenario('Location off, leaves, turns it back on', 6, async (p, t0) => {
      await p.cross(t0, 'check_in', WORK);
      await checks(p, t0, (o) => (o >= at(12) && o < at(14) ? HOME : WORK), {
        [at(12)]: async () => { p.location = 'off'; },
        [at(14, 20)]: async () => { p.location = 'always'; },
      });
      await p.cross(t0 + 8 * HOUR, 'check_out', EDGE);
    });
    assert.ok(d.flags.includes('location_off'), JSON.stringify(d));
    assert.equal(d.needsFix, true);
  });

  test('"While using" set to stop the zones watching is caught the same way', async () => {
    const d = await scenario('Location set to While Using, leaves', 7, async (p, t0) => {
      await p.cross(t0, 'check_in', WORK);
      await checks(p, t0, (o) => (o >= at(12) && o < at(14) ? HOME : WORK), {
        [at(12)]: async () => { p.location = 'while_in_use'; },
        [at(14, 20)]: async () => { p.location = 'always'; },
      });
      await p.cross(t0 + 8 * HOUR, 'check_out', EDGE);
    });
    assert.ok(d.flags.includes('location_off'), JSON.stringify(d));
    assert.equal(d.needsFix, true);
  });

  test('Location off AND the app swiped away: the silence needs a look once it is opened again', async () => {
    const d = await scenario('Location off + app swiped away, leaves', 8, async (p, t0) => {
      await p.cross(t0, 'check_in', WORK);
      await checks(p, t0, (o) => (o >= at(12) && o < at(14) ? HOME : WORK), {
        [at(11, 40)]: async () => { p.running = false; p.location = 'off'; },
        [at(14, 20)]: async (t) => { p.location = 'always'; await p.open(t, WORK); },
      });
      await p.cross(t0 + 8 * HOUR, 'check_out', EDGE);
    });
    assert.ok(d.flags.includes('went_quiet'), JSON.stringify(d));
    assert.equal(d.needsFix, true);
  });

  test('the phone switched off to leave unseen needs a look', async () => {
    const d = await scenario('phone switched off, leaves, back on', 9, async (p, t0) => {
      await p.cross(t0, 'check_in', WORK);
      await checks(p, t0, () => WORK, {
        [at(12)]: async () => { p.powerOff(); },
        [at(14)]: async (t) => { await p.powerOn(t - 5 * MIN, WORK); },
      });
      await p.cross(t0 + 8 * HOUR, 'check_out', EDGE);
    });
    assert.ok(d.flags.includes('phone_off'), JSON.stringify(d));
    assert.equal(d.needsFix, true);
  });

  test('a restart for an update is not held against anyone', async () => {
    const d = await scenario('phone restarted for 5 minutes', 10, async (p, t0) => {
      await p.cross(t0, 'check_in', WORK);
      await checks(p, t0, () => WORK, {
        [at(11, 40)]: async () => { p.powerOff(); },
        [at(12)]: async (t) => { await p.powerOn(t - 15 * MIN, WORK); },
      });
      await p.cross(t0 + 8 * HOUR, 'check_out', EDGE);
    });
    assert.equal(d.needsFix, false, JSON.stringify(d));
    assert.equal(d.minutes, 480);
  });

  test('a clock set ahead offline and put back cannot stretch the day', async () => {
    const d = await scenario('clock set 5h ahead offline, put back', 11, async (p, t0) => {
      await p.cross(t0, 'check_in', WORK);
      await checks(p, t0, (o) => (o >= at(12) ? HOME : WORK), {
        [at(11, 40)]: async (t) => {
          p.online = false;
          p.offset = 5 * HOUR; // the phone now says 16:40
          await p.cross(t + 20 * MIN, 'check_out', EDGE); // left at 12:00; "17:00" on the phone
        },
        [at(16, 40)]: async () => { p.offset = 0; },
      });
      await p.reconnect(t0 + 8 * HOUR + 5 * MIN, HOME);
    });
    assert.equal(d.minutes, 180, 'paid until they left at 12:00');
    assert.ok(d.flags.includes('clock_changed'), JSON.stringify(d));
  });

  test('a location made by software is caught', async () => {
    const fake = { ...WORK, simulated: true };
    const d = await scenario('fake GPS from home', 12, async (p, t0) => {
      await p.cross(t0, 'check_in', fake);
      await checks(p, t0, () => fake);
      await p.cross(t0 + 8 * HOUR, 'check_out', { ...EDGE, simulated: true });
    });
    assert.ok(d.flags.includes('simulated'), JSON.stringify(d));
    assert.equal(d.needsFix, true);
  });

  test('entries deleted from the phone before sending show as a break', async () => {
    const d = await scenario('log entries deleted on the phone', 13, async (p, t0) => {
      await p.cross(t0, 'check_in', WORK);
      p.online = false;
      for (const o of [at(12), at(12, 30), at(13), at(13, 30)]) await p.open(t0 + o, o >= at(12, 30) && o <= at(13) ? HOME : WORK);
      p.unsent.splice(1, 2); // the two from home
      await p.reconnect(t0 + at(13, 40), WORK);
      await p.cross(t0 + 8 * HOUR, 'check_out', EDGE);
    });
    assert.ok(d.flags.includes('log_gap'), JSON.stringify(d));
    assert.equal(d.needsFix, true);
  });

  test('a second phone in the pocket gives the first one away', async () => {
    const d = await scenario('phone left at work, second phone carried', 14, async (p, t0) => {
      const pocket = await new Phone(p.ref, fixed).init();
      pocket.device = `iphone-${p.ref}-2:log1`;
      await p.cross(t0, 'check_in', WORK);
      for (let t = t0 + 20 * MIN; t < t0 + 8 * HOUR; t += 20 * MIN) {
        await p.ask(t, WORK);
        await pocket.answer(t + MIN, t - t0 >= at(12) && t - t0 < at(16) ? HOME : WORK);
      }
      await p.cross(t0 + 8 * HOUR, 'check_out', EDGE);
    });
    assert.ok(d.flags.includes('away'), JSON.stringify(d));
    assert.equal(d.needsFix, true);
  });

  test('punches sent from a laptop are given away by the phone answering from home', async () => {
    const d = await scenario('punches forged from a laptop, phone at home', 15, async (p, t0) => {
      const laptop = await new Phone(p.ref, fixed).init();
      await laptop.punch(t0, 'check_in', WORK, 'banner');
      await checks(p, t0, () => HOME);
      await laptop.punch(t0 + 8 * HOUR, 'check_out', WORK, 'banner');
    });
    assert.ok(d.flags.includes('away'), JSON.stringify(d));
    assert.equal(d.needsFix, true);
  });

  test('two check-ins a second apart are one arrival', async () => {
    const ymd = daysAgo(2);
    const t0 = nineAm(ymd);
    const p = await new Phone('116', fixed).init();
    const body = { zoneId, lat: WORK.lat, lng: WORK.lng, accuracyM: 5, clientAt: t0, sentAt: Date.now() };
    await Promise.all([
      call(p.tok, 'POST', '/api/checkIn', { ...body, source: 'geofence', clientId: 'fence' }),
      call(p.tok, 'POST', '/api/checkIn', { ...body, source: 'banner', clientAt: t0 + 1000, clientId: 'rescue' }),
    ]);
    const { rows } = await db.pool.query(
      `select count(*)::int n from events where tenant_id = $1 and employee_ref = '116' and type = 'check_in'`, [T]);
    seen.push(`${'two check-ins a second apart'.padEnd(46)}${rows[0].n} row${rows[0].n === 1 ? '' : 's'}`);
    assert.equal(rows[0].n, 1);
  });

  test('KNOWN LIMIT: the phone left at work while they go home', { todo: 'needs proof of the person, not the phone' }, async () => {
    const d = await scenario('phone left at work, nothing carried', 17, async (p, t0) => {
      await p.cross(t0, 'check_in', WORK);
      await checks(p, t0, () => WORK);
      await p.cross(t0 + 8 * HOUR, 'check_out', EDGE);
    });
    assert.equal(d.needsFix, true, 'the phone cannot know it was left behind');
  });

  test('KNOWN LIMIT: forged punches with the app swiped away all day', { todo: 'needs App Attest' }, async () => {
    const d = await scenario('punches forged, app swiped away', 18, async (p, t0) => {
      const laptop = await new Phone(p.ref, fixed).init();
      p.running = false;
      await laptop.punch(t0, 'check_in', WORK, 'banner');
      await checks(p, t0, () => HOME);
      await laptop.punch(t0 + 8 * HOUR, 'check_out', WORK, 'banner');
    });
    assert.equal(d.needsFix, true, 'only the silence says anything');
  });
});
