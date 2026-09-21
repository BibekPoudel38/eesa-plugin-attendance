// A day's punches read newest first. Reported 21 Sep 2026 from a phone: a day
// with three shifts opened on the 9:47 AM arrival, so the shift someone had
// just finished was last. Runs the PAGE'S OWN helper, lifted out of app.html.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');

const grab = (re) => {
  const m = code.match(re);
  assert.ok(m, `not found in app.html: ${re}`);
  return m[0];
};

const page = vm.createContext({ Date });
vm.runInContext(
  [grab(/const latestFirst = [^\n]*/), 'Object.assign(this, { latestFirst });'].join('\n'),
  page,
);

const at = (t) => ({ id: t, at: `2026-09-20T${t}:00.000Z` });
const times = (evs) => evs.map((e) => e.id);

test('the latest punch comes first', () => {
  const out = page.latestFirst([at('09:47'), at('11:44'), at('13:16')]);
  assert.deepEqual([...times(out)], ['13:16', '11:44', '09:47']);
});

test('a list the server already sent newest-first is left alone', () => {
  // Both endpoints order by `at desc`. The page used to reverse that, which is
  // exactly how the oldest ended up on top.
  const out = page.latestFirst([at('13:16'), at('11:44'), at('09:47')]);
  assert.deepEqual([...times(out)], ['13:16', '11:44', '09:47']);
});

test('the day with three shifts from the report reads bottom-up', () => {
  const out = page.latestFirst(
    ['09:47', '09:48', '09:48', '11:44', '11:51', '13:16'].map((t, i) => ({
      id: `${t}#${i}`, at: `2026-09-20T${t}:00.000Z`,
    })),
  );
  assert.equal(out[0].id.startsWith('13:16'), true, 'the last check-out is first');
  assert.equal(out[out.length - 1].id.startsWith('09:47'), true, 'the first arrival is last');
});

test('it does not mutate what it was given', () => {
  const evs = [at('09:47'), at('13:16')];
  page.latestFirst(evs);
  assert.deepEqual([...times(evs)], ['09:47', '13:16']);
});
