// What a manager reads about a day the phone's log flagged. Runs the PAGE'S OWN
// helpers, lifted out of public/app.html: a copy here could agree with itself
// while the page is wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { STRONG_FLAGS } from '../src/presence.js';

const html = readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');

const grab = (re) => {
  const m = code.match(re);
  assert.ok(m, `not found in app.html: ${re}`);
  return m[0];
};

const page = vm.createContext({ Date, Math, Number, String, Set, TZ: 'America/Los_Angeles' });
vm.runInContext([
  grab(/const dur = \(m\) => \{[\s\S]*?\n    \};/),
  grab(/const timeOf = [\s\S]*?: '—';/),
  grab(/const metres = [^\n]*/),
  grab(/const FLAG_TEXT = \{[\s\S]*?\n    \};/),
  grab(/const PROOF = \{[\s\S]*?\n    \};/),
  grab(/const proofSpan = [^\n]*/),
  grab(/const offSpan = [^\n]*/),
  grab(/const SEVERITY = [^\n]*/),
  grab(/const bySeverity = [^\n]*/),
  grab(/const SHORT_FLAG = [^\n]*/),
  grab(/const whyLine = \(d\) => \{[\s\S]*?\n    \};/),
  grab(/const concern = \(d\) => \{[\s\S]*?\n    \};/),
  grab(/const byConcern = [^\n]*/),
  grab(/const JUST_SHOWN = [^\n]*/),
  grab(/const fixLabel = \(d\) => \{[\s\S]*?\n    \};/),
  'Object.assign(this, { FLAG_TEXT, PROOF, proofSpan, fixLabel, whyLine, byConcern });',
].join('\n'), page);

const sub = (e) => page.PROOF[e.flag].sub(e);

test('every flag the phone\'s log can raise has words on the page', () => {
  for (const f of [...STRONG_FLAGS, 'offline', 'restarted', 'silent']) {
    assert.ok(page.FLAG_TEXT[f], `no explanation for ${f}`);
    assert.ok(page.PROOF[f], `no evidence line for ${f}`);
  }
});

test('a day with one kind of problem is named by it', () => {
  assert.equal(page.fixLabel({ flags: ['away'] }), 'Away from the zone');
  assert.equal(page.fixLabel({ flags: ['simulated'] }), 'Location not from GPS');
  assert.equal(page.fixLabel({ flags: ['location_off'] }), 'Location off', 'the old label is kept');
});

test('no network, a restart or no answer never names a day on its own', () => {
  assert.equal(page.fixLabel({ flags: ['away', 'offline'] }), 'Away from the zone');
  assert.equal(page.fixLabel({ flags: ['location_off', 'restarted'] }), 'Location off');
  assert.equal(page.fixLabel({ flags: ['phone_off', 'silent'] }), 'Phone switched off');
});

test('silence says how many checks went unanswered', () => {
  assert.equal(sub({ flag: 'phone_off', missed: 6 }), '6 checks unanswered, then restarted');
  assert.equal(sub({ flag: 'went_quiet', missed: 3 }), '3 checks unanswered, then answered again');
});

test('two different problems read as "Needs a fix"', () => {
  assert.equal(page.fixLabel({ flags: ['away', 'no_check_out'] }), 'Needs a fix');
  assert.equal(page.fixLabel({ flags: ['no_check_out'] }), 'Needs a fix');
});

test('the evidence says how far, from where, and when', () => {
  assert.equal(sub({ flag: 'away', meters: 1400, zone: 'Chups Anaheim' }), '1.4 km from Chups Anaheim');
  assert.equal(sub({ flag: 'away', meters: 320 }), '320 m from the zone');
  const at = '2026-09-23T21:40:00Z';
  assert.equal(page.proofSpan({ at, until: at }), page.proofSpan({ at }), 'one moment is one time');
  assert.match(page.proofSpan({ at, until: '2026-09-23T22:10:00Z' }), /02:40 PM – 03:10 PM/);
});

test('a moved clock says which way and by how much', () => {
  assert.equal(sub({ flag: 'clock_changed', byMs: 30 * 60000 }), 'Moved 30m ahead by hand');
  assert.equal(sub({ flag: 'clock_changed', byMs: -90 * 60000 }), 'Moved 1h 30m back by hand');
});

test('a broken log says whether entries went missing or were changed', () => {
  assert.equal(sub({ flag: 'log_gap', edited: true }), 'An entry was changed on the phone');
  assert.equal(sub({ flag: 'log_gap', missing: 1 }), '1 entry missing');
  assert.equal(sub({ flag: 'log_gap', missing: 3 }), '3 entries missing');
  assert.equal(sub({ flag: 'log_gap', missing: 0 }), 'The log does not join up');
});

// Today lists the days to fix, each with why in one line.
const at = (h, m = 0) => `2026-09-22T${String(h + 7).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`; // PDT → UTC

test('a day to fix says its most serious reason first, with when', () => {
  const d = { day: '2026-09-22', flags: ['offline', 'went_quiet', 'phone_off'], integrity: [
    { flag: 'went_quiet', at: at(15), until: at(16), missed: 3 },
    { flag: 'phone_off', at: at(12), until: at(13, 56), missed: 6 },
    { flag: 'offline', at: at(11), until: at(11, 20) },
  ] };
  assert.equal(page.whyLine(d), 'Phone switched off 12:00 PM – 01:56 PM · 1 more',
    'switched off before stopped answering; no network is never the headline');
});

test('several stretches of the same thing are one problem, not several', () => {
  const d = { day: '2026-09-22', flags: ['away'], integrity: [
    { flag: 'away', at: at(12), until: at(12, 40), meters: 1400 },
    { flag: 'away', at: at(15), until: at(15, 30), meters: 900 },
  ] };
  assert.equal(page.whyLine(d), 'Away from the zone 12:00 PM – 12:40 PM');
});

test('a day with only an old-style flag still says what it is', () => {
  assert.equal(page.whyLine({ day: '2026-09-22', flags: ['no_check_out'] }), 'No check-out');
});

test('the most serious days come first, then the newest', () => {
  const days = [
    { day: '2026-09-23', flags: ['no_check_out'] },
    { day: '2026-09-21', flags: ['clock_changed'], integrity: [{ flag: 'clock_changed', at: at(12) }] },
    { day: '2026-09-22', flags: ['away'], integrity: [{ flag: 'away', at: at(12), meters: 900 }] },
    { day: '2026-09-23', flags: ['location_off'], locationOff: [{ from: at(12), to: at(13) }] },
  ];
  assert.deepEqual([...days].sort(page.byConcern).map((d) => d.day),
    ['2026-09-22', '2026-09-21', '2026-09-23', '2026-09-23']);
  assert.deepEqual([...days].sort(page.byConcern).map((d) => d.flags[0]),
    ['away', 'clock_changed', 'location_off', 'no_check_out']);
});

