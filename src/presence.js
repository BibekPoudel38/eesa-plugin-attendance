// What the phone saw while someone was on the clock, and what it gives away.
//
// The app keeps a log on the device while a shift is open: where the phone
// was, whether it had a network, how it was set, when it last restarted. It is
// written whenever Eesa runs — a crossing, the app opened, the check on home, a
// background refresh, a silent "still here?" push — and it is written OFFLINE
// too: GPS works in airplane mode, so a phone taken off the network still
// records where it went, and sends the lot when it is back.
//
// Nothing here changes anybody's hours. It finds the stretches a manager should
// look at, with the evidence, and says so. Phones die and signal drops for
// honest people too; the manager decides.
//
// Everything below is data in, data out, so the tests can hold it to account.

import { createHash } from 'node:crypto';

/// A reading worse than this says nothing about where somebody was.
export const MAX_USEFUL_ACCURACY_M = 150;
/// How far past a zone's edge a phone has to be before it counts as away. A
/// car park, the pavement, a fix that wandered — none of those is "away".
export const AWAY_MARGIN_M = 100;
/// A phone's wall clock and its stopwatch must agree. More than this apart,
/// somebody moved the clock.
///
/// The stopwatch is a clock that keeps counting while the phone sleeps and that
/// nobody can set. Apple allows only the time BETWEEN events to leave the phone,
/// so that is all it sends: [elapsedMs] since its previous entry, and at upload
/// [ageMs], how long ago each entry was written — which puts every entry on the
/// server's clock, whatever the phone's said. A clock moved forward in airplane
/// mode and back before the phone reconnected still shows.
export const CLOCK_JUMP_MS = 2 * 60 * 1000;

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const bool = (v) => (v === true || v === false ? v : null);
const text = (v, max = 40) => (v == null ? null : String(v).slice(0, max));
const ms = (v) => (num(v) == null ? null : Math.max(0, Math.trunc(num(v))));

/// One log entry as the phone sent it, cleaned. Null when it cannot be used —
/// no sequence number or no time is not an entry, it is noise.
export function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const seq = num(raw.seq);
  const at = num(raw.at);
  // Past 8.64e15 ms is no date at all (and no timestamp Postgres will take).
  if (seq == null || seq < 1 || at == null || at <= 0 || at >= 8.64e15) return null;
  const lat = num(raw.lat);
  const lng = num(raw.lng);
  const okFix = lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  return {
    seq: Math.trunc(seq),
    at: Math.trunc(at),
    elapsedMs: ms(raw.elapsedMs),
    restarted: bool(raw.restarted),
    ageMs: ms(raw.ageMs),
    lat: okFix ? lat : null,
    lng: okFix ? lng : null,
    accuracyM: okFix && num(raw.accuracyM) != null ? Math.max(0, num(raw.accuracyM)) : null,
    simulated: bool(raw.simulated),
    online: bool(raw.online),
    net: text(raw.net, 16),
    location: text(raw.location, 24),
    lowPower: bool(raw.lowPower),
    battery: num(raw.battery),
    trigger: text(raw.trigger, 24),
    prevHash: text(raw.prevHash, 64),
    hash: text(raw.hash, 64),
  };
}

/// The chain link the phone computed for an entry, recomputed here. The app
/// builds the same string with the same fixed decimals (presence_log.dart), so
/// an entry edited on the phone, or one dropped from the middle, shows up as a
/// break rather than as an ordinary day.
export function entryDigest(prevHash, e) {
  const f = (n, d) => (n == null || !Number.isFinite(Number(n)) ? '' : Number(n).toFixed(d));
  const b = (v) => (v == null ? '' : v ? '1' : '0');
  const s = [
    prevHash || '', e.seq, e.at, f(e.lat, 6), f(e.lng, 6), f(e.accuracyM, 1),
    b(e.simulated), b(e.online), e.net || '', e.location || '', f(e.elapsedMs, 0), b(e.restarted), e.trigger || '',
  ].join('|');
  return createHash('sha256').update(s).digest('hex');
}

/// Great-circle distance in metres.
export function metersBetween(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/// How far outside [zone] a reading puts the phone, or null when it does not.
export function metersOutside(e, zone) {
  if (!zone || e.lat == null || e.lng == null) return null;
  if (e.accuracyM == null || e.accuracyM > MAX_USEFUL_ACCURACY_M) return null;
  const past = metersBetween(e.lat, e.lng, zone.lat, zone.lng) - (Number(zone.radiusM) || 0);
  return past > Math.max(AWAY_MARGIN_M, 2 * e.accuracyM) ? Math.round(past) : null;
}

/// When an entry really happened: on the server's clock when the upload could
/// place it, otherwise as the phone's clock said.
const when = (e) => (e.serverAt != null ? e.serverAt : e.at);

/// Consecutive entries from one phone that disagree with each other: a hole in
/// the sequence, a link that does not match, a restart, or a moved clock.
function pairEvidence(a, b) {
  const out = [];
  const next = b.seq === a.seq + 1;
  if (!next || (b.prevHash && a.hash && b.prevHash !== a.hash)) {
    out.push({ flag: 'log_gap', at: when(b), missing: Math.max(0, b.seq - a.seq - 1) });
  }
  if (b.restarted === true) {
    // Switched off and on somewhere between the two.
    out.push({ flag: 'restarted', at: when(a), until: when(b) });
  } else if (next && b.elapsedMs != null && (a.serverAt == null || b.serverAt == null)) {
    // Only when the upload could not place both: then the entry check says it.
    const drift = (b.at - a.at) - b.elapsedMs;
    if (Math.abs(drift) > CLOCK_JUMP_MS) out.push({ flag: 'clock_changed', at: when(b), byMs: drift });
  }
  return out;
}

/// Runs of the same flag inside a shift become one stretch.
function mergeRuns(items, flag, gapMs) {
  const runs = [];
  for (const it of items) {
    const last = runs[runs.length - 1];
    if (last && it.at - last.until <= gapMs) {
      last.until = Math.max(last.until, it.until ?? it.at);
      if (it.meters != null) last.meters = Math.max(last.meters ?? 0, it.meters);
    } else {
      runs.push({ flag, at: it.at, until: it.until ?? it.at, ...(it.meters != null ? { meters: it.meters } : {}) });
    }
  }
  return runs;
}

/// Silence worth showing: this many "still here?" in a row unanswered, over at
/// least an hour.
export const SILENT_MIN_CHECKS = 3;
export const SILENT_MIN_MS = 60 * 60 * 1000;
/// A check is answered by any entry, from any of their phones, before the next
/// check or within this long of it — iOS can hold a push for minutes.
export const ANSWER_WINDOW_MS = 15 * 60 * 1000;

/// Stretches of a shift when the phone did not answer "still here?".
///
/// Honest phones go quiet too — swiped away all day, Background App Refresh
/// off — so silence on its own is only shown. Two shapes of it are more:
///   phone_off   the first sign of life after it says the phone had restarted:
///               it was switched off.
///   went_quiet  it was answering, stopped for an hour or more, then answered
///               again: airplane mode, Location off with Eesa closed, or Eesa
///               swiped away and opened again.
function silenceEvidence(spans, entries, checks) {
  const times = entries.map((e) => ({ t: when(e), e })).sort((a, b) => a.t - b.t);
  const out = [];
  for (const span of spans) {
    const asked = checks.filter((c) => c >= span.from && c <= span.to).sort((a, b) => a - b);
    let run = [];
    const close = () => {
      if (run.length >= SILENT_MIN_CHECKS) {
        const first = run[0];
        const next = times.find(({ t }) => t > run[run.length - 1] && t <= span.to);
        const until = next ? next.t : span.to;
        if (until - first >= SILENT_MIN_MS) {
          const before = times.some(({ t }) => t >= span.from && t < first);
          const flag = next && next.e.restarted === true ? 'phone_off' : before && next ? 'went_quiet' : 'silent';
          out.push({ flag, at: first, until, missed: run.length });
        }
      }
      run = [];
    };
    asked.forEach((c, i) => {
      const upTo = Math.max(c + ANSWER_WINDOW_MS, asked[i + 1] ?? 0);
      if (times.some(({ t }) => t >= c && t < upTo)) close();
      else run.push(c);
    });
    close();
  }
  return out;
}

/// The evidence a phone's log gives for one person's shifts.
///
/// [intervals]: [{from: Date|ms, to: Date|ms, zone: {name, lat, lng, radiusM}|null}]
/// [entries]:   normalized entries, any phones, any order.
/// [checks]:    when the server asked "still here?", epoch ms.
/// Returns [{flag, at, until?, meters?, zone?, missed?}] — only what falls in a shift.
export function presenceEvidence(intervals, entries, checks = []) {
  const spans = (intervals || []).map((iv) => ({
    from: +new Date(iv.from), to: +new Date(iv.to), zone: iv.zone || null,
  }));
  const within = (t) => spans.find((s) => t >= s.from && t <= s.to) || null;
  const byDevice = new Map();
  for (const e of entries || []) {
    const k = e.deviceId || '';
    if (!byDevice.has(k)) byDevice.set(k, []);
    byDevice.get(k).push(e);
  }
  const away = [];
  const offline = [];
  const single = [];
  for (const list of byDevice.values()) {
    list.sort((a, b) => a.seq - b.seq);
    let wasOff = null;
    for (let i = 0; i < list.length; i += 1) {
      const e = list[i];
      const t = when(e);
      const span = within(t);
      // How far the phone's clock was from the server's when it wrote this.
      const off = e.serverAt != null && Math.abs(e.at - e.serverAt) > CLOCK_JUMP_MS ? e.at - e.serverAt : null;
      if (span) {
        const m = metersOutside(e, span.zone);
        if (m != null) away.push({ at: t, meters: m, zone: span.zone && span.zone.name });
        if (e.online === false) {
          // Offline until the next reading that was back online.
          const back = list.slice(i + 1).find((n) => n.online !== false);
          offline.push({ at: t, until: Math.min(back ? when(back) : t, span.to) });
        }
        if (e.simulated === true) single.push({ flag: 'simulated', at: t });
        if (e.hash && e.hash !== entryDigest(e.prevHash, e)) single.push({ flag: 'log_gap', at: t, edited: true });
        // A clock set wrong is reported where it starts, not on every entry after.
        if (off != null && (wasOff == null || Math.abs(off - wasOff) > CLOCK_JUMP_MS)) {
          single.push({ flag: 'clock_changed', at: t, byMs: off });
        }
      }
      wasOff = off;
      if (i > 0) {
        for (const ev of pairEvidence(list[i - 1], e)) if (within(ev.at) || within(t)) single.push(ev);
      }
    }
  }
  away.sort((a, b) => a.at - b.at);
  offline.sort((a, b) => a.at - b.at);
  const silence = silenceEvidence(spans, entries || [], checks || []);
  // A switch-off is said once: the restart it ended with is the same event.
  const offUntil = new Set(silence.filter((x) => x.flag === 'phone_off').map((x) => x.until));
  const out = [
    ...mergeRuns(away, 'away', 20 * 60 * 1000).map((r) => ({ ...r, zone: away.find((a) => a.at === r.at)?.zone || null })),
    ...mergeRuns(offline, 'offline', 5 * 60 * 1000),
    ...single.filter((x) => !(x.flag === 'restarted' && offUntil.has(x.until))),
    ...silence,
  ];
  return out.sort((a, b) => a.at - b.at);
}

/// Evidence strong enough that a manager should not approve without looking.
/// Offline and restarted alone happen to honest phones every day; they are
/// shown, not held against anyone.
export const STRONG_FLAGS = new Set(['away', 'simulated', 'clock_changed', 'log_gap', 'phone_off', 'went_quiet']);
