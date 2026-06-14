import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { compileGreenfieldPythonSkeletonPlan } from '../plan-skeleton/compileGreenfieldPythonSkeletonPlan';
import {
  expandGreenfieldPythonSkeleton,
  extractPythonSliceModules,
  shouldUseGreenfieldPythonSkeleton,
  GREENFIELD_PYTHON_SKELETON_VERSION,
} from '../plan-skeleton';
import { lintArtifactGraphHard } from '../plan-preflight/artifactGraphPreflight';
import { T4_REQUIREMENT_SNIPPET } from './fixtures/t4RequirementSnippet';
import { isTestRunStageId } from '../workflow/StageIdPatterns';

test('extractPythonSliceModules resolves T4 default five modules', () => {
  const modules = extractPythonSliceModules(T4_REQUIREMENT_SNIPPET, 'software');
  assert.deepEqual(modules, ['indicators', 'signals', 'risk', 'broker', 'main']);
});

test('extractPythonSliceModules ignores mock/CSV token on live T4 userInput', () => {
  const liveSnippet = `${T4_REQUIREMENT_SNIPPET}\n首版不接实盘；指数可用 mock/CSV`;
  const modules = extractPythonSliceModules(liveSnippet, 'software');
  assert.deepEqual(modules, ['indicators', 'signals', 'risk', 'broker', 'main']);
})

test('extractPythonSliceModules orders entry slice (main) last for non-T4 modules', () => {
  // main 在文本中先出现，仍须排到最后（集成切片依赖前序切片落盘）。
  const input =
    '实现 main.py 串联各切片，并提供 models/、store/、statemachine/、pipeline/ 四个垂直切片。'
  const modules = extractPythonSliceModules(input, 'software')
  assert.equal(modules[modules.length - 1], 'main')
  assert.deepEqual([...modules].sort(), ['main', 'models', 'pipeline', 'statemachine', 'store'])
})

test('expandGreenfieldPythonSkeleton moves main last even when input.modules lists it first', () => {
  const { modules } = expandGreenfieldPythonSkeleton({
    userInput: '任务清单 CLI：models/ store/ statemachine/ pipeline/ main.py',
    taskType: 'software',
    modules: ['main', 'models', 'store', 'statemachine', 'pipeline'],
  })
  assert.equal(modules[modules.length - 1], 'main')
  assert.deepEqual(modules, ['models', 'store', 'statemachine', 'pipeline', 'main'])
});

test('shouldUseGreenfieldPythonSkeleton requires explicit skeletonCompiler flag', () => {
  assert.equal(
    shouldUseGreenfieldPythonSkeleton({
      workflowTemplate: 'greenfield_full',
      taskType: 'software',
      userInput: T4_REQUIREMENT_SNIPPET,
      skeletonCompilerEnabled: false,
    }),
    false,
  );
  assert.equal(
    shouldUseGreenfieldPythonSkeleton({
      workflowTemplate: 'greenfield_full',
      taskType: 'software',
      userInput: T4_REQUIREMENT_SNIPPET,
      skeletonCompilerEnabled: true,
      stackProfile: 'python',
    }),
    true,
  );
});

test('expandGreenfieldPythonSkeleton pre-bootstrap artifact graph is green', () => {
  const { workflow, modules, skeletonVersion } = expandGreenfieldPythonSkeleton({
    userInput: T4_REQUIREMENT_SNIPPET,
    taskType: 'software',
  });
  assert.equal(skeletonVersion, GREENFIELD_PYTHON_SKELETON_VERSION);
  assert.equal(skeletonVersion, 'greenfield-python-v2');
  assert.equal(modules.length, 5);
  assert.equal(workflow.meta.workflowTemplate, 'greenfield_full');
  assert.equal(workflow.meta.skeletonVersion, GREENFIELD_PYTHON_SKELETON_VERSION);
  assert.ok(workflow.stages.some((s) => s.id === 'stage_write_config'));
  assert.ok(workflow.stages.some((s) => s.id === 'stage_decide_architecture_overview'));
  assert.equal(lintArtifactGraphHard(workflow).length, 0);
  const testRuns = workflow.stages.filter((s) => isTestRunStageId(s.id));
  assert.equal(testRuns.length, 5);
  for (const tr of testRuns) {
    assert.equal(tr.tool, 'code-runner');
    const cmd = (tr.toolConfig as { command?: string }).command ?? '';
    assert.match(cmd, /\.venv\/bin\/python -m pytest/);
  }
});

test('T4 mock: compileGreenfieldPythonSkeletonPlan passes plan lint (Phase0 gate)', () => {
  const { normalizeWorkflow } = require('../WorkflowGeneration') as typeof import('../WorkflowGeneration');
  const result = compileGreenfieldPythonSkeletonPlan(
    {
      userInput: T4_REQUIREMENT_SNIPPET,
      taskType: 'software',
      title: 'T4 skeleton mock',
    },
    {
      taskType: 'software',
      userInput: T4_REQUIREMENT_SNIPPET,
      planCompletenessEnabled: true,
      structuralRepairMode: 'auto',
      fullOrchestration: true,
      normalizeWorkflow: (w, input, taskType) => normalizeWorkflow(w, input, taskType),
    },
  );
  if (!('ok' in result) || !result.ok) {
    const blocked = result as { blockReasons?: string[]; issues?: { message: string }[] };
    const detail =
      blocked.blockReasons?.join('; ') ??
      blocked.issues?.map((i) => i.message).join('; ') ??
      JSON.stringify(result);
    assert.fail(`expected plan compile ok, got: ${detail}`);
  }
  const ids = result.workflow.stages?.map((s) => s.id) ?? [];
  assert.ok(ids.includes('stage_venv_create'), 'expected python venv chain from disk-bootstrap');
  assert.ok(ids.some((id) => id.startsWith('stage_verify_imports_')), 'expected verify_imports injection');
  assert.ok(ids.includes('stage_write_config'));
  assert.equal(lintArtifactGraphHard(result.workflow).length, 0);
});

test('disk pipeline preserves RED-first order for skeleton (test_write before impl)', () => {
  const { normalizeWorkflow } = require('../WorkflowGeneration') as typeof import('../WorkflowGeneration');
  const { validateAndPrepareGeneratedWorkflow } = require('../WorkflowEngineHelpers') as typeof import('../WorkflowEngineHelpers');
  const { lintTestWriteWiredToModuleDecide } = require('../plan-completeness/moduleContractChecks') as typeof import('../plan-completeness/moduleContractChecks');
  const { workflow } = expandGreenfieldPythonSkeleton({
    userInput: T4_REQUIREMENT_SNIPPET,
    taskType: 'software',
  });
  const normalized = normalizeWorkflow(workflow, T4_REQUIREMENT_SNIPPET, 'software');
  const prep = validateAndPrepareGeneratedWorkflow(normalized, 'software');
  assert.equal(prep.errors.length, 0, prep.errors.join('; '));
  assert.equal(lintTestWriteWiredToModuleDecide(prep.workflow).length, 0);
  for (const semantic of ['indicators', 'signals', 'main']) {
    const implId = `stage_impl_${semantic}`;
    const twId = `stage_test_write_${semantic}`;
    const implIdx = prep.workflow.stages.findIndex((s) => s.id === implId);
    const twIdx = prep.workflow.stages.findIndex((s) => s.id === twId);
    assert.ok(implIdx >= 0 && twIdx >= 0, `${implId} / ${twId}`);
    const impl = prep.workflow.stages[implIdx]!;
    assert.ok((impl.dependsOn ?? []).includes(twId), `${implId} dependsOn ${twId}`);
    assert.ok(twIdx < implIdx, `${twId} must precede ${implId} in stages[]`);
  }
});
