/**
 * post-stage 与 workflow-end 阶段内置 QualityGate（从 BuiltinQualityGates.ts 抽出，1.3）。
 */
import * as fs from 'fs';
import * as path from 'path';
import type { QualityGate } from '../QualityGate';
import { lintCharterConstraintHits } from '../charter/CharterConstraintsBlock';
import { loadCharterFromWorkspaceSync } from '../charter/CharterLoader';
import {
  readCharterEnabled,
  readCharterRelativePath,
} from '../settings/readers/charter';
import { getStagentConfiguration } from '../settings/getStagentConfiguration';
import {
  GATE_ID_BEHAVIOR_SPEC_TEST_WRITE,
  GATE_ID_CHARTER_CONSTRAINT_WARN,
  GATE_ID_MODULE_CONTRACT_POST_MUTATE,
  GATE_ID_MODULE_CONTRACT_TEST_WRITE,
  GATE_ID_TEST_QUALITY_TEST_WRITE,
  GATE_ID_PYTHON_DECLARED_DEPS_TEST_WRITE,
  GATE_ID_POST_IMPL_STATIC_ANALYSIS,
  GATE_ID_PYTHON_DECLARED_DEPS_POST_MUTATE,
  GATE_ID_PYTHON_EXPORT_CONTRACT_POST_IMPL,
  GATE_ID_CONFIG_CONTRACT_POST_IMPL,
  GATE_ID_DEMO_ARTIFACT_RUN,
  GATE_ID_RUN_END_CONTRACT_LINT,
} from '../QualityGateIds';
import { DEMO_RUN_STAGE_ID } from '../disk-bootstrap/demoStage';
import {
  demoIssuesToWarnings,
  evaluateDemoArtifacts,
  hardDemoIssues,
} from './DemoArtifactGate';
import { CODE_RUNNER_EXIT_OUTPUT_KEY } from '../WorkflowOutputKeys';
import { evaluateConfigContractPostImplGate } from '../python-contract/configContractGateHelpers';
import {
  evaluateDeclaredDepsPostMutateGate,
  evaluateExportContractPostImplGate,
  evaluateModuleContractPostMutateGate,
  isPostMutateContractStage,
} from '../python-contract/sliceContractGateHelpers';
import { block, isImplStage, warn } from './gateHelpers';
import {
  decideStageIdFromSemanticName,
  GLOBAL_ARCHITECTURE_DECIDE_STAGE_ID,
  isTestWriteStageId,
  semanticNameFromTestWriteStageId,
  semanticNameFromTddStageId,
} from '../workflow/StageIdPatterns';
import { writeOutputToFileOf } from '../plan-completeness/planCompletenessStageAccess';
import {
  collectAllProjectModuleNamesFromInstance,
  collectDeclaredDependenciesFromInstance,
} from '../commitment/decisionArtifactsSchema';
import {
  coerceDecisionArtifacts,
  lintTestImportsAgainstModuleContract,
  lintTestCrossModulePatchTargetsAgainstContracts,
  lintTestPatchTargetsAgainstModuleContract,
} from '../python-contract/ModuleContractLint';
import { lintDeclaredDependenciesInFiles } from '../python-contract/PythonDeclaredDependenciesLint';
import {
  hardTestQualityIssues,
  lintTestQuality,
  testQualityIssuesToWarnings,
} from '../TestQualityLint';
import {
  isRuntimeReplanTestFixStageId,
  semanticFromRuntimeReplanTestFixStageId,
} from '../runtime-replan/constants';
import { DECISION_ARTIFACTS_OUTPUT_KEY } from '../WorkflowOutputKeys';
import { resolveSliceBehaviorSpec } from '../commitment/behaviorSpec';
import { resolveSliceContractExports } from '../commitment/sliceContractExports';
import {
  behaviorSpecIssuesToWarnings,
  hardBehaviorSpecIssues,
  lintTestAgainstBehaviorSpec,
} from '../commitment/BehaviorSpecLint';

/**
 * 解析当前任务的真实生产模块名供 test-quality lint 使用：
 * decide modules[] SSOT ∪ 计划内 TDD stage（impl/test_write/test_run）语义 ∪ 约定 src/main。
 * 不依赖任何任务专属硬编码，兼容 T4 量化与 T6 确定性平台等任意多切片任务。
 */
function resolveProductionModulesForTestQuality(
  instance: { definition?: { stages?: Array<{ id: string }> }; stageRuntimes: Array<{ stageId: string; outputs?: Record<string, unknown> }> } | undefined,
): string[] {
  const names = new Set<string>(['src', 'main']);
  if (!instance) {
    return [...names];
  }
  for (const m of collectAllProjectModuleNamesFromInstance(
    instance.stageRuntimes,
    DECISION_ARTIFACTS_OUTPUT_KEY,
  )) {
    names.add(m);
  }
  for (const st of instance.definition?.stages ?? []) {
    const sem = semanticNameFromTddStageId(st.id);
    if (sem) {
      names.add(sem);
    }
  }
  return [...names];
}

export const BUILTIN_POST_STAGE_GATES: QualityGate[] = [
  {
    id: GATE_ID_MODULE_CONTRACT_TEST_WRITE,
    label: 'test_write 对照模块接口契约（decisionArtifacts.modules）',
    phase: 'post-stage',
    priority: 20,
    enabled: (ctx) => {
      const stageId = ctx.stage?.id ?? '';
      if (!isTestWriteStageId(stageId)) {
        return false;
      }
      const mode = ctx.executionHost?.readPythonModuleContractLintMode() ?? 'warn';
      return mode !== 'off';
    },
    evaluate(ctx) {
      const stage = ctx.stage;
      const instance = ctx.instance;
      const ws = ctx.taskWorkspaceAbs ?? ctx.executionHost?.getWorkspaceRootAbsolute();
      if (!stage || !instance || !ws) {
        return null;
      }
      const semantic = semanticNameFromTestWriteStageId(stage.id);
      if (!semantic) {
        return null;
      }
      const mode = ctx.executionHost?.readPythonModuleContractLintMode() ?? 'warn';
      const decideId = decideStageIdFromSemanticName(semantic);
      const sliceRt = instance.stageRuntimes.find((r) => r.stageId === decideId);
      const globalRt = instance.stageRuntimes.find((r) => r.stageId === GLOBAL_ARCHITECTURE_DECIDE_STAGE_ID);
      const sliceArtifacts = coerceDecisionArtifacts(sliceRt?.outputs?.[DECISION_ARTIFACTS_OUTPUT_KEY]);
      const globalArtifacts = coerceDecisionArtifacts(globalRt?.outputs?.[DECISION_ARTIFACTS_OUTPUT_KEY]);
      const testRelPath = writeOutputToFileOf(stage);
      if (!testRelPath) {
        return null;
      }
      const issue =
        lintTestImportsAgainstModuleContract({
          workspaceRoot: ws,
          testRelPath,
          semantic,
          sliceArtifacts,
          globalArtifacts,
        }) ??
        lintTestPatchTargetsAgainstModuleContract({
          workspaceRoot: ws,
          testRelPath,
          semantic,
          sliceArtifacts,
          globalArtifacts,
        }) ??
        lintTestCrossModulePatchTargetsAgainstContracts({
          workspaceRoot: ws,
          testRelPath,
          instance,
        });
      if (!issue) {
        return null;
      }
      const message = `module-contract（${issue.code}）：${issue.message}`;
      if (mode === 'hard') {
        return block(GATE_ID_MODULE_CONTRACT_TEST_WRITE, [message], { issue });
      }
      return warn(GATE_ID_MODULE_CONTRACT_TEST_WRITE, [message], { issue });
    },
  },
  {
    id: GATE_ID_TEST_QUALITY_TEST_WRITE,
    label: 'test_write 测试质量（弱断言 / sys.modules 劫持 / 脆弱断言 → 假绿假红拦截）',
    phase: 'post-stage',
    priority: 18,
    enabled: (ctx) => {
      const stageId = ctx.stage?.id ?? '';
      // testfix replan（重写测试）同样产出测试文件，必须过同一道门
      if (!isTestWriteStageId(stageId) && !isRuntimeReplanTestFixStageId(stageId)) {
        return false;
      }
      const mode = ctx.executionHost?.readTestQualityLintMode?.() ?? 'warn';
      return mode !== 'off';
    },
    evaluate(ctx) {
      const stage = ctx.stage;
      const ws = ctx.taskWorkspaceAbs ?? ctx.executionHost?.getWorkspaceRootAbsolute();
      if (!stage || !ws) {
        return null;
      }
      const testRelPath = writeOutputToFileOf(stage);
      if (!testRelPath) {
        return null;
      }
      const abs = path.join(ws, testRelPath);
      let code = '';
      try {
        code = fs.readFileSync(abs, 'utf-8');
      } catch {
        return null;
      }
      // 生产模块名按当前任务真实切片解析（decide modules[] SSOT ∪ 计划 TDD stage 语义 ∪ 约定
      // src/main），避免确定性平台任务（T6 models/store/...）被误判为「未 import 生产模块」假绿。
      const productionModules = resolveProductionModulesForTestQuality(ctx.instance);
      const issues = lintTestQuality(code, { productionModules });
      if (issues.length === 0) {
        return null;
      }
      const mode = ctx.executionHost?.readTestQualityLintMode?.() ?? 'warn';
      const hardIssues = hardTestQualityIssues(issues);
      if (mode === 'hard' && hardIssues.length > 0) {
        return block(
          GATE_ID_TEST_QUALITY_TEST_WRITE,
          testQualityIssuesToWarnings(testRelPath, hardIssues),
          { issues: hardIssues },
        );
      }
      return warn(
        GATE_ID_TEST_QUALITY_TEST_WRITE,
        testQualityIssuesToWarnings(testRelPath, issues),
        { issues },
      );
    },
  },
  {
    id: GATE_ID_BEHAVIOR_SPEC_TEST_WRITE,
    label: 'test_write 对照 behaviorSpec SSOT（条件 id 覆盖 / edge_rules 纪律，P2）',
    phase: 'post-stage',
    priority: 17,
    enabled: (ctx) => {
      const stageId = ctx.stage?.id ?? '';
      if (!isTestWriteStageId(stageId) && !isRuntimeReplanTestFixStageId(stageId)) {
        return false;
      }
      const mode = ctx.executionHost?.readBehaviorSpecLintMode?.() ?? 'warn';
      return mode !== 'off';
    },
    evaluate(ctx) {
      const stage = ctx.stage;
      const instance = ctx.instance;
      const ws = ctx.taskWorkspaceAbs ?? ctx.executionHost?.getWorkspaceRootAbsolute();
      if (!stage || !instance || !ws) {
        return null;
      }
      const semantic =
        semanticNameFromTestWriteStageId(stage.id) ??
        semanticFromRuntimeReplanTestFixStageId(stage.id);
      if (!semantic) {
        return null;
      }
      const spec = resolveSliceBehaviorSpec(instance.stageRuntimes, semantic);
      if (!spec) {
        // decide 未产出 behaviorSpec（必填切片由 decide 硬拒兜底），此处不重复告警
        return null;
      }
      const testRelPath = writeOutputToFileOf(stage);
      if (!testRelPath) {
        return null;
      }
      let code = '';
      try {
        code = fs.readFileSync(path.join(ws, testRelPath), 'utf-8');
      } catch {
        return null;
      }
      const issues = lintTestAgainstBehaviorSpec(code, spec, {
        contractExports: resolveSliceContractExports(instance.definition, instance.stageRuntimes, semantic) ?? undefined,
      });
      if (issues.length === 0) {
        return null;
      }
      const mode = ctx.executionHost?.readBehaviorSpecLintMode?.() ?? 'warn';
      const hardIssues = hardBehaviorSpecIssues(issues);
      if (mode === 'hard' && hardIssues.length > 0) {
        return block(
          GATE_ID_BEHAVIOR_SPEC_TEST_WRITE,
          behaviorSpecIssuesToWarnings(testRelPath, hardIssues),
          { issues: hardIssues },
        );
      }
      return warn(
        GATE_ID_BEHAVIOR_SPEC_TEST_WRITE,
        behaviorSpecIssuesToWarnings(testRelPath, issues),
        { issues },
      );
    },
  },
  {
    id: GATE_ID_PYTHON_DECLARED_DEPS_TEST_WRITE,
    label: 'test_write 已声明第三方依赖（R3b）',
    phase: 'post-stage',
    priority: 19,
    enabled: (ctx) => {
      const stageId = ctx.stage?.id ?? '';
      if (!isTestWriteStageId(stageId)) {
        return false;
      }
      const mode = ctx.executionHost?.readPythonPypiSymbolLintMode() ?? 'warn';
      return mode !== 'off';
    },
    evaluate(ctx) {
      const stage = ctx.stage;
      const instance = ctx.instance;
      const ws = ctx.taskWorkspaceAbs ?? ctx.executionHost?.getWorkspaceRootAbsolute();
      if (!stage || !instance || !ws) {
        return null;
      }
      const testRelPath = writeOutputToFileOf(stage);
      if (!testRelPath) {
        return null;
      }
      const mode = ctx.executionHost?.readPythonPypiSymbolLintMode() ?? 'warn';
      const issues = lintDeclaredDependenciesInFiles({
        workspaceRoot: ws,
        pyFiles: [testRelPath],
        allowedDeps: collectDeclaredDependenciesFromInstance(
          instance.stageRuntimes,
          DECISION_ARTIFACTS_OUTPUT_KEY,
        ),
        projectModuleNames: collectAllProjectModuleNamesFromInstance(
          instance.stageRuntimes,
          DECISION_ARTIFACTS_OUTPUT_KEY,
        ),
      });
      if (issues.length === 0) {
        return null;
      }
      const issue = issues[0]!;
      if (mode === 'hard') {
        return block(GATE_ID_PYTHON_DECLARED_DEPS_TEST_WRITE, [issue.message], { issue });
      }
      return warn(GATE_ID_PYTHON_DECLARED_DEPS_TEST_WRITE, [issue.message], { issue });
    },
  },
  {
    id: GATE_ID_MODULE_CONTRACT_POST_MUTATE,
    label: 'post impl/fix 模块接口契约复验（R3b）',
    phase: 'post-stage',
    priority: 21,
    enabled: (ctx) => isPostMutateContractStage(ctx.stage?.id ?? ''),
    evaluate: evaluateModuleContractPostMutateGate,
  },
  {
    id: GATE_ID_PYTHON_EXPORT_CONTRACT_POST_IMPL,
    label: 'post impl test/impl 导出契约（R3b）',
    phase: 'post-stage',
    priority: 22,
    enabled: (ctx) => isPostMutateContractStage(ctx.stage?.id ?? '') && isImplStage(ctx.stage),
    evaluate: evaluateExportContractPostImplGate,
  },
  {
    id: GATE_ID_PYTHON_DECLARED_DEPS_POST_MUTATE,
    label: 'post impl/fix 已声明第三方依赖（R3b）',
    phase: 'post-stage',
    priority: 23,
    enabled: (ctx) => isPostMutateContractStage(ctx.stage?.id ?? ''),
    evaluate: evaluateDeclaredDepsPostMutateGate,
  },
  {
    id: GATE_ID_CONFIG_CONTRACT_POST_IMPL,
    label: 'post impl/fix 入口脚本 config.yaml 键契约',
    phase: 'post-stage',
    priority: 24,
    enabled: (ctx) => isPostMutateContractStage(ctx.stage?.id ?? ''),
    evaluate: evaluateConfigContractPostImplGate,
  },
  {
    id: GATE_ID_CHARTER_CONSTRAINT_WARN,
    label: 'Charter avoid/constraint 边界告警（B-R2）',
    phase: 'post-stage',
    priority: 45,
    enabled: (ctx) => isImplStage(ctx.stage) && readCharterEnabled(getStagentConfiguration()),
    evaluate(ctx) {
      const ws = ctx.taskWorkspaceAbs ?? ctx.executionHost?.getWorkspaceRootAbsolute();
      const cfg = getStagentConfiguration();
      const doc = ws
        ? loadCharterFromWorkspaceSync(ws, readCharterRelativePath(cfg))
        : null;
      if (!doc) {
        return null;
      }
      const outputs = ctx.stageRuntime?.outputs ?? {};
      const text = Object.values(outputs)
        .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
        .join('\n');
      const lint = lintCharterConstraintHits(doc, text);
      return lint.hit
        ? warn(GATE_ID_CHARTER_CONSTRAINT_WARN, lint.messages, { ruleRefs: lint.ruleRefs })
        : null;
    },
  },
  {
    id: GATE_ID_POST_IMPL_STATIC_ANALYSIS,
    label: 'impl 完成后静态分析',
    phase: 'post-stage',
    priority: 100,
    tags: ['static-analysis'],
    enabled: (ctx) =>
      isImplStage(ctx.stage) && (ctx.executionHost?.readStaticAnalysisEnabled() ?? false),
    async evaluate(ctx) {
      const host = ctx.executionHost;
      if (!host) {
        return null;
      }
      const messages = await host.runPostImplStaticAnalysis();
      return messages.length ? warn(GATE_ID_POST_IMPL_STATIC_ANALYSIS, messages) : null;
    },
  },
  {
    id: GATE_ID_DEMO_ARTIFACT_RUN,
    label: 'demo 真跑后客观验收（exit 0 / summary.json / QUICKSTART.md，价值档默认 warn）',
    phase: 'post-stage',
    priority: 110,
    enabled: (ctx) => {
      if (ctx.stage?.id !== DEMO_RUN_STAGE_ID) {
        return false;
      }
      const mode = ctx.executionHost?.readDemoArtifactLintMode?.() ?? 'warn';
      return mode !== 'off';
    },
    evaluate(ctx) {
      const ws = ctx.taskWorkspaceAbs ?? ctx.executionHost?.getWorkspaceRootAbsolute();
      if (!ws) {
        return null;
      }
      const rawExit = ctx.stageRuntime?.outputs?.[CODE_RUNNER_EXIT_OUTPUT_KEY];
      const exitCode =
        typeof rawExit === 'number'
          ? rawExit
          : typeof rawExit === 'string' && rawExit.trim() !== ''
            ? Number(rawExit)
            : undefined;
      const issues = evaluateDemoArtifacts(ws, {
        exitCode: Number.isFinite(exitCode) ? exitCode : undefined,
      });
      if (issues.length === 0) {
        return null;
      }
      const mode = ctx.executionHost?.readDemoArtifactLintMode?.() ?? 'warn';
      const hardIssues = hardDemoIssues(issues);
      if (mode === 'hard' && hardIssues.length > 0) {
        return block(GATE_ID_DEMO_ARTIFACT_RUN, demoIssuesToWarnings(hardIssues), { issues: hardIssues });
      }
      return warn(GATE_ID_DEMO_ARTIFACT_RUN, demoIssuesToWarnings(issues), { issues });
    },
  },
];

export const BUILTIN_WORKFLOW_END_GATES: QualityGate[] = [
  {
    id: GATE_ID_RUN_END_CONTRACT_LINT,
    label: 'run_end 兜底跨文件契约 lint',
    phase: 'workflow-end',
    priority: 1000,
    async evaluate(ctx) {
      const host = ctx.executionHost;
      if (!host) {
        return null;
      }
      const messages = await host.runWorkspaceContractLint();
      return messages.length ? warn(GATE_ID_RUN_END_CONTRACT_LINT, messages) : null;
    },
  },
];
