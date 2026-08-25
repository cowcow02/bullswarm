import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  suggestRoutingTable,
  applyIntegrationBlock,
  integrationBlockPresent,
  autoSetup,
  discoverConnectors,
} from '../src/setup.js';

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'bullswarm-setup-'));
  return { d, cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

test('routing table suggestion covers lanes from enabled pools', () => {
  const t = suggestRoutingTable([
    { name: 'codex', lanes: ['analyze', 'build', 'chore'] },
    { name: 'grok', lanes: ['build', 'chore'] },
    { name: 'command-code', lanes: ['build', 'chore'] },
  ]);
  assert.deepEqual(t.analyze.order, ['codex']); // command-code cannot serve analyze
  assert.ok(t.build.order.includes('grok'));
  assert.equal(t.chore.fallback, 'caller');
});

test('discovery flags echo as a test fixture', () => {
  const echo = discoverConnectors().find((d) => d.name === 'echo');
  assert.equal(echo.testFixture, true);
  // its bin is "node", so it is always "discovered" — the fixture flag is the
  // only thing keeping it out of the enabled set.
  assert.equal(echo.discovered, true);
});

test('autoSetup never enables the echo test fixture', () => {
  // echo-worker.mjs returns canned completion prose without reading the repo,
  // and that text passes every verify gate. If setup enables it, it can win a
  // real lane and report fabricated success.
  const { d, cleanup } = tmp();
  try {
    autoSetup(d, { reason: 'test' });
    const state = JSON.parse(readFileSync(join(d, 'state.json'), 'utf8'));
    assert.notEqual(state.pools?.echo?.enabled, true);
  } finally {
    cleanup();
  }
});

test('integration block: approval required, idempotent markers', () => {
  const { d, cleanup } = tmp();
  try {
    const file = join(d, 'CLAUDE.md');
    writeFileSync(file, '# My config\n\nexisting content\n');

    const denied = applyIntegrationBlock(file, { approved: false });
    assert.equal(denied.changed, false);

    applyIntegrationBlock(file, { approved: true });
    let text = readFileSync(file, 'utf8');
    assert.match(text, /bullswarm:begin v1/);
    assert.match(text, /existing content/); // preserved

    // idempotent re-run: no duplicate blocks
    const before = (text.match(/bullswarm:begin/g) ?? []).length;
    void before;
    applyIntegrationBlock(file, { approved: false }); // present -> skip
    // force re-check through the public API:
    assert.equal(integrationBlockPresent(file), true);

    // manual double-apply must not duplicate either
    applyIntegrationBlock(file, { approved: true });
    text = readFileSync(file, 'utf8');
    const count = (text.match(/bullswarm:begin v1/g) ?? []).length;
    // second approved apply strips the old block first — exactly one remains
    assert.equal(count, 1);
    assert.match(text, /existing content/);
  } finally {
    cleanup();
  }
});

test('integration block creates parent dirs for new AGENTS.md', () => {
  const { d, cleanup } = tmp();
  try {
    const file = join(d, 'sub', 'AGENTS.md');
    applyIntegrationBlock(file, { approved: true });
    assert.equal(existsSync(file), true);
    assert.match(readFileSync(file, 'utf8'), /bullswarm:begin v1/);
  } finally {
    cleanup();
  }
});
