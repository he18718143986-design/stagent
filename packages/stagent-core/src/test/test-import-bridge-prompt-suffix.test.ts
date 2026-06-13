import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Stage, WorkflowDefinition } from '../WorkflowDefinition';
import {
  buildFixTestGreenBridgePromptSuffix,
  buildIntegrationApiBridgePromptSuffix,
  buildTestGreenBridgePromptSuffix,
  buildTestRewriteImplBridgePromptSuffix,
  extractProjectImportLinesFromPythonTest,
  extractPublicPythonSignatures,
  readTestRunFailureExcerpt,
} from '../stage-runners/llm-persist/testImportBridgePromptSuffix';

function llmStage(id: string, file: string): Stage {
  return {
    id,
    title: id,
    tool: 'llm-text',
    toolConfig: { type: 'llm-text', systemPrompt: 'x', writeOutputToFile: file },
    input: { sources: [], mergeStrategy: 'concat' },
    outputs: [{ key: 'out', format: 'text' }],
    pauseAfter: false,
  };
}

const baseMeta = {
  title: 't',
  taskType: 'software' as const,
  userInput: 'x',
  createdAt: '2026-01-01T00:00:00.000Z',
};

test('extractProjectImportLinesFromPythonTest keeps slice semantic imports only', () => {
  const content = [
    'import pytest',
    'from indicators import compute_ma, compute_boll',
    'import numpy as np',
  ].join('\n');
  const lines = extractProjectImportLinesFromPythonTest(content, 'indicators');
  assert.deepEqual(lines, ['from indicators import compute_ma, compute_boll']);
});

test('buildTestGreenBridgePromptSuffix injects full test file for impl', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'));
  const testRel = 'tests/test_indicators.py';
  const testAbs = path.join(root, testRel);
  fs.mkdirSync(path.dirname(testAbs), { recursive: true });
  fs.writeFileSync(
    testAbs,
    [
      'from indicators import compute_ma, compute_boll',
      '',
      'def test_ma():',
      '    assert compute_ma([1, 2, 3], 2) == 2.0',
    ].join('\n'),
    'utf8',
  );

  const wf: WorkflowDefinition = {
    id: 'wf',
    version: '2.0',
    meta: baseMeta,
    stages: [
      llmStage('stage_test_write_indicators', testRel),
      llmStage('stage_impl_indicators', 'indicators/__init__.py'),
    ],
  };
  const suffix = buildTestGreenBridgePromptSuffix(wf, wf.stages[1]!, root);
  assert.ok(suffix?.includes('行为桥接'));
  assert.ok(suffix?.includes('from indicators import compute_ma, compute_boll'));
  assert.ok(suffix?.includes('def test_ma():'));
  assert.ok(suffix?.includes('indicators/__init__.py'));
});

test('buildFixTestGreenBridgePromptSuffix includes pytest failure excerpt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-fix-'));
  const testRel = 'tests/test_indicators.py';
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, testRel), 'def test_x():\n    assert 1 == 2\n', 'utf8');
  const wf: WorkflowDefinition = {
    id: 'wf',
    version: '2.0',
    meta: baseMeta,
    stages: [llmStage('stage_test_write_indicators', testRel)],
  };
  const suffix = buildFixTestGreenBridgePromptSuffix(wf, 'indicators', root, {
    stageId: 'stage_test_run_indicators',
    status: 'error',
    outputs: {
      _exitCode: 1,
      stdout: 'FAILED tests/test_indicators.py::test_x - AssertionError',
      verifyOut: 'FAILED tests/test_indicators.py::test_x - AssertionError',
    },
    retryCount: 0,
  });
  assert.ok(suffix?.includes('def test_x():'));
  assert.ok(suffix?.includes('AssertionError'));
});

test('buildTestRewriteImplBridgePromptSuffix 注入实现源码 + 当前测试 + 失败输出（Run #24 根治）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-testfix-'));
  const testRel = 'tests/test_broker.py';
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(
    path.join(root, testRel),
    'from broker import SimBroker\n\ndef test_init():\n    b = SimBroker(initial_cash=100000)\n',
    'utf8',
  );
  fs.mkdirSync(path.join(root, 'broker'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'broker', '__init__.py'),
    'class SimBroker:\n    def __init__(self, cash=100000.0):\n        self.cash = cash\n',
    'utf8',
  );
  const wf: WorkflowDefinition = {
    id: 'wf',
    version: '2.0',
    meta: baseMeta,
    stages: [
      llmStage('stage_test_write_broker', testRel),
      llmStage('stage_impl_broker', 'broker/__init__.py'),
    ],
  };
  const suffix = buildTestRewriteImplBridgePromptSuffix(wf, 'broker', root, {
    stageId: 'stage_test_run_broker',
    status: 'error',
    outputs: { _exitCode: 1, stdout: "TypeError: __init__() got an unexpected keyword argument 'initial_cash'" },
    retryCount: 0,
  });
  // 实现源码全文（真实签名）必须在场
  assert.ok(suffix?.includes('def __init__(self, cash=100000.0):'));
  // 当前测试 + 失败输出
  assert.ok(suffix?.includes('SimBroker(initial_cash=100000)'));
  assert.ok(suffix?.includes('unexpected keyword argument'));
  // 禁止虚构 API 的指令
  assert.ok(suffix?.includes('禁止虚构'));
});

test('buildTestRewriteImplBridgePromptSuffix 实现文件缺失 → undefined', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-testfix-miss-'));
  const wf: WorkflowDefinition = {
    id: 'wf',
    version: '2.0',
    meta: baseMeta,
    stages: [llmStage('stage_impl_broker', 'broker/__init__.py')],
  };
  assert.equal(buildTestRewriteImplBridgePromptSuffix(wf, 'broker', root, undefined), undefined);
});

test('extractPublicPythonSignatures captures top-level def/class + __init__', () => {
  const src = [
    'import pandas as pd',
    'class SimBroker:',
    '    def __init__(self):',
    '        self.x = 1',
    '    def place_order(self, order):',
    '        return order',
    '    def _private(self):',
    '        pass',
    'def compute_ma(df, window):',
    '    return df',
    'def _helper():',
    '    pass',
  ].join('\n');
  const sigs = extractPublicPythonSignatures(src);
  assert.ok(sigs.some((s) => s.includes('class SimBroker')));
  assert.ok(sigs.some((s) => s.includes('def __init__(self):')));
  assert.ok(sigs.some((s) => s.includes('def place_order(self, order):')));
  assert.ok(sigs.some((s) => s.includes('def compute_ma(df, window):')));
  assert.ok(!sigs.some((s) => s.includes('_private')));
  assert.ok(!sigs.some((s) => s.includes('_helper')));
});

test('buildIntegrationApiBridgePromptSuffix injects peer signatures for main（Run #57）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-integration-'));
  fs.mkdirSync(path.join(root, 'broker'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'broker/__init__.py'),
    'class SimBroker:\n    def __init__(self):\n        pass\n',
  );
  const wf: WorkflowDefinition = {
    id: 'wf',
    version: '2.0',
    meta: baseMeta,
    stages: [
      llmStage('stage_impl_broker', 'broker/__init__.py'),
      llmStage('stage_impl_main', 'main.py'),
    ],
  };
  const suffix = buildIntegrationApiBridgePromptSuffix(wf, 'main', root);
  assert.ok(suffix?.includes('真实 API 签名'));
  assert.ok(suffix?.includes('class SimBroker'));
  assert.ok(suffix?.includes('def __init__(self):'));
  // 非 main 切片不注入
  assert.equal(buildIntegrationApiBridgePromptSuffix(wf, 'broker', root), undefined);
});

test('extractPublicPythonSignatures keeps type-annotated def params（Run #63）', () => {
  const src = [
    'class SimBroker:',
    '    def __init__(self, cash: float = 100000.0):',
    '        self.cash = cash',
  ].join('\n');
  const sigs = extractPublicPythonSignatures(src);
  assert.ok(sigs.some((s) => s.includes('def __init__(self, cash: float = 100000.0):')));
});

test('buildIntegrationApiBridgePromptSuffix at main test_write sees broker impl on disk（Run #63）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-main-testwrite-'));
  fs.mkdirSync(path.join(root, 'broker'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'broker/__init__.py'),
    'class SimBroker:\n    def __init__(self, cash: float = 100000.0):\n        self.cash = cash\n',
  );
  const wf: WorkflowDefinition = {
    id: 'wf',
    version: '2.0',
    meta: baseMeta,
    stages: [
      llmStage('stage_impl_broker', 'broker/__init__.py'),
      llmStage('stage_test_write_main', 'tests/test_main.py'),
      llmStage('stage_impl_main', 'main.py'),
    ],
  };
  const suffix = buildIntegrationApiBridgePromptSuffix(wf, 'main', root);
  assert.ok(suffix?.includes('def __init__(self, cash: float = 100000.0):'));
  assert.ok(suffix?.includes('禁止臆造参数'));
});

test('readTestRunFailureExcerpt prefers verifyOut over empty stdout', () => {
  const excerpt = readTestRunFailureExcerpt({
    stageId: 'stage_test_run_x',
    status: 'error',
    outputs: { verifyOut: 'E   assert 1 == 2' },
    retryCount: 0,
  });
  assert.match(excerpt ?? '', /assert 1 == 2/);
});
