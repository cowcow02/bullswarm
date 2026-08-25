import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/cli.js';

test('boolean flag before another flag does not swallow it', () => {
  const a = parseArgs(['--no-caller', '--add-dir', '/tmp/x']);
  assert.equal(a['no-caller'], true);
  assert.equal(a['add-dir'], '/tmp/x');
});

test('boolean flag mid-command still reads as true', () => {
  // The regression: --no-caller only worked as the final argument, so
  // `callerEligible: opts['no-caller'] !== true` stayed true and the caller
  // pool kept winning the lane.
  const a = parseArgs(['--lane', 'chore', '--no-caller', '--task-file', '/tmp/t.md', '--json']);
  assert.equal(a.lane, 'chore');
  assert.equal(a['no-caller'], true);
  assert.equal(a['task-file'], '/tmp/t.md');
  assert.equal(a.json, true);
});

test('every boolean flag is true, never the next token', () => {
  for (const flag of ['json', 'no-caller', 'force', 'dry-run', 'yes']) {
    const a = parseArgs([`--${flag}`, '--lane', 'build']);
    assert.equal(a[flag], true, `--${flag} should be true`);
    assert.equal(a.lane, 'build', `--${flag} should not eat --lane`);
  }
});

test('boolean flag does not consume a positional task argument', () => {
  const a = parseArgs(['--lane', 'chore', '--no-caller', 'do', 'the', 'thing']);
  assert.equal(a['no-caller'], true);
  assert.deepEqual(a.rest, ['do', 'the', 'thing']);
});

test('value flags still take the next token', () => {
  const a = parseArgs(['--lane', 'analyze', '--timeout', '180']);
  assert.equal(a.lane, 'analyze');
  assert.equal(a.timeout, '180');
});

test('unknown trailing flag falls back to true', () => {
  assert.equal(parseArgs(['--verbose']).verbose, true);
});

test('positionals collect into rest', () => {
  assert.deepEqual(parseArgs(['run', 'a', '--lane', 'chore', 'b']).rest, ['run', 'a', 'b']);
});
