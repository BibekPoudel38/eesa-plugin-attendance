// A person's page — theirs, or a manager's view of it: Today, Yesterday and
// This Week are the tiles, and below them one date range, a month back by
// default. These run the PAGE'S OWN helpers, lifted out of public/app.html: a
// copy here could agree with itself while the page is wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const code = inline.join('\n');

test('the page script parses — a syntax error here is a blank Attendance page', () => {
  assert.ok(inline.length > 0, 'no inline script found');
  for (const c of inline) assert.doesNotThrow(() => new vm.Script(c));
});

const grab = (re) => {
  const m = code.match(re);
  assert.ok(m, `not found in app.html: ${re}`);
  return m[0];
};

// On 19 Sep 2026, in a week that began on Monday the 14th. Arrays made in
// here are copied out before comparing: they come from another realm.
const page = vm.createContext({
  todayTZ: () => '2026-09-19',
  weekRange: () => ['2026-09-14', '2026-09-20'],
});
vm.runInContext([
  grab(/const addDaysYmd = [^\n]*/),
  grab(/const ymdParts = [^\n]*/),
  grab(/const PERIODS = \{[\s\S]*?\n    \};/),
  grab(/const rangeOf = [^\n]*/),
  grab(/const monthBack = \(d\) => \{[\s\S]*?\n    \};/),
  grab(/const emptyNote = [\s\S]*?\);\n/),
  grab(/const openOnList = [^\n]*/),
  'Object.assign(this, { rangeOf, monthBack, emptyNote, openOnList });',
].join('\n'), page);

test('each tile is its own days', () => {
  assert.deepEqual([...page.rangeOf({ period: 'today' })], ['2026-09-19', '2026-09-19']);
  assert.deepEqual([...page.rangeOf({ period: 'yesterday' })], ['2026-09-18', '2026-09-18']);
  assert.deepEqual([...page.rangeOf({ period: 'week' })], ['2026-09-14', '2026-09-19']);
});

test('otherwise the dates picked below', () => {
  assert.deepEqual([...page.rangeOf({ period: 'custom', from: '2026-08-19', to: '2026-09-19' })],
    ['2026-08-19', '2026-09-19']);
});

test('the dates start a month back', () => {
  assert.equal(page.monthBack('2026-09-19'), '2026-08-19');
  assert.equal(page.monthBack('2026-01-15'), '2025-12-15');
});

test('a month back from a longer month lands on the shorter one’s last day', () => {
  assert.equal(page.monthBack('2026-03-31'), '2026-02-28');
  assert.equal(page.monthBack('2028-03-31'), '2028-02-29');
  assert.equal(page.monthBack('2026-05-31'), '2026-04-30');
});

test('Today and Yesterday open on that day’s check-ins and check-outs', () => {
  assert.equal(page.openOnList({ period: 'today', openDay: null }, '2026-09-19', '2026-09-19'), '2026-09-19');
  assert.equal(page.openOnList({ period: 'yesterday', openDay: null }, '2026-09-18', '2026-09-18'), '2026-09-18');
  // A week or a range opens only the day somebody opened.
  assert.equal(page.openOnList({ period: 'week', openDay: null }, '2026-09-14', '2026-09-19'), null);
  assert.equal(page.openOnList({ period: 'custom', openDay: '2026-09-02' }, '2026-08-19', '2026-09-19'), '2026-09-02');
});

test('an empty day says which day it was', () => {
  assert.equal(page.emptyNote({ period: 'today' }), 'Nothing recorded today.');
  assert.equal(page.emptyNote({ period: 'yesterday' }), 'Nothing recorded yesterday.');
  assert.equal(page.emptyNote({ period: 'custom' }), 'No hours on these dates.');
});
