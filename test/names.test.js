// A manager cannot approve a number.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { nameMapOf, withNames, UNKNOWN_NAME } from '../src/names.js';

describe('who a row is about', () => {
  const roster = [
    { id: 36, name: 'Chups Admin', email: 'chupy@admin.com' },
    { id: 39, name: '', email: 'jeeva@chupy.com' },
    { id: 78, name: '   ', email: '' },
  ];

  test('a nameless roster entry falls back to the email, not the id', () => {
    const m = nameMapOf(roster);
    assert.equal(m.get('39'), 'jeeva@chupy.com');
  });

  test('an entry with neither is left out rather than mapped to blank', () => {
    assert.equal(nameMapOf(roster).has('78'), false);
  });

  test('ids are strings on both sides — 36 and "36" are the same person', () => {
    // The roster sends a number and day_summaries stores text. A Map keyed by
    // one and looked up by the other misses every single time, silently.
    assert.equal(nameMapOf(roster).get('36'), 'Chups Admin');
  });

  test('the row a manager sees says a name, never an employee ref', () => {
    const rows = [{ employeeRef: '36', name: '', totalMinutes: 112 }];
    assert.equal(withNames(rows, nameMapOf(roster))[0].name, 'Chups Admin');
  });

  test('a name the plugin already has wins — an admin typed it', () => {
    const rows = [{ employeeRef: '36', name: 'Chups (kitchen)' }];
    assert.equal(withNames(rows, nameMapOf(roster))[0].name, 'Chups (kitchen)');
  });

  test('when nothing anywhere knows, it says so in words', () => {
    const rows = [{ employeeRef: '999', name: '' }];
    assert.equal(withNames(rows, nameMapOf(roster))[0].name, UNKNOWN_NAME);
    assert.equal(withNames(rows, nameMapOf(roster))[0].name.includes("999"), false);
  });

  test('an unreachable roster degrades to the old behaviour, not a crash', () => {
    const rows = [{ employeeRef: '36', name: 'Chups Admin' }];
    assert.equal(withNames(rows, nameMapOf(null))[0].name, 'Chups Admin');
    assert.deepEqual(withNames(undefined, new Map()), []);
  });
});
