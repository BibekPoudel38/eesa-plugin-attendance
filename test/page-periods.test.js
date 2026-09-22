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
  grab(/const openOnList = \(S, from, to\) => \{[\s\S]*?\n    \};/),
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
});

test('a list that reaches today opens today, untouched', () => {
  // The default view is a month back to today, and today is the row anyone
  // opening this screen came to read.
  assert.equal(page.openOnList({ period: 'custom', openDay: null }, '2026-08-19', '2026-09-19'), '2026-09-19');
  assert.equal(page.openOnList({ period: 'week', openDay: null }, '2026-09-14', '2026-09-19'), '2026-09-19');
});

test('dates that end before today open nothing', () => {
  assert.equal(page.openOnList({ period: 'custom', openDay: null }, '2026-08-01', '2026-08-31'), null);
});

test('the day somebody opened stays open', () => {
  assert.equal(page.openOnList({ period: 'custom', openDay: '2026-09-02' }, '2026-08-19', '2026-09-19'), '2026-09-02');
});

test('an empty day says which day it was', () => {
  assert.equal(page.emptyNote({ period: 'today' }), 'Nothing recorded today.');
  assert.equal(page.emptyNote({ period: 'yesterday' }), 'Nothing recorded yesterday.');
  assert.equal(page.emptyNote({ period: 'custom' }), 'No hours on these dates.');
});

// The Today screen: three tiles, and the tile showing is the list below it.
// Everyone enrolled belongs to exactly one of them, or somebody is invisible
// on the one screen a manager checks in the morning.
const today = vm.createContext({});
vm.runInContext([
  grab(/const isReason = [^\n]*/),
  grab(/const stateOf = [\s\S]*?'absent'\);/),
  grab(/const TODAY_GROUPS = \[[\s\S]*?\n    \];/),
  grab(/const todayGroup = [\s\S]*?\n    \}\);/),
  'Object.assign(this, { TODAY_GROUPS, todayGroup, stateOf });',
].join('\n'), today);

const PEOPLE = [
  { name: 'working', checkedIn: true, at: '2026-09-19T16:20:00Z' },
  { name: 'out on an errand', checkedIn: false, reason: 'Outside work', at: '2026-09-19T18:00:00Z' },
  { name: 'here but not working', checkedIn: false, reason: 'Not for work', at: '2026-09-19T15:00:00Z' },
  { name: 'finished', checkedIn: false, at: '2026-09-19T23:00:00Z' },
  { name: 'never came in', checkedIn: false, at: null },
];

test('at work covers everyone on the clock, however they are marked', () => {
  const names = today.todayGroup('in', PEOPLE).map((p) => p.name);
  assert.deepEqual([...names], ['working', 'out on an errand', 'here but not working']);
});

test('finished and not in are their own', () => {
  assert.deepEqual([...today.todayGroup('done', PEOPLE).map((p) => p.name)], ['finished']);
  assert.deepEqual([...today.todayGroup('absent', PEOPLE).map((p) => p.name)], ['never came in']);
});

test('everybody is in exactly one group', () => {
  const counted = today.TODAY_GROUPS
    .map(([key]) => today.todayGroup(key, PEOPLE).length)
    .reduce((a, b) => a + b, 0);
  assert.equal(counted, PEOPLE.length);
});
