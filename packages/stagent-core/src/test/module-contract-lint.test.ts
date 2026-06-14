import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveModuleExports } from '../commitment/decisionArtifactsSchema';
import {
  lintImplExportsAgainstModuleContract,
  lintTestCrossModulePatchTargetsAgainstContracts,
  lintTestImportsAgainstModuleContract,
  lintTestPatchTargetsAgainstModuleContract,
} from '../python-contract/ModuleContractLint';
import type { WorkflowInstance } from '../WorkflowDefinition';

test('resolveModuleExports prefers slice over global', () => {
  const slice = { version: 1 as const, files: [], modules: [{ name: 'signals', exports: ['compute'] }] };
  const global = {
    version: 1 as const,
    files: [],
    modules: [{ name: 'signals', exports: ['other'] }],
  };
  assert.deepEqual(resolveModuleExports('signals', slice, global), ['compute']);
});

test('resolveModuleExports falls back to global when slice empty', () => {
  const global = {
    version: 1 as const,
    files: [],
    modules: [{ name: 'signals', exports: ['alpha'] }],
  };
  assert.deepEqual(resolveModuleExports('signals', { version: 1, files: [], modules: [] }, global), [
    'alpha',
  ]);
});

test('resolveModuleExports uses slice decisionRecord before global fallback', () => {
  const global = {
    version: 1 as const,
    files: [],
    modules: [{ name: 'indicators', exports: ['compute'] }],
  };
  const record = '导出函数**：compute_ma, compute_boll';
  assert.deepEqual(
    resolveModuleExports('indicators', { version: 1, files: [], modules: [] }, global, record),
    ['compute_boll', 'compute_ma'],
  );
});

test('lintTestImportsAgainstModuleContract blocks undeclared symbol', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-contract-'));
  const testPath = 'tests/test_signals.py';
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, testPath),
    'from signals import compute\n\ndef test_x():\n    assert compute() == 1\n',
  );
  const artifacts = {
    version: 1 as const,
    files: [],
    modules: [{ name: 'signals', exports: ['run'] }],
  };
  const issue = lintTestImportsAgainstModuleContract({
    workspaceRoot: dir,
    testRelPath: testPath,
    semantic: 'signals',
    sliceArtifacts: artifacts,
    globalArtifacts: null,
  });
  assert.ok(issue);
  assert.equal(issue?.code, 'python-module-contract-violation');
  assert.equal(issue?.symbol, 'compute');
});

test('lintTestImportsAgainstModuleContract allows conventional main entry symbol absent from contract (T6)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-contract-main-'));
  const testPath = 'tests/test_main.py';
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, testPath),
    'from main import main\n\ndef test_runs():\n    main("config.yaml")\n',
  );
  // 契约只声明了编排符号，没列入口 main —— 测试导入约定入口 main 不应被拦。
  const artifacts = {
    version: 1 as const,
    files: [],
    modules: [{ name: 'main', exports: ['run_pipeline'] }],
  };
  const issue = lintTestImportsAgainstModuleContract({
    workspaceRoot: dir,
    testRelPath: testPath,
    semantic: 'main',
    sliceArtifacts: artifacts,
    globalArtifacts: null,
  });
  assert.equal(issue, null);
});

test('lintTestImportsAgainstModuleContract blocks from __init__ instead of slice module', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-contract-'));
  const testPath = 'tests/test_indicators.py';
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, testPath),
    'from __init__ import compute_ma, compute_boll\n',
  );
  const artifacts = {
    version: 1 as const,
    files: [],
    modules: [{ name: 'indicators', exports: ['compute_ma', 'compute_boll'] }],
  };
  const issue = lintTestImportsAgainstModuleContract({
    workspaceRoot: dir,
    testRelPath: testPath,
    semantic: 'indicators',
    sliceArtifacts: artifacts,
    globalArtifacts: null,
  });
  assert.ok(issue);
  assert.equal(issue?.code, 'python-test-slice-import-module-mismatch');
  assert.match(issue?.message ?? '', /from indicators import/);
});

test('lintTestImportsAgainstModuleContract blocks other wrong project module names', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-contract-'));
  const testPath = 'tests/test_indicators.py';
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, testPath), 'from signals import run\n');
  const artifacts = {
    version: 1 as const,
    files: [],
    modules: [{ name: 'indicators', exports: ['compute_ma'] }],
  };
  const issue = lintTestImportsAgainstModuleContract({
    workspaceRoot: dir,
    testRelPath: testPath,
    semantic: 'indicators',
    sliceArtifacts: artifacts,
    globalArtifacts: null,
  });
  assert.ok(issue);
  assert.equal(issue?.code, 'python-test-slice-import-module-mismatch');
});

test('lintTestImportsAgainstModuleContract passes declared symbol', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-contract-'));
  const testPath = 'tests/test_signals.py';
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, testPath), 'from signals import compute\n');
  const artifacts = {
    version: 1 as const,
    files: [],
    modules: [{ name: 'signals', exports: ['compute'] }],
  };
  const issue = lintTestImportsAgainstModuleContract({
    workspaceRoot: dir,
    testRelPath: testPath,
    semantic: 'signals',
    sliceArtifacts: artifacts,
    globalArtifacts: null,
  });
  assert.equal(issue, null);
});

test('resolveModuleExports 将 main 切片误写的 mode 规范为 main（Run #38）', () => {
  const slice = {
    version: 1 as const,
    files: [],
    modules: [{ name: 'main', exports: ['mode'] }],
  };
  assert.deepEqual(resolveModuleExports('main', slice, null), ['main']);
});

test('lintTestPatchTargetsAgainstModuleContract blocks patch main.SimBroker（Run #38）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-contract-'));
  const testPath = 'tests/test_main.py';
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, testPath),
    'from main import main\nfrom unittest.mock import patch\n\ndef test_x():\n    with patch("main.SimBroker"):\n        pass\n',
  );
  const artifacts = {
    version: 1 as const,
    files: [],
    modules: [{ name: 'main', exports: ['mode'] }],
  };
  const issue = lintTestPatchTargetsAgainstModuleContract({
    workspaceRoot: dir,
    testRelPath: testPath,
    semantic: 'main',
    sliceArtifacts: artifacts,
    globalArtifacts: null,
  });
  assert.ok(issue);
  assert.equal(issue?.code, 'python-test-patch-undeclared-export');
  assert.equal(issue?.symbol, 'SimBroker');
});

test('lintTestCrossModulePatchTargetsAgainstContracts blocks patch indicators.compute_indicators（Run #41）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-patch-'));
  const testPath = 'tests/test_signals.py';
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, testPath),
    'from signals import generate_signals\n\ndef test_x(mocker):\n    mocker.patch("indicators.compute_indicators", return_value=None)\n',
  );
  const instance = {
    definition: { stages: [], meta: { taskType: 'software' } },
    stageRuntimes: [
      {
        stageId: 'stage_decide_indicators',
        outputs: {
          decisionArtifacts: {
            version: 1,
            files: [],
            modules: [
              {
                name: 'indicators',
                exports: ['compute_ma', 'compute_boll', 'compute_vol', 'compute_macd', 'compute_cci'],
              },
            ],
          },
        },
      },
      {
        stageId: 'stage_decide_architecture_overview',
        outputs: {
          decisionArtifacts: {
            version: 1,
            files: [],
            modules: [{ name: 'indicators', exports: ['compute_indicators'] }],
          },
        },
      },
    ],
  } as unknown as WorkflowInstance;
  const issue = lintTestCrossModulePatchTargetsAgainstContracts({
    workspaceRoot: dir,
    testRelPath: testPath,
    instance,
  });
  assert.ok(issue);
  assert.equal(issue?.symbol, 'compute_indicators');
  assert.match(issue?.message ?? '', /compute_ma/);
});

test('lintImplExportsAgainstModuleContract tolerates main CLI entry `main` not in contract（Run #56）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'impl-main-entry-'));
  const implPath = 'main.py';
  fs.writeFileSync(
    path.join(dir, implPath),
    'def run_trading_loop(config):\n    return None\n\n\ndef main():\n    run_trading_loop({})\n',
  );
  const slice = {
    version: 1 as const,
    files: [],
    modules: [{ name: 'main', exports: ['run_trading_loop'] }],
  };
  const issue = lintImplExportsAgainstModuleContract({
    workspaceRoot: dir,
    implRelPath: implPath,
    semantic: 'main',
    sliceArtifacts: slice,
    globalArtifacts: null,
  });
  assert.equal(issue, null);
});

test('lintImplExportsAgainstModuleContract still blocks non-entry extra export on main', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'impl-main-extra-'));
  const implPath = 'main.py';
  fs.writeFileSync(
    path.join(dir, implPath),
    'def run_trading_loop(config):\n    return None\n\n\ndef SimBroker():\n    return None\n',
  );
  const slice = {
    version: 1 as const,
    files: [],
    modules: [{ name: 'main', exports: ['run_trading_loop'] }],
  };
  const issue = lintImplExportsAgainstModuleContract({
    workspaceRoot: dir,
    implRelPath: implPath,
    semantic: 'main',
    sliceArtifacts: slice,
    globalArtifacts: null,
  });
  assert.ok(issue);
  assert.equal(issue?.code, 'python-impl-export-extra');
  assert.equal(issue?.symbol, 'SimBroker');
});
