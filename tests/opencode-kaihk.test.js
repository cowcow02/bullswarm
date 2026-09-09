import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KAIHK_OPENCODE_MODEL,
  discoverKaihkProviders,
  expandOpenCodeKaihkConnectors,
  isKaihkBaseUrl,
  kaihkVariantsConfig,
  poolNameForKaihkProvider,
  retargetOpenCodeModel,
} from '../src/lib/opencode-kaihk.js';
import { parseKaihkUsage } from '../src/meters/kaihk.js';
import { resolveReasoningLevel, reasoningArgs } from '../src/lib/reasoning.js';
import { argvWithModel } from '../src/lib/watch.js';
import { rungsFor } from '../src/lib/strategy.js';

const baseConnector = JSON.parse(readFileSync(new URL('../connectors/opencode2.json', import.meta.url), 'utf8'));

test('KaiHK host detection and pool naming', () => {
  assert.equal(isKaihkBaseUrl('https://api.kaihk.com/v1'), true);
  assert.equal(isKaihkBaseUrl('https://api.openai.com/v1'), false);
  assert.equal(poolNameForKaihkProvider('kaihk', 0), 'opencode2');
  assert.equal(poolNameForKaihkProvider('kaihk-2', 1), 'opencode2:kaihk-2');
  assert.deepEqual(
    retargetOpenCodeModel(['opencode', 'run', '--model', 'kaihk/gpt-5.6-luna', '{taskFile}'], 'kaihk-2'),
    ['opencode', 'run', '--model', 'kaihk-2/gpt-5.6-luna', '{taskFile}'],
  );
  assert.deepEqual(
    retargetOpenCodeModel(['opencode', 'run', '--auto', '{taskFile}'], 'kaihk-2'),
    ['opencode', 'run', '--auto', '--model', 'kaihk-2/gpt-5.6-luna', '{taskFile}'],
  );
});

test('base OpenCode connector uses the installation default without KaiHK providers', () => {
  assert.equal(baseConnector.spawn.cmd.includes('--model'), false);
  assert.deepEqual(discoverKaihkProviders({ providers: [] }), []);
  const connectors = { opencode2: structuredClone(baseConnector) };
  expandOpenCodeKaihkConnectors(connectors, { providers: [] });
  assert.equal(connectors.opencode2.spawn.cmd.includes('--model'), false);
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
       spawn: { cmd: ['opencode', 'run', '--auto', '{taskFile}'] },
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

// --- reasoning: --variant + the injected opencode variants ------------------
// opencode drops `--variant` unless its CONFIG declares that variant for the
// model, so the connector's reasoning block is only true because the expansion
// injects the variants. Both halves are asserted here, against the REAL
// packaged connector, so neither can be changed without the other.

// The three providers the owner really has; no config file and no CLI is read.
const THREE_PROVIDERS = [
  { id: 'kaihk', pool: 'opencode2', command: 'opencode run --auto --model kaihk/gpt-5.6-luna', apiKey: 'sk-a' },
  { id: 'kaihk-2', pool: 'opencode2:kaihk-2', command: 'opencode run --auto --model kaihk-2/gpt-5.6-luna', apiKey: 'sk-b' },
  { id: 'kaihk-3', pool: 'opencode2:kaihk-3', command: 'opencode run --auto --model kaihk-3/gpt-5.6-luna', apiKey: 'sk-c' },
];

const expandPackaged = (opts = {}) => {
  const connectors = { opencode2: structuredClone(baseConnector), ...(opts.extra ?? {}) };
  if (opts.env) connectors.opencode2.env = opts.env;
  expandOpenCodeKaihkConnectors(connectors, { providers: opts.providers ?? THREE_PROVIDERS });
  return connectors;
};

test('kaihkVariantsConfig is the exact opencode config opencode merges over the file', () => {
  assert.equal(
    kaihkVariantsConfig('kaihk-2'),
    '{"provider":{"kaihk-2":{"models":{"gpt-5.6-luna":{"variants":{"low":{"reasoningEffort":"low"},'
    + '"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"},'
    + '"xhigh":{"reasoningEffort":"xhigh"},"max":{"reasoningEffort":"max"}}}}}}}',
  );
  // The variant names are exactly the levels the connector declares, so a
  // level the rung table offers can never be one opencode would drop.
  const variants = JSON.parse(kaihkVariantsConfig('kaihk'))
    .provider.kaihk.models[KAIHK_OPENCODE_MODEL].variants;
  assert.deepEqual(Object.keys(variants), baseConnector.reasoning.levels);
  for (const [level, spec] of Object.entries(variants)) {
    assert.deepEqual(spec, { reasoningEffort: level });
  }
  // The model is a parameter, not a constant baked into the string.
  assert.match(kaihkVariantsConfig('kaihk-3', 'gpt-5.6-sol'), /"models":\{"gpt-5\.6-sol"/);
});

test('every KaiHK pool carries the variants for its OWN provider id', () => {
  const connectors = expandPackaged();
  const pools = ['opencode2', 'opencode2:kaihk-2', 'opencode2:kaihk-3'];
  const contents = pools.map((pool) => connectors[pool].env.OPENCODE_CONFIG_CONTENT);
  // Three providers, three DISTINCT strings: a clone that kept the base's
  // string would declare variants on a provider it never calls.
  assert.equal(new Set(contents).size, 3);
  for (const [index, pool] of pools.entries()) {
    const providerId = THREE_PROVIDERS[index].id;
    assert.equal(contents[index], kaihkVariantsConfig(providerId), pool);
    const parsed = JSON.parse(contents[index]);
    assert.deepEqual(Object.keys(parsed.provider), [providerId]);
    assert.deepEqual(
      parsed.provider[providerId].models[KAIHK_OPENCODE_MODEL].variants.max,
      { reasoningEffort: 'max' },
    );
    // The injection is additive: the spawn model is still this pool's own.
    assert.ok(connectors[pool].spawn.cmd.includes(`${providerId}/${KAIHK_OPENCODE_MODEL}`));
  }
});

test('an OPENCODE_CONFIG_CONTENT the operator set by hand is never overwritten', () => {
  const operator = '{"provider":{"kaihk":{"models":{"gpt-5.6-luna":{"variants":{"max":{"reasoningEffort":"xhigh"}}}}}}}';
  const connectors = expandPackaged({ env: { OPENCODE_CONFIG_CONTENT: operator, OPENCODE_THEME: 'dark' } });
  // Base and clones alike: the operator's answer survives the expansion.
  for (const pool of ['opencode2', 'opencode2:kaihk-2', 'opencode2:kaihk-3']) {
    assert.equal(connectors[pool].env.OPENCODE_CONFIG_CONTENT, operator, pool);
    assert.equal(connectors[pool].env.OPENCODE_THEME, 'dark', pool);
  }
  // An empty value is not an answer, so it is filled in.
  const blank = expandPackaged({ env: { OPENCODE_CONFIG_CONTENT: '  ' } });
  assert.equal(blank['opencode2:kaihk-2'].env.OPENCODE_CONFIG_CONTENT, kaihkVariantsConfig('kaihk-2'));
  // Other env the connector already carries is merged, not replaced.
  const other = expandPackaged({ env: { HTTP_PROXY: 'http://localhost:8080' } });
  assert.equal(other['opencode2:kaihk-3'].env.HTTP_PROXY, 'http://localhost:8080');
  assert.equal(other['opencode2:kaihk-3'].env.OPENCODE_CONFIG_CONTENT, kaihkVariantsConfig('kaihk-3'));
});

test('the packaged opencode2 reasoning block says --variant and the five levels', () => {
  assert.deepEqual(baseConnector.reasoning, {
    flag: '--variant',
    levels: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaults: { high: 'high', medium: 'medium', low: 'low' },
  });
  // The block must name where its values came from AND why the flag works.
  assert.match(baseConnector['$comment-reasoning'], /verified 2026-09-09 against opencode 1\.18\.25/);
  assert.match(baseConnector['$comment-reasoning'], /OPENCODE_CONFIG_CONTENT/);
});

test('a medium/max dispatch on opencode2:kaihk-2 composes --variant max into the argv', () => {
  const connector = expandPackaged()['opencode2:kaihk-2'];
  const strategy = { reasoning: { tiers: {}, pools: { 'opencode2:kaihk-2': { medium: 'max' } } } };
  const model = 'kaihk-2/gpt-5.6-luna';
  const resolved = resolveReasoningLevel({ connector, tier: 'medium', model, strategy });
  assert.deepEqual(resolved, {
    requested: 'max', applied: 'max', source: 'strategy-pool', clamped: false,
  });
  assert.deepEqual(reasoningArgs(connector, resolved.applied), ['--variant', 'max']);

  const argv = argvWithModel(connector, { taskFile: '/tmp/task.md', cwd: '/repo' }, model, null, resolved);
  // The level lands after the positional task file, exactly where the shipped
  // event-stream flags already land — opencode's parser reads options either
  // side of the message.
  assert.deepEqual(argv, [
    'opencode', 'run', '--auto', '--model', 'kaihk-2/gpt-5.6-luna', '/tmp/task.md',
    '--variant', 'max', '--format', 'json',
  ]);
  console.log(`opencode2 medium/max argv: ${argv.join(' ')}`);

  // A level already pinned in the template is REPLACED, never duplicated.
  const pinned = structuredClone(connector);
  pinned.spawn.cmd = ['opencode', 'run', '--auto', '--variant', 'low', '{taskFile}'];
  const pinnedArgv = argvWithModel(pinned, { taskFile: '/tmp/task.md', cwd: '/repo' }, model, null, resolved);
  assert.equal(pinnedArgv.filter((arg) => arg === '--variant').length, 1);
  assert.deepEqual(pinnedArgv, [
    'opencode', 'run', '--auto', '--variant', 'max', '/tmp/task.md',
    '--model', 'kaihk-2/gpt-5.6-luna', '--format', 'json',
  ]);

  // The connector stops at max, so nothing on the common scale is clamped.
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const row = resolveReasoningLevel({
      connector, tier: 'medium', model,
      strategy: { reasoning: { pools: { 'opencode2:kaihk-2': { medium: level } } } },
    });
    assert.deepEqual([row.applied, row.clamped], [level, false], level);
  }
});

test('the opencode2 rung reports a real reasoning source instead of unsupported', () => {
  const connectors = expandPackaged();
  const pools = Object.keys(connectors).map((name) => ({
    name, enabled: true, connector: connectors[name],
  }));
  const rows = rungsFor({
    pools,
    strategy: {
      configuredTiers: ['medium'],
      modelTiers: { 'opencode2:kaihk-2': { 'kaihk-2/gpt-5.6-luna': ['medium'] } },
      reasoning: { tiers: {}, pools: { 'opencode2:kaihk-2': { medium: 'max' } } },
    },
  });
  const row = rows.find((r) => r.pool === 'opencode2:kaihk-2');
  assert.equal(row.model, 'kaihk-2/gpt-5.6-luna');
  assert.deepEqual(row.reasoning, {
    applied: 'max', source: 'strategy-pool', requested: 'max', clamped: false,
  });
  // Every other KaiHK pool falls back to the connector default for the tier,
  // which is a supported answer too — `unsupported` is gone from the table.
  for (const other of rows.filter((r) => r.pool !== 'opencode2:kaihk-2')) {
    assert.deepEqual(
      [other.reasoning.applied, other.reasoning.source],
      ['medium', 'connector'],
      other.pool,
    );
  }
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
