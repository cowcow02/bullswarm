import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverKaihkProviders,
  expandOpenCodeKaihkConnectors,
  isKaihkBaseUrl,
  poolNameForKaihkProvider,
  retargetOpenCodeModel,
} from '../src/lib/opencode-kaihk.js';
import { parseKaihkUsage } from '../src/meters/kaihk.js';

test('KaiHK host detection and pool naming', () => {
  assert.equal(isKaihkBaseUrl('https://api.kaihk.com/v1'), true);
  assert.equal(isKaihkBaseUrl('https://api.openai.com/v1'), false);
  assert.equal(poolNameForKaihkProvider('kaihk', 0), 'opencode2');
  assert.equal(poolNameForKaihkProvider('kaihk-2', 1), 'opencode2:kaihk-2');
  assert.deepEqual(
    retargetOpenCodeModel(['opencode', 'run', '--model', 'kaihk/gpt-5.6-luna', '{taskFile}'], 'kaihk-2'),
    ['opencode', 'run', '--model', 'kaihk-2/gpt-5.6-luna', '{taskFile}'],
  );
});

test('discoverKaihkProviders reads OpenCode config, kaihk first', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-kaihk-'));
  const configPath = join(dir, 'opencode.json');
  try {
    writeFileSync(configPath, JSON.stringify({
      provider: {
        'kaihk-3': {
          options: { baseURL: 'https://api.kaihk.com/v1', apiKey: 'sk-cccc' },
        },
        bai: {
          options: { baseURL: 'https://api.b.ai/v1', apiKey: 'sk-bbbb' },
        },
        kaihk: {
          options: { baseURL: 'https://api.kaihk.com/v1', apiKey: 'sk-aaaa' },
        },
        'kaihk-2': {
          options: { baseURL: 'https://api.kaihk.com/v1', apiKey: 'sk-bbbb2' },
        },
      },
    }));
    const found = discoverKaihkProviders({ configPath });
    assert.deepEqual(found.map((p) => p.id), ['kaihk', 'kaihk-2', 'kaihk-3']);
    assert.deepEqual(found.map((p) => p.pool), ['opencode2', 'opencode2:kaihk-2', 'opencode2:kaihk-3']);
    assert.equal(found[1].command, 'opencode run --auto --model kaihk-2/gpt-5.6-luna');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('expandOpenCodeKaihkConnectors clones opencode2 per extra KaiHK provider', () => {
  const connectors = {
    opencode2: {
      name: 'opencode2',
      bin: 'opencode',
      spawn: { cmd: ['opencode', 'run', '--auto', '--model', 'kaihk/gpt-5.6-luna', '{taskFile}'] },
      flags: { stealth: false },
      meter: { type: 'none' },
    },
  };
  expandOpenCodeKaihkConnectors(connectors, {
    providers: [
      { id: 'kaihk', pool: 'opencode2', command: 'opencode run --auto --model kaihk/gpt-5.6-luna', apiKey: 'sk-a' },
      { id: 'kaihk-2', pool: 'opencode2:kaihk-2', command: 'opencode run --auto --model kaihk-2/gpt-5.6-luna', apiKey: 'sk-b' },
    ],
  });
  assert.equal(connectors.opencode2.spawn.cmd.includes('kaihk/gpt-5.6-luna'), true);
  const extra = connectors['opencode2:kaihk-2'];
  assert.ok(extra);
  assert.equal(extra.name, 'opencode2:kaihk-2');
  assert.equal(extra.spawn.cmd.includes('kaihk-2/gpt-5.6-luna'), true);
  assert.equal(extra.flags.isCaller, false);
  assert.equal(extra.profile.providerId, 'kaihk-2');
});

test('parseKaihkUsage converts billing hundredths-of-a-dollar and token quota units', () => {
  const snap = parseKaihkUsage({
    token: {
      data: {
        expires_at: 1790752330,
        name: 'Staging',
        total_used: 479,
        unlimited_quota: true,
      },
    },
    billingUsage: { total_usage: 0.0958 },
    billingSub: { access_until: 1790752330 },
    pool: 'opencode2:kaihk-2',
    includedUsd: 50,
  });
  assert.equal(snap.pool, 'opencode2:kaihk-2');
  assert.equal(snap.used_usd, 0.000958);
  assert.equal(snap.unlimited_quota, true);
  assert.ok(snap.monthly.utilization < 0.01);
  assert.equal(snap.monthly.resets_at, new Date(1790752330 * 1000).toISOString());
});
