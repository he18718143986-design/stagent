import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildBehaviorSpecDecidePromptSuffix,
  buildBehaviorSpecFixHints,
  buildBehaviorSpecPromptSuffix,
  validateBehaviorSpecForSemantic,
  BEHAVIOR_SPEC_SLICE_SUFFIX,
  parseDecisionArtifactsFromText,
} from '../commitment';
import { lintTestAgainstBehaviorSpec } from '../commitment/BehaviorSpecLint';
import type { Stage } from '../WorkflowDefinition';
import { DECISION_ARTIFACTS_OUTPUT_KEY } from '../WorkflowOutputKeys';

const SAMPLE_SPEC = {
  module: 'signals',
  functions: [
    {
      name: 'generate_bear_signal',
      returns: 'Signal | None',
      when_non_null: 'all' as const,
      conditions: [
        { id: 'ma_convergence', desc: 'MA5..MA9 spread < spread_threshold (strict <)' },
        { id: 'cci_cross_down', desc: 'CCI cross down band' },
      ],
    },
  ],
  edge_rules: ['Threshold comparisons use strict < unless noted.'],
  fixture_hints: ['typical_bear_indicators_ok must satisfy all condition ids.'],
};

test('validateBehaviorSpecForSemantic requires spec for signals', () => {
  const violations = validateBehaviorSpecForSemantic('signals', undefined);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].code, 'missing-behavior-spec');
});

test('validateBehaviorSpecForSemantic passes healthy signals spec', () => {
  const violations = validateBehaviorSpecForSemantic('signals', SAMPLE_SPEC, [
    'generate_bear_signal',
  ]);
  assert.equal(violations.length, 0);
});

test('validateBehaviorSpecForSemantic rejects behaviorSpec function missing from exports（Run #63）', () => {
  const spec = {
    ...SAMPLE_SPEC,
    functions: [
      ...SAMPLE_SPEC.functions,
      {
        name: 'generate_long_signal',
        returns: 'bool',
        when_non_null: 'all' as const,
        conditions: [{ id: 'ma_convergence', desc: 'x' }],
      },
    ],
  };
  const violations = validateBehaviorSpecForSemantic('signals', spec, ['generate_bear_signal']);
  assert.ok(violations.some((v) => v.code === 'function-not-in-exports'));
});

test('lintTestAgainstBehaviorSpec skips functions not in contractExports（Run #63）', () => {
  const spec = {
    module: 'signals',
    functions: [
      {
        name: 'generate_short_signal',
        returns: 'bool',
        when_non_null: 'all' as const,
        conditions: [{ id: 'ma_convergence', desc: 'x' }],
      },
      {
        name: 'generate_long_signal',
        returns: 'bool',
        when_non_null: 'all' as const,
        conditions: [{ id: 'cci_second_cross_up', desc: 'y' }],
      },
    ],
    edge_rules: [],
  };
  const testOnlyShort = 'from signals import generate_short_signal\ndef test_x():\n  # ma_convergence\n  generate_short_signal({}, {})\n';
  const issues = lintTestAgainstBehaviorSpec(testOnlyShort, spec, {
    contractExports: ['generate_short_signal', 'DataFrames'],
  });
  assert.equal(issues.length, 0);
});

test('validateBehaviorSpecForSemantic optional for non-required slice', () => {
  assert.equal(validateBehaviorSpecForSemantic('indicators', undefined).length, 0);
});

test('parseDecisionArtifactsFromText warns when signals missing behaviorSpec', () => {
  const text = `### 职责边界
signals
<!-- decisionArtifacts:json -->
{"version":1,"files":[],"modules":[{"name":"signals","exports":["generate_bear_signal"]}]}`;
  const parsed = parseDecisionArtifactsFromText(text, { semantic: 'signals' });
  assert.ok(parsed.artifacts);
  assert.ok(parsed.warnings.some((w) => w.includes('behaviorSpec')));
});

test('buildBehaviorSpecPromptSuffix injects conditions for test_write', () => {
  const stage: Stage = {
    id: 'stage_test_write_signals',
    title: 't',
    description: 'd',
    tool: 'llm-text',
    toolConfig: { type: 'llm-text', systemPrompt: '' },
    dependsOn: [],
    input: { sources: [], mergeStrategy: 'concat' },
    outputs: [],
    pauseAfter: false,
  };
  const runtimes = [
    {
      stageId: 'stage_decide_signals',
      status: 'done' as const,
      retryCount: 0,
      outputs: {
        [DECISION_ARTIFACTS_OUTPUT_KEY]: {
          version: 1,
          files: [],
          modules: [{ name: 'signals', exports: ['generate_bear_signal'] }],
          behaviorSpec: SAMPLE_SPEC,
        },
      },
    },
  ];
  const suffix = buildBehaviorSpecPromptSuffix(runtimes, stage, 'test_write');
  assert.ok(suffix);
  assert.match(suffix!, /ma_convergence/);
  assert.match(suffix!, /edge_rules/);
  assert.match(suffix!, /test_write/);
});

test('buildBehaviorSpecFixHints prefers spec over散文补丁', () => {
  const runtimes = [
    {
      stageId: 'stage_decide_signals',
      status: 'done' as const,
      retryCount: 0,
      outputs: {
        [DECISION_ARTIFACTS_OUTPUT_KEY]: {
          version: 1,
          files: [],
          behaviorSpec: SAMPLE_SPEC,
        },
      },
    },
  ];
  const hints = buildBehaviorSpecFixHints(runtimes, 'signals');
  assert.ok(hints.some((h) => h.includes('ma_convergence')));
});

test('BEHAVIOR_SPEC_SLICE_SUFFIX documents JSON shape', () => {
  assert.match(BEHAVIOR_SPEC_SLICE_SUFFIX, /behaviorSpec/);
  assert.match(BEHAVIOR_SPEC_SLICE_SUFFIX, /when_non_null/);
});

test('buildBehaviorSpecDecidePromptSuffix appends when semantic fill stripped suffix', () => {
  const suffix = buildBehaviorSpecDecidePromptSuffix(
    'stage_decide_signals',
    '你正在决策模块 signals，无 behaviorSpec 提示',
  );
  assert.ok(suffix);
  assert.match(suffix!, /behaviorSpec/);
});

test('buildBehaviorSpecDecidePromptSuffix skips when prompt already has behaviorSpec', () => {
  const suffix = buildBehaviorSpecDecidePromptSuffix(
    'stage_decide_signals',
    '须含 decisionArtifacts.behaviorSpec',
  );
  assert.equal(suffix, undefined);
});
