import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { lintImplExportsAgainstModuleContract } from '../python-contract/ModuleContractLint';
import {
  extractExportedSymbols,
  extractModuleLevelConstants,
  extractImportedNames,
  lintPythonExportContractFromPaths,
} from '../python-contract/PythonExportContractLint';

const MACD_WITH_NESTED_EMA = `import pandas as pd

def compute_ma(df: pd.DataFrame) -> pd.DataFrame:
    return df

def compute_macd(df: pd.DataFrame) -> pd.DataFrame:
    result = df.copy()
    def ema(series, span):
        return series.ewm(span=span, adjust=False).mean()
    result['macd'] = ema(result['close'], 14)
    return result
`;

test('extractExportedSymbols ignores nested def/class (module-top only)', () => {
  const exported = extractExportedSymbols(MACD_WITH_NESTED_EMA);
  assert.equal(exported.has('ema'), false);
  assert.equal(exported.has('compute_ma'), true);
  assert.equal(exported.has('compute_macd'), true);
});

test('extractExportedSymbols still counts module-level extra def', () => {
  const exported = extractExportedSymbols(`${MACD_WITH_NESTED_EMA}\ndef rogue_helper():\n    pass\n`);
  assert.equal(exported.has('rogue_helper'), true);
});

test('lintImplExportsAgainstModuleContract allows nested helper (T4 ema case)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-surface-'));
  const implPath = 'indicators/__init__.py';
  fs.mkdirSync(path.join(dir, 'indicators'), { recursive: true });
  fs.writeFileSync(path.join(dir, implPath), MACD_WITH_NESTED_EMA);
  const artifacts = {
    version: 1 as const,
    files: [],
    modules: [{ name: 'indicators', exports: ['compute_ma', 'compute_macd'] }],
  };
  const issue = lintImplExportsAgainstModuleContract({
    workspaceRoot: dir,
    implRelPath: implPath,
    semantic: 'indicators',
    sliceArtifacts: artifacts,
    globalArtifacts: null,
  });
  assert.equal(issue, null);
});

test('lintImplExportsAgainstModuleContract blocks true module-level extra export', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-surface-'));
  const implPath = 'indicators.py';
  fs.writeFileSync(
    path.join(dir, implPath),
    'def compute_ma():\n    return 1\n\ndef rogue_helper():\n    return 2\n',
  );
  const artifacts = {
    version: 1 as const,
    files: [],
    modules: [{ name: 'indicators', exports: ['compute_ma'] }],
  };
  const issue = lintImplExportsAgainstModuleContract({
    workspaceRoot: dir,
    implRelPath: implPath,
    semantic: 'indicators',
    sliceArtifacts: artifacts,
    globalArtifacts: null,
  });
  assert.ok(issue);
  assert.equal(issue?.code, 'python-impl-export-extra');
  assert.equal(issue?.symbol, 'rogue_helper');
});

const STATEMACHINE_IMPL = `ALLOWED_TRANSITIONS: dict = {
    'todo': ['in_progress', 'cancelled'],
    'in_progress': ['done', 'cancelled'],
}

class InvalidTransition(Exception):
    pass

def can_transition(frm: str, to: str) -> bool:
    return to in ALLOWED_TRANSITIONS.get(frm, [])

def apply_transition(task: dict, to: str) -> dict:
    if not can_transition(task['status'], to):
        raise InvalidTransition(to)
    task['status'] = to
    return task
`;

test('extractModuleLevelConstants detects module-level constants (ALLOWED_TRANSITIONS)', () => {
  const constants = extractModuleLevelConstants(STATEMACHINE_IMPL);
  assert.equal(constants.has('ALLOWED_TRANSITIONS'), true);
  // 下划线前缀不计入；def/class 不在常量集合
  assert.equal(constants.has('can_transition'), false);
});

test('lintImplExportsAgainstModuleContract accepts module-level constant export (T6 ALLOWED_TRANSITIONS)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-surface-const-'));
  fs.mkdirSync(path.join(dir, 'statemachine'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'statemachine/__init__.py'), STATEMACHINE_IMPL);
  const artifacts = {
    version: 1 as const,
    files: [],
    modules: [
      {
        name: 'statemachine',
        exports: ['ALLOWED_TRANSITIONS', 'can_transition', 'apply_transition', 'InvalidTransition'],
      },
    ],
  };
  const issue = lintImplExportsAgainstModuleContract({
    workspaceRoot: dir,
    implRelPath: 'statemachine/__init__.py',
    semantic: 'statemachine',
    sliceArtifacts: artifacts,
    globalArtifacts: null,
  });
  assert.equal(issue, null);
});

test('module-level internal constant NOT in contract is not flagged as export-extra', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-surface-const2-'));
  fs.writeFileSync(
    path.join(dir, 'risk.py'),
    'MIN_TICK = 0.2\n\ndef calculate_stop_loss(price):\n    return price - MIN_TICK\n',
  );
  const artifacts = {
    version: 1 as const,
    files: [],
    modules: [{ name: 'risk', exports: ['calculate_stop_loss'] }],
  };
  const issue = lintImplExportsAgainstModuleContract({
    workspaceRoot: dir,
    implRelPath: 'risk.py',
    semantic: 'risk',
    sliceArtifacts: artifacts,
    globalArtifacts: null,
  });
  // MIN_TICK 是内部常量，不在契约里——不得误判为 export-extra（仅 def/class 参与 extra）。
  assert.equal(issue, null);
});

test('lintPythonExportContractFromPaths accepts test importing module-level constant', () => {
  const impl = STATEMACHINE_IMPL;
  const testPy = 'from statemachine import ALLOWED_TRANSITIONS, can_transition\n';
  const issues = lintPythonExportContractFromPaths(
    [{ testPath: 'tests/test_statemachine.py', implPath: 'statemachine/__init__.py' }],
    (p) => (p.includes('test_') ? testPy : impl),
  );
  assert.equal(issues.length, 0);
});

const MAIN_REEXPORT_IMPL = `import sys
import json
import yaml

from store import TaskStore
from pipeline import import_tasks_from_csv, summarize


def main(config_path: str = "config.yaml") -> None:
    store = TaskStore()
    import_tasks_from_csv(config_path, store)
    print(json.dumps(summarize(store)))
`;

test('extractImportedNames detects from-import re-export names', () => {
  const names = extractImportedNames(MAIN_REEXPORT_IMPL);
  assert.equal(names.has('import_tasks_from_csv'), true);
  assert.equal(names.has('summarize'), true);
  assert.equal(names.has('TaskStore'), true);
});

test('extractImportedNames ignores function-local imports', () => {
  const names = extractImportedNames(`import json

def main():
    from pipeline import summarize
    return summarize([])
`);
  assert.equal(names.has('summarize'), false);
});

test('lintImplExportsAgainstModuleContract accepts integration slice re-exporting downstream symbol (T6 main)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-surface-reexport-'));
  fs.writeFileSync(path.join(dir, 'main.py'), MAIN_REEXPORT_IMPL);
  const artifacts = {
    version: 1 as const,
    files: [],
    // main 决策把它编排/转出的 pipeline 符号也列进了 exports（LLM 合成常见）。
    modules: [{ name: 'main', exports: ['main', 'import_tasks_from_csv', 'summarize'] }],
  };
  const issue = lintImplExportsAgainstModuleContract({
    workspaceRoot: dir,
    implRelPath: 'main.py',
    semantic: 'main',
    sliceArtifacts: artifacts,
    globalArtifacts: null,
  });
  assert.equal(issue, null);
});

test('lintImplExportsAgainstModuleContract exempts main from downstream symbol it inlines (crossSliceExports)', () => {
  // main 决策误把 pipeline 的 import_tasks_from_csv 列进 main 契约；本轮 main.py 内联实现、
  // 既不定义也不 import 该符号。它是 pipeline 的导出 → 通过 crossSliceExports 豁免，不判缺失。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-surface-cross-'));
  fs.writeFileSync(
    path.join(dir, 'main.py'),
    'import csv\nimport json\n\ndef main():\n    with open("t.csv") as f:\n        rows = list(csv.DictReader(f))\n    print(json.dumps(rows))\n',
  );
  const artifacts = {
    version: 1 as const,
    files: [],
    modules: [{ name: 'main', exports: ['main', 'import_tasks_from_csv'] }],
  };
  const withoutCross = lintImplExportsAgainstModuleContract({
    workspaceRoot: dir,
    implRelPath: 'main.py',
    semantic: 'main',
    sliceArtifacts: artifacts,
    globalArtifacts: null,
  });
  assert.equal(withoutCross?.code, 'python-impl-export-missing');
  assert.equal(withoutCross?.symbol, 'import_tasks_from_csv');

  const withCross = lintImplExportsAgainstModuleContract({
    workspaceRoot: dir,
    implRelPath: 'main.py',
    semantic: 'main',
    sliceArtifacts: artifacts,
    globalArtifacts: null,
    crossSliceExports: new Set(['import_tasks_from_csv', 'summarize']),
  });
  assert.equal(withCross, null);
});

test('lintPythonExportContractFromPaths accepts test importing a re-exported name from main', () => {
  const testPy = 'from main import import_tasks_from_csv\n';
  const issues = lintPythonExportContractFromPaths(
    [{ testPath: 'tests/test_main.py', implPath: 'main.py' }],
    (p) => (p.includes('test_') ? testPy : MAIN_REEXPORT_IMPL),
  );
  assert.equal(issues.length, 0);
});

test('lintPythonExportContractFromPaths rejects local-only imports as main re-exports', () => {
  const impl = `def main():
    from pipeline import summarize
    return summarize([])
`;
  const testPy = 'from main import summarize\n';
  const issues = lintPythonExportContractFromPaths(
    [{ testPath: 'tests/test_main.py', implPath: 'main.py' }],
    (p) => (p.includes('test_') ? testPy : impl),
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.symbol, 'summarize');
});

test('lintPythonExportContractFromPaths resolves package module from __init__.py（Run #61）', () => {
  const impl = 'def generate_signal():\n    return 0\n\n__all__ = ["generate_signal"]\n';
  const testPy = 'from signals import generate_signal\n';
  const issues = lintPythonExportContractFromPaths(
    [{ testPath: 'tests/test_signals.py', implPath: 'signals/__init__.py' }],
    (p) => (p.includes('test_') ? testPy : impl),
  );
  assert.equal(issues.length, 0);
});
