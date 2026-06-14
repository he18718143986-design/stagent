/**
 * T4 Run #26 根治回归：config.yaml 落盘 → 隐式 pyyaml；import yaml 别名合法。
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildDeclaredDependenciesPromptSuffix,
  collectDeclaredDependenciesFromInstance,
  inferImplicitDependenciesFromArtifacts,
  isDeclaredImportRoot,
  toPipInstallableDependencies,
} from '../commitment/decisionArtifactsSchema';
import { lintDeclaredDependenciesInFiles } from '../python-contract/PythonDeclaredDependenciesLint';
import { DECISION_ARTIFACTS_OUTPUT_KEY } from '../WorkflowOutputKeys';

test('inferImplicitDependenciesFromArtifacts：config.yaml → 仅 pyyaml（非 pip 包名 yaml）', () => {
  const deps = inferImplicitDependenciesFromArtifacts({
    version: 1,
    files: [{ key: 'configContent', path: 'config.yaml', format: 'yaml', content: 'k: v' }],
  });
  assert.deepEqual(deps, ['pyyaml']);
});

test('isDeclaredImportRoot：pyyaml 已声明时 import yaml 合法', () => {
  assert.equal(isDeclaredImportRoot('yaml', ['pytest', 'numpy', 'pandas', 'pyyaml']), true);
  assert.equal(isDeclaredImportRoot('yaml', ['pytest', 'numpy', 'pandas']), false);
});

test('collectDeclaredDependenciesFromInstance 剔除标准库（csv/json/datetime）不进 requirements（T6 run8）', () => {
  const deps = collectDeclaredDependenciesFromInstance(
    [
      {
        stageId: 'stage_decide_pipeline',
        outputs: {
          [DECISION_ARTIFACTS_OUTPUT_KEY]: {
            version: 1,
            files: [],
            dependencies: ['pandas', 'csv', 'json', 'datetime', 'pyyaml'],
          },
        },
      },
    ],
    DECISION_ARTIFACTS_OUTPUT_KEY,
  );
  assert.equal(deps.includes('csv'), false);
  assert.equal(deps.includes('json'), false);
  assert.equal(deps.includes('datetime'), false);
  assert.equal(deps.includes('pandas'), true);
  assert.equal(deps.includes('pyyaml'), true);
});

test('toPipInstallableDependencies 跳过标准库名', () => {
  const pkgs = toPipInstallableDependencies(['pandas', 'csv', 'json', 'yaml', 'pyyaml']);
  assert.equal(pkgs.includes('csv'), false);
  assert.equal(pkgs.includes('json'), false);
  assert.equal(pkgs.includes('yaml'), false); // import 别名
  assert.equal(pkgs.includes('pandas'), true);
  assert.equal(pkgs.includes('pyyaml'), true);
});

test('collectDeclaredDependenciesFromInstance 合并隐式 pyyaml（global decide 含 config.yaml）', () => {
  const deps = collectDeclaredDependenciesFromInstance(
    [
      {
        stageId: 'stage_decide_architecture_overview',
        outputs: {
          [DECISION_ARTIFACTS_OUTPUT_KEY]: {
            version: 1,
            files: [{ key: 'configContent', path: 'config.yaml', format: 'yaml', content: 'x: 1' }],
            modules: [{ name: 'main', exports: ['run'] }],
          },
        },
      },
    ],
    DECISION_ARTIFACTS_OUTPUT_KEY,
  );
  assert.ok(deps.includes('pyyaml'));
});

test('lintDeclaredDependenciesInFiles：config.yaml 场景下 import yaml 不报错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decl-deps-'));
  const rel = 'tests/test_main.py';
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), 'import yaml\nfrom main import run\n', 'utf8');
  const issues = lintDeclaredDependenciesInFiles({
    workspaceRoot: dir,
    pyFiles: [rel],
    allowedDeps: collectDeclaredDependenciesFromInstance(
      [
        {
          stageId: 'stage_decide_architecture_overview',
          outputs: {
            [DECISION_ARTIFACTS_OUTPUT_KEY]: {
              version: 1,
              files: [{ key: 'c', path: 'config.yaml', format: 'yaml', content: '' }],
            },
          },
        },
      ],
      DECISION_ARTIFACTS_OUTPUT_KEY,
    ),
    projectModuleNames: ['main', 'indicators'],
  });
  assert.equal(issues.length, 0);
});

test('collectDeclaredDependenciesFromInstance 过滤 decide 误声明的 talib（Run #37）', () => {
  const deps = collectDeclaredDependenciesFromInstance(
    [
      {
        stageId: 'stage_decide_signals',
        outputs: {
          decisionArtifacts: {
            dependencies: ['numpy', 'pandas', 'talib', 'pytest'],
          },
        },
      },
    ],
    'decisionArtifacts',
  );
  assert.ok(!deps.includes('talib'));
  assert.ok(deps.includes('numpy'));
});

test('pruneUndeclaredRequirements 始终剔除 blocked pip 包（即使误在 allowed 中）', () => {
  const { pruneUndeclaredRequirements } = require('../python-contract/requirementsMerge') as typeof import('../python-contract/requirementsMerge');
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blocked-'));
  fs.writeFileSync(path.join(dir, 'requirements.txt'), 'pytest\ntalib\nnumpy\n', 'utf8');
  const { removed } = pruneUndeclaredRequirements(dir, ['pytest', 'numpy', 'pandas', 'talib']);
  assert.deepEqual(removed, ['talib']);
});

test('pruneUndeclaredRequirements 移除 fix 链误写的未声明包（Run #34 talib）', () => {
  const { pruneUndeclaredRequirements } = require('../python-contract/requirementsMerge') as typeof import('../python-contract/requirementsMerge');
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'req-prune-'));
  fs.writeFileSync(path.join(dir, 'requirements.txt'), 'pytest\nnumpy\ntalib\n', 'utf8');
  const { removed } = pruneUndeclaredRequirements(dir, ['pytest', 'numpy', 'pandas', 'pyyaml']);
  assert.deepEqual(removed, ['talib']);
  const body = fs.readFileSync(path.join(dir, 'requirements.txt'), 'utf8');
  assert.ok(!body.includes('talib'));
  assert.ok(body.includes('pytest'));
});

test('lintDeclaredDependenciesInFiles 放行 __future__（Run #36 误报）', () => {
  const { lintDeclaredDependenciesInFiles } = require('../python-contract/PythonDeclaredDependenciesLint') as typeof import('../python-contract/PythonDeclaredDependenciesLint');
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'future-'));
  const brokerDir = path.join(dir, 'broker');
  fs.mkdirSync(brokerDir, { recursive: true });
  fs.writeFileSync(path.join(brokerDir, '__init__.py'), 'from __future__ import annotations\n', 'utf8');
  const issues = lintDeclaredDependenciesInFiles({
    workspaceRoot: dir,
    pyFiles: ['broker/__init__.py'],
    allowedDeps: ['pytest', 'numpy'],
    projectModuleNames: ['broker'],
  });
  assert.equal(issues.length, 0);
});

test('toPipInstallableDependencies 排除 import 别名 yaml', () => {
  const pip = toPipInstallableDependencies(['pytest', 'pyyaml', 'yaml', 'numpy']);
  assert.ok(pip.includes('pyyaml'));
  assert.ok(!pip.includes('yaml'));
});

test('buildDeclaredDependenciesPromptSuffix 含依赖列表', () => {
  const suffix = buildDeclaredDependenciesPromptSuffix(
    [
      {
        stageId: 'stage_decide_architecture_overview',
        outputs: {
          [DECISION_ARTIFACTS_OUTPUT_KEY]: {
            version: 1,
            files: [{ key: 'c', path: 'config.yaml', format: 'yaml', content: '' }],
            dependencies: ['requests'],
          },
        },
      },
    ],
    DECISION_ARTIFACTS_OUTPUT_KEY,
  );
  assert.ok(suffix?.includes('pyyaml'));
  assert.ok(suffix?.includes('requests'));
  assert.ok(suffix?.includes('第三方依赖 SSOT'));
});
