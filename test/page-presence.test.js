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
  grab(/const fixLabel = \(d\) => \{[\s\S]*?\n    \};/),
  'Object.assign(this, { FLAG_TEXT, PROOF, proofSpan, fixLabel });',
].join('\n'), page);

const sub = (e) => page.PROOF[e.flag].sub(e);

test('every flag the phone\'s log can raise has words on the page', () => {
  for (const f of [...STRONG_FLAGS, 'offline', 'restarted']) {
    assert.ok(page.FLAG_TEXT[f], `no explanation for ${f}`);
    assert.ok(page.PROOF[f], `no evidence line for ${f}`);
  }
});

test('a day with one kind of problem is named by it', () => {
  assert.equal(page.fixLabel({ flags: ['away'] }), 'Away from the zone');
  assert.equal(page.fixLabel({ flags: ['simulated'] }), 'Location not from GPS');
  assert.equal(page.fixLabel({ flags: ['location_off'] }), 'Location off', 'the old label is kept');
});

test('no network or a restart never names a day on its own', () => {
  assert.equal(page.fixLabel({ flags: ['away', 'offline'] }), 'Away from the zone');
  assert.equal(page.fixLabel({ flags: ['location_off', 'restarted'] }), 'Location off');
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
