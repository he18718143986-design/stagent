import * as fs from 'fs';
import * as path from 'path';
import type { GateResult, QualityGateContext } from '../QualityGate';
import type { WorkflowInstance } from '../WorkflowDefinition';
import {
  collectAllProjectModuleNamesFromInstance,
  collectDeclaredDependenciesFromInstance,
  collectProjectModuleNames,
  collectSliceExportSymbolsFromInstance,
} from '../commitment/decisionArtifactsSchema';
import { resolveSliceDecisionRecord } from '../commitment/sliceContractExports';
import { DECISION_ARTIFACTS_OUTPUT_KEY } from '../WorkflowOutputKeys';
import {
  decideStageIdFromSemanticName,
  GLOBAL_ARCHITECTURE_DECIDE_STAGE_ID,
  semanticNameFromImplStageId,
} from '../workflow/StageIdPatterns';
import { semanticFromFixIfFailedStageId } from '../runtime-replan/FixExhaustedRouter';
import { block, warn } from '../quality-gates/gateHelpers';
import {
  coerceDecisionArtifacts,
  lintImplExportsAgainstModuleContract,
  lintTestImportsAgainstModuleContract,
} from './ModuleContractLint';
import { lintPythonExportContractFromPaths } from './PythonExportContractLint';
import { lintDeclaredDependenciesInFiles } from './PythonDeclaredDependenciesLint';
import { collectSlicePythonPaths } from './slicePythonPaths';
import {
  collectWorkflowSliceOrder,
  lintForwardSliceImportsInImpl,
} from './ForwardSliceImportLint';
import {
  GATE_ID_MODULE_CONTRACT_POST_MUTATE,
  GATE_ID_PYTHON_DECLARED_DEPS_POST_MUTATE,
  GATE_ID_PYTHON_EXPORT_CONTRACT_POST_IMPL,
} from '../QualityGateIds';

export function resolveSliceSemanticFromMutateStage(stageId: string): string | undefined {
  return semanticNameFromImplStageId(stageId) ?? semanticFromFixIfFailedStageId(stageId);
}

export function isPostMutateContractStage(stageId: string): boolean {
  return !!resolveSliceSemanticFromMutateStage(stageId);
}

export { resolveSliceDecisionRecord } from '../commitment/sliceContractExports';

export function resolveSliceArtifacts(instance: WorkflowInstance, semantic: string) {
  const decideId = decideStageIdFromSemanticName(semantic);
  const sliceRt = instance.stageRuntimes.find((r) => r.stageId === decideId);
  const globalRt = instance.stageRuntimes.find((r) => r.stageId === GLOBAL_ARCHITECTURE_DECIDE_STAGE_ID);
  return {
    sliceArtifacts: coerceDecisionArtifacts(sliceRt?.outputs?.[DECISION_ARTIFACTS_OUTPUT_KEY]),
    globalArtifacts: coerceDecisionArtifacts(globalRt?.outputs?.[DECISION_ARTIFACTS_OUTPUT_KEY]),
    sliceDecisionRecord: resolveSliceDecisionRecord(sliceRt),
  };
}

function mutateProfileFromStageId(stageId: string): 'impl' | 'fix' {
  return semanticFromFixIfFailedStageId(stageId) ? 'fix' : 'impl';
}

export function evaluateModuleContractPostMutateGate(ctx: QualityGateContext): GateResult | null {
  const stage = ctx.stage;
  const instance = ctx.instance;
  const ws = ctx.taskWorkspaceAbs ?? ctx.executionHost?.getWorkspaceRootAbsolute();
  if (!stage || !instance || !ws) {
    return null;
  }
  const semantic = resolveSliceSemanticFromMutateStage(stage.id);
  if (!semantic) {
    return null;
  }
  const mode = ctx.executionHost?.readPythonModuleContractLintMode() ?? 'warn';
  if (mode === 'off') {
    return null;
  }
  const { sliceArtifacts, globalArtifacts, sliceDecisionRecord } = resolveSliceArtifacts(
    instance,
    semantic,
  );
  const paths = collectSlicePythonPaths(instance.definition, semantic);

  if (paths.testRelPath) {
    const testIssue = lintTestImportsAgainstModuleContract({
      workspaceRoot: ws,
      testRelPath: paths.testRelPath,
      semantic,
      sliceArtifacts,
      globalArtifacts,
      sliceDecisionRecord,
    });
    if (testIssue) {
      const message = `module-contract（${testIssue.code}）：${testIssue.message}`;
      return mode === 'hard'
        ? block(GATE_ID_MODULE_CONTRACT_POST_MUTATE, [message], { issue: testIssue })
        : warn(GATE_ID_MODULE_CONTRACT_POST_MUTATE, [message], { issue: testIssue });
    }
  }
  if (paths.implRelPath) {
    const implIssue = lintImplExportsAgainstModuleContract({
      workspaceRoot: ws,
      implRelPath: paths.implRelPath,
      semantic,
      sliceArtifacts,
      globalArtifacts,
      sliceDecisionRecord,
      crossSliceExports: new Set([
        ...collectSliceExportSymbolsFromInstance(
          instance.stageRuntimes,
          DECISION_ARTIFACTS_OUTPUT_KEY,
          semantic,
        ),
        // 其它切片的模块名（store/pipeline…）——main `from store import …` 时模块名本身
        // 不可 re-import，decide 却常把它列进 main 契约；同属下游噪声，豁免。
        ...collectAllProjectModuleNamesFromInstance(
          instance.stageRuntimes,
          DECISION_ARTIFACTS_OUTPUT_KEY,
        ).filter((n) => n !== semantic),
      ]),
    });
    if (implIssue) {
      const message = `module-contract（${implIssue.code}）：${implIssue.message}`;
      return mode === 'hard'
        ? block(GATE_ID_MODULE_CONTRACT_POST_MUTATE, [message], { issue: implIssue })
        : warn(GATE_ID_MODULE_CONTRACT_POST_MUTATE, [message], { issue: implIssue });
    }
    const forwardIssue = lintForwardSliceImportsInImpl({
      workspaceRoot: ws,
      implRelPath: paths.implRelPath,
      currentSemantic: semantic,
      sliceOrder: collectWorkflowSliceOrder(instance.definition),
    });
    if (forwardIssue) {
      const message = `module-contract（${forwardIssue.code}）：${forwardIssue.message}`;
      return mode === 'hard'
        ? block(GATE_ID_MODULE_CONTRACT_POST_MUTATE, [message], { issue: forwardIssue })
        : warn(GATE_ID_MODULE_CONTRACT_POST_MUTATE, [message], { issue: forwardIssue });
    }
  }
  return null;
}

export function evaluateExportContractPostImplGate(ctx: QualityGateContext): GateResult | null {
  const stage = ctx.stage;
  const instance = ctx.instance;
  const ws = ctx.taskWorkspaceAbs ?? ctx.executionHost?.getWorkspaceRootAbsolute();
  if (!stage || !instance || !ws) {
    return null;
  }
  if (!semanticNameFromImplStageId(stage.id)) {
    return null;
  }
  const mode = ctx.executionHost?.readPythonExportContractLintMode() ?? 'warn';
  if (mode === 'off') {
    return null;
  }
  const semantic = resolveSliceSemanticFromMutateStage(stage.id)!;
  const paths = collectSlicePythonPaths(instance.definition, semantic);
  if (!paths.testRelPath || !paths.implRelPath) {
    return null;
  }
  const exportIssues = lintPythonExportContractFromPaths(
    [{ testPath: paths.testRelPath, implPath: paths.implRelPath }],
    (p) => fs.readFileSync(path.join(ws, p), 'utf8'),
  );
  if (exportIssues.length === 0) {
    return null;
  }
  const issue = exportIssues[0]!;
  const message = `python-export-contract（${issue.code}）：${issue.message}`;
  return mode === 'hard'
    ? block(GATE_ID_PYTHON_EXPORT_CONTRACT_POST_IMPL, [message], { issue })
    : warn(GATE_ID_PYTHON_EXPORT_CONTRACT_POST_IMPL, [message], { issue });
}

export function evaluateDeclaredDepsPostMutateGate(ctx: QualityGateContext): GateResult | null {
  const stage = ctx.stage;
  const instance = ctx.instance;
  const ws = ctx.taskWorkspaceAbs ?? ctx.executionHost?.getWorkspaceRootAbsolute();
  if (!stage || !instance || !ws) {
    return null;
  }
  const semantic = resolveSliceSemanticFromMutateStage(stage.id);
  if (!semantic) {
    return null;
  }
  const mode = ctx.executionHost?.readPythonPypiSymbolLintMode() ?? 'warn';
  if (mode === 'off') {
    return null;
  }
  const profile = mutateProfileFromStageId(stage.id);
  const { sliceArtifacts, globalArtifacts } = resolveSliceArtifacts(instance, semantic);
  const paths = collectSlicePythonPaths(instance.definition, semantic);
  const pyFiles = [paths.implRelPath, profile === 'fix' ? paths.testRelPath : undefined].filter(
    (p): p is string => !!p,
  );
  if (pyFiles.length === 0) {
    return null;
  }
  const depIssues = lintDeclaredDependenciesInFiles({
    workspaceRoot: ws,
    pyFiles,
    allowedDeps: collectDeclaredDependenciesFromInstance(
      instance.stageRuntimes,
      DECISION_ARTIFACTS_OUTPUT_KEY,
    ),
    projectModuleNames: collectProjectModuleNames(sliceArtifacts, globalArtifacts),
  });
  if (depIssues.length === 0) {
    return null;
  }
  const issue = depIssues[0]!;
  return mode === 'hard'
    ? block(GATE_ID_PYTHON_DECLARED_DEPS_POST_MUTATE, [issue.message], { issue, profile })
    : warn(GATE_ID_PYTHON_DECLARED_DEPS_POST_MUTATE, [issue.message], { issue, profile });
}
