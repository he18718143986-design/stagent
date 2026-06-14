import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GateResult, QualityGateContext } from '../QualityGate';
import type { Stage, WorkflowInstance } from '../WorkflowDefinition';
import { BUILTIN_POST_STAGE_GATES } from '../quality-gates/postStageGates';
import {
  GATE_ID_MODULE_CONTRACT_POST_MUTATE,
  GATE_ID_PYTHON_DECLARED_DEPS_POST_MUTATE,
} from '../QualityGateIds';
import { DECISION_ARTIFACTS_OUTPUT_KEY } from '../WorkflowOutputKeys';
import {
  decideStageIdFromSemanticName,
  implStageIdFromSemanticName,
  testWriteStageIdFromSemanticName,
} from '../workflow/StageIdPatterns';
import { mergeDeclaredDependenciesIntoRequirements } from '../python-contract/requirementsMerge';

const postMutateGate = BUILTIN_POST_STAGE_GATES.find((g) => g.id === GATE_ID_MODULE_CONTRACT_POST_MUTATE)!;
const declaredDepsGate = BUILTIN_POST_STAGE_GATES.find(
  (g) => g.id === GATE_ID_PYTHON_DECLARED_DEPS_POST_MUTATE,
)!;

function evalSync(
  gate: { evaluate?: (ctx: QualityGateContext) => unknown },
  ctx: QualityGateContext,
): GateResult | null {
  const raw = gate.evaluate!(ctx);
  if (raw instanceof Promise) {
    throw new Error('expected sync gate');
  }
  return raw as GateResult | null;
}

function makeFixGateCtx(opts: {
  implBody: string;
  exports: string[];
  mode: 'hard' | 'warn';
}): QualityGateContext {
  const semantic = 'indicators';
  const implPath = `${semantic}.py`;
  const testPath = `tests/test_${semantic}.py`;
  const fixStage: Stage = {
    id: `stage_fix_if_failed_${semantic}`,
    title: 'fix',
    tool: 'llm-text',
    toolConfig: { type: 'llm-text', systemPrompt: 'fix', writeOutputToFile: implPath, writePathBase: 'workspace' },
    input: { sources: [], mergeStrategy: 'concat' },
    outputs: [{ key: 'fixPatch', format: 'text' }],
    pauseAfter: false,
  };
  const instance = {
    status: 'running' as const,
    definition: {
      id: 'wf',
      version: '2.0',
      meta: { title: 't', taskType: 'software', userInput: 'u', createdAt: new Date().toISOString() },
      stages: [
        fixStage,
        {
          id: testWriteStageIdFromSemanticName(semantic)!,
          title: 'tw',
          tool: 'llm-text',
          toolConfig: {
            type: 'llm-text',
            systemPrompt: 't',
            writeOutputToFile: testPath,
            writePathBase: 'workspace',
          },
          input: { sources: [], mergeStrategy: 'concat' },
          outputs: [{ key: 'code', format: 'text' }],
          pauseAfter: false,
        },
        {
          id: implStageIdFromSemanticName(semantic)!,
          title: 'impl',
          tool: 'llm-text',
          toolConfig: {
            type: 'llm-text',
            systemPrompt: 'i',
            writeOutputToFile: implPath,
            writePathBase: 'workspace',
          },
          input: { sources: [], mergeStrategy: 'concat' },
          outputs: [{ key: 'code', format: 'text' }],
          pauseAfter: false,
        },
      ],
    },
    stageRuntimes: [
      {
        stageId: `stage_decide_${semantic}`,
        status: 'done',
        outputs: {
          [DECISION_ARTIFACTS_OUTPUT_KEY]: {
            version: 1,
            files: [],
            modules: [{ name: semantic, exports: opts.exports }],
            dependencies: ['pytest', 'numpy', 'pandas'],
          },
        },
        retryCount: 0,
      },
    ],
    currentStageIndex: 0,
  } satisfies WorkflowInstance;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3b-'));
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, testPath),
    `from ${semantic} import ${opts.exports[0]}\n\ndef test_x():\n    assert ${opts.exports[0]}() is not None\n`,
  );
  fs.writeFileSync(path.join(dir, implPath), opts.implBody);
  return {
    phase: 'post-stage',
    stage: fixStage,
    instance,
    taskWorkspaceAbs: dir,
    executionHost: {
      readPythonModuleContractLintMode: () => opts.mode,
      readPythonExportContractLintMode: () => opts.mode,
      readPythonPypiSymbolLintMode: () => opts.mode,
      getWorkspaceRootAbsolute: () => dir,
    } as never,
  };
}

function llmWriteStage(id: string, filePath: string): Stage {
  return {
    id,
    title: id,
    tool: 'llm-text',
    toolConfig: {
      type: 'llm-text',
      systemPrompt: id,
      writeOutputToFile: filePath,
      writePathBase: 'workspace',
    },
    input: { sources: [], mergeStrategy: 'concat' },
    outputs: [{ key: 'code', format: 'text' }],
    pauseAfter: false,
  };
}

function makePostMutateModuleCtx(opts: {
  semantic: string;
  implBody: string;
  moduleExports: string[];
  testImportSymbol: string;
  otherModules: Array<{ name: string; exports: string[] }>;
}): QualityGateContext {
  const implPath = `${opts.semantic}.py`;
  const testPath = `tests/test_${opts.semantic}.py`;
  const implStage = llmWriteStage(implStageIdFromSemanticName(opts.semantic), implPath);
  const testStage = llmWriteStage(testWriteStageIdFromSemanticName(opts.semantic), testPath);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3b-cross-slice-'));
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, testPath),
    `from ${opts.semantic} import ${opts.testImportSymbol}\n\ndef test_contract():\n    assert ${opts.testImportSymbol} is not None\n`,
  );
  fs.writeFileSync(path.join(dir, implPath), opts.implBody);

  const stageRuntimes = [
    {
      stageId: decideStageIdFromSemanticName(opts.semantic),
      status: 'done' as const,
      outputs: {
        [DECISION_ARTIFACTS_OUTPUT_KEY]: {
          version: 1 as const,
          files: [],
          modules: [{ name: opts.semantic, exports: opts.moduleExports }],
        },
      },
      retryCount: 0,
    },
    ...opts.otherModules.map((m) => ({
      stageId: decideStageIdFromSemanticName(m.name),
      status: 'done' as const,
      outputs: {
        [DECISION_ARTIFACTS_OUTPUT_KEY]: {
          version: 1 as const,
          files: [],
          modules: [m],
        },
      },
      retryCount: 0,
    })),
  ];

  return {
    phase: 'post-stage',
    stage: implStage,
    instance: {
      status: 'running',
      definition: {
        id: 'wf-cross-slice',
        version: '2.0',
        meta: { title: 't', taskType: 'software', userInput: 'u', createdAt: new Date().toISOString() },
        stages: [testStage, implStage],
      },
      stageRuntimes,
      currentStageIndex: 0,
    } satisfies WorkflowInstance,
    taskWorkspaceAbs: dir,
    executionHost: {
      readPythonModuleContractLintMode: () => 'hard',
      readPythonExportContractLintMode: () => 'hard',
      readPythonPypiSymbolLintMode: () => 'hard',
      getWorkspaceRootAbsolute: () => dir,
    } as never,
  };
}

test('post-fix module-contract blocks wrong export name', () => {
  const ctx = makeFixGateCtx({
    implBody: 'def indicators_ma():\n    return 1\n',
    exports: ['compute_ma'],
    mode: 'hard',
  });
  const result = evalSync(postMutateGate, ctx);
  assert.ok(result);
  assert.equal(result!.severity, 'block');
  assert.match(result!.messages.join(' '), /module-contract/);
});

test('post-fix declared-deps blocks talib import', () => {
  const ctx = makeFixGateCtx({
    implBody: 'import talib\n\ndef compute_ma():\n    return 1\n',
    exports: ['compute_ma'],
    mode: 'hard',
  });
  const result = evalSync(declaredDepsGate, ctx);
  assert.ok(result);
  assert.equal(result!.severity, 'block');
  assert.match(result!.messages.join(' '), /talib/);
});

test('post-mutate module-contract lets main omit downstream module-name exports', () => {
  const ctx = makePostMutateModuleCtx({
    semantic: 'main',
    implBody: 'def main():\n    return None\n',
    moduleExports: ['main', 'store'],
    testImportSymbol: 'main',
    otherModules: [{ name: 'store', exports: ['TaskStore'] }],
  });
  const result = evalSync(postMutateGate, ctx);
  assert.equal(result, null);
});

test('post-mutate module-contract does not exempt downstream module names for non-main slices', () => {
  const ctx = makePostMutateModuleCtx({
    semantic: 'store',
    implBody: 'class TaskStore:\n    pass\n',
    moduleExports: ['TaskStore', 'pipeline'],
    testImportSymbol: 'TaskStore',
    otherModules: [{ name: 'pipeline', exports: ['run_pipeline'] }],
  });
  const result = evalSync(postMutateGate, ctx);
  assert.ok(result);
  assert.equal(result!.severity, 'block');
  assert.equal((result!.meta as { issue?: { symbol?: string } } | undefined)?.issue?.symbol, 'pipeline');
});

test('mergeDeclaredDependenciesIntoRequirements is idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'req-merge-'));
  const first = mergeDeclaredDependenciesIntoRequirements(dir, ['pytest', 'numpy', 'pandas', 'requests']);
  assert.deepEqual(first.added.sort(), ['numpy', 'pandas', 'pytest', 'requests'].sort());
  const second = mergeDeclaredDependenciesIntoRequirements(dir, ['pytest', 'numpy', 'pandas', 'requests']);
  assert.deepEqual(second.added, []);
});
