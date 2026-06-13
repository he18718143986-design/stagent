import { executeImplWithHollowGuard } from '../ImplOutputExecution';
import { applyPreStageQualityGates } from '../WorkflowStagePreGates';
import type { ToolPathBase } from '../WorkflowDefinition';
import type { PanelLike } from '../WorkflowExecutorTypes';
import {
  buildDeclaredDependenciesPromptSuffix,
} from '../commitment/decisionArtifactsSchema';
import {
  buildBehaviorSpecDecidePromptSuffix,
  buildBehaviorSpecPromptSuffix,
} from '../commitment/behaviorSpec';
import {
  buildCrossModulePatchExportsPromptSuffix,
  buildSliceContractExportsPromptSuffix,
  resolveSliceContractExports,
} from '../commitment/sliceContractExports';
import { DECISION_ARTIFACTS_OUTPUT_KEY } from '../WorkflowOutputKeys';
import {
  isFixIfFailedStageId,
  resolveTestRunStageIdFromFix,
  semanticFromFixIfFailedStageId,
  semanticFromRuntimeReplanImplFixStageId,
} from '../runtime-replan/FixExhaustedRouter';
import { isImplStageId, isTestWriteStageId, semanticNameFromImplStageId, semanticNameFromTestWriteStageId } from '../workflow/StageIdPatterns';
import { collectWorkflowSliceOrder } from '../python-contract/ForwardSliceImportLint';
import { buildFixRoutingPromptSuffix } from './llm-persist/fixRoutingPromptSuffix';
import { resolveEffectiveRetryComment } from '../retry/FailureSnapshot';
import { StageAlreadyHandledError } from './StageControlSignals';
import type { StageStepContext } from './StageStepContext';

import {
  WRITE_INTEGRITY_RETRY_SYSTEM_APPEND,
  WRITE_INTEGRITY_RETRY_USER_APPEND,
} from './llm-persist/writeOutputIntegrityAssess';
import {
  buildMutateGateRetrySystemAppend,
  buildMutateGateRetryUserAppend,
} from './llm-persist/mutateGateRetry';
import {
  buildTestWriteGateRetrySystemAppend,
  buildTestWriteGateRetryUserAppend,
} from './llm-persist/testWriteGateRetry';
import { buildWriteOutputPromptSuffix } from './llm-persist/writeOutputPromptSuffix';
import { buildApiAlignPromptSuffix } from './llm-persist/decisionApiAlignPromptSuffix';
import {
  buildConfigYamlBridgePromptSuffix,
  buildFixTestGreenBridgePromptSuffix,
  buildIntegrationApiBridgePromptSuffix,
  buildTestGreenBridgePromptSuffix,
  buildTestRewriteImplBridgePromptSuffix,
} from './llm-persist/testImportBridgePromptSuffix';
import { semanticFromRuntimeReplanTestFixStageId } from '../runtime-replan/constants';
import { buildTestWriteImportPromptSuffix } from './llm-persist/testWriteImportPromptSuffix';

export type InvokeLlmTextOptions = {
  writeIntegrityRetry?: boolean;
  /** post test_write 质量门禁 block 后的同 stage 重写（注入 gate 报告与硬规则）。 */
  testWriteGateRetryMessages?: string[];
  /** post impl/fix 质量门禁 block 后的同 stage 重写。 */
  mutateGateRetryMessages?: string[];
};

export async function invokeLlmTextForStage(
  ctx: StageStepContext,
  attempt: number,
  panel: PanelLike,
  options?: InvokeLlmTextOptions,
): Promise<string> {
  const { params, stage, runtime } = ctx;
  const { resolveInput, executeLlmText } = params;
  const tc = stage.toolConfig as {
    type: 'llm-text';
    systemPrompt: string;
    writeOutputToFile?: string;
    writePathBase?: ToolPathBase;
    additionalWriteTargets?: string[];
  };
  let sys = tc.systemPrompt ?? '';
  if (stage.isDecisionStage) {
    const decideBehaviorSuffix = buildBehaviorSpecDecidePromptSuffix(stage.id, sys);
    if (decideBehaviorSuffix) {
      sys += `\n\n${decideBehaviorSuffix}`;
    }
  }
  if (tc.writeOutputToFile?.trim()) {
    sys += `\n\n${buildWriteOutputPromptSuffix(tc.writeOutputToFile.trim())}`;
  }
  if (isTestWriteStageId(stage.id)) {
    const importSuffix = buildTestWriteImportPromptSuffix(ctx.instance.definition, stage);
    if (importSuffix) {
      sys += `\n\n${importSuffix}`;
    }
  }
  const depsSuffix = buildDeclaredDependenciesPromptSuffix(
    ctx.instance.stageRuntimes,
    DECISION_ARTIFACTS_OUTPUT_KEY,
  );
  if (depsSuffix && (isTestWriteStageId(stage.id) || isImplStageId(stage.id) || isFixIfFailedStageId(stage.id))) {
    sys += `\n\n${depsSuffix}`;
  }
  if (isTestWriteStageId(stage.id) || isImplStageId(stage.id)) {
    const contractSuffix = buildSliceContractExportsPromptSuffix(
      ctx.instance.definition,
      ctx.instance.stageRuntimes,
      stage,
    );
    if (contractSuffix) {
      sys += `\n\n${contractSuffix}`;
    } else {
      const apiSuffix = buildApiAlignPromptSuffix(
        ctx.instance.definition,
        ctx.instance.stageRuntimes,
        stage,
      );
      if (apiSuffix) {
        sys += `\n\n${apiSuffix}`;
      }
    }
    if (isTestWriteStageId(stage.id)) {
      const crossPatchSuffix = buildCrossModulePatchExportsPromptSuffix(
        ctx.instance.definition,
        ctx.instance.stageRuntimes,
        stage,
      );
      if (crossPatchSuffix) {
        sys += `\n\n${crossPatchSuffix}`;
      }
      const testWriteSemantic = semanticNameFromTestWriteStageId(stage.id);
      if (testWriteSemantic === 'main') {
        const apiBridge = buildIntegrationApiBridgePromptSuffix(
          ctx.instance.definition,
          'main',
          params.getWorkspaceRoot?.(),
        );
        if (apiBridge) {
          sys += `\n\n${apiBridge}`;
        }
      }
      const behaviorSuffix = buildBehaviorSpecPromptSuffix(
        ctx.instance.stageRuntimes,
        stage,
        'test_write',
      );
      if (behaviorSuffix) {
        sys += `\n\n${behaviorSuffix}`;
      }
    } else {
      const behaviorSuffix = buildBehaviorSpecPromptSuffix(
        ctx.instance.stageRuntimes,
        stage,
        'impl',
      );
      if (behaviorSuffix) {
        sys += `\n\n${behaviorSuffix}`;
      }
    }
  }
  if (isImplStageId(stage.id)) {
    const tcImpl = stage.toolConfig as { writeOutputToFile?: string };
    const bridgeSuffix = buildTestGreenBridgePromptSuffix(
      ctx.instance.definition,
      stage,
      params.getWorkspaceRoot?.(),
    );
    if (bridgeSuffix) {
      sys += `\n\n${bridgeSuffix}`;
    }
    const configBridge = buildConfigYamlBridgePromptSuffix(
      ctx.instance.stageRuntimes,
      tcImpl.writeOutputToFile,
    );
    if (configBridge) {
      sys += `\n\n${configBridge}`;
    }
    const implSemantic = semanticNameFromImplStageId(stage.id);
    if (implSemantic) {
      const apiBridge = buildIntegrationApiBridgePromptSuffix(
        ctx.instance.definition,
        implSemantic,
        params.getWorkspaceRoot?.(),
      );
      if (apiBridge) {
        sys += `\n\n${apiBridge}`;
      }
    }
  }
  {
    // testfix replan：注入实现源码 SSOT，禁止 LLM 虚构 API（T4 Run #24 根治）。
    const testFixSemantic = semanticFromRuntimeReplanTestFixStageId(stage.id);
    if (testFixSemantic) {
      const testRunRt = ctx.instance.stageRuntimes.find(
        (r) => r.stageId === `stage_test_run_${testFixSemantic}`,
      );
      const implBridge = buildTestRewriteImplBridgePromptSuffix(
        ctx.instance.definition,
        testFixSemantic,
        params.getWorkspaceRoot?.(),
        testRunRt,
      );
      if (implBridge) {
        sys += `\n\n${implBridge}`;
      }
      const behaviorSuffix = buildBehaviorSpecPromptSuffix(
        ctx.instance.stageRuntimes,
        stage,
        'testfix',
      );
      if (behaviorSuffix) {
        sys += `\n\n${behaviorSuffix}`;
      }
    }
  }
  {
    const fixSemantic =
      semanticFromFixIfFailedStageId(stage.id) ??
      semanticFromRuntimeReplanImplFixStageId(stage.id);
    if (fixSemantic) {
      const testRunId = isFixIfFailedStageId(stage.id)
        ? resolveTestRunStageIdFromFix(stage.id)
        : `stage_test_run_${fixSemantic}`;
      const testRunRt = testRunId
        ? ctx.instance.stageRuntimes.find((r) => r.stageId === testRunId)
        : undefined;
      if (isFixIfFailedStageId(stage.id)) {
        const contractExports =
          resolveSliceContractExports(
            ctx.instance.definition,
            ctx.instance.stageRuntimes,
            fixSemantic,
          ) ?? undefined;
        sys += buildFixRoutingPromptSuffix({
          testRunRuntime: testRunRt,
          contractExports,
          additionalTargets: tc.additionalWriteTargets,
          semantic: fixSemantic,
          stageRuntimes: ctx.instance.stageRuntimes,
          sliceOrder: collectWorkflowSliceOrder(ctx.instance.definition),
        });
      }
      const fixBridge = buildFixTestGreenBridgePromptSuffix(
        ctx.instance.definition,
        fixSemantic,
        params.getWorkspaceRoot?.(),
        testRunRt,
      );
      if (fixBridge) {
        sys += `\n\n${fixBridge}`;
      }
      const fixApiBridge = buildIntegrationApiBridgePromptSuffix(
        ctx.instance.definition,
        fixSemantic,
        params.getWorkspaceRoot?.(),
      );
      if (fixApiBridge) {
        sys += `\n\n${fixApiBridge}`;
      }
      const fixTc = stage.toolConfig as { writeOutputToFile?: string };
      const configBridge = buildConfigYamlBridgePromptSuffix(
        ctx.instance.stageRuntimes,
        fixTc.writeOutputToFile,
      );
      if (configBridge) {
        sys += `\n\n${configBridge}`;
      }
    }
  }
  // 自动重试上下文只注入 system prompt，不写 runtime.retryComment（RedGreen FSM 仍只看用户 comment）。
  const retryComment = resolveEffectiveRetryComment({
    instance: ctx.instance,
    stageId: stage.id,
    userComment: runtime.retryComment ?? '',
  });
  if (retryComment) {
    sys += `\n\n用户修改意见：${retryComment}`;
  }
  if (options?.writeIntegrityRetry) {
    sys += `\n\n${WRITE_INTEGRITY_RETRY_SYSTEM_APPEND}`;
  }
  if (options?.testWriteGateRetryMessages?.length) {
    sys += `\n\n${buildTestWriteGateRetrySystemAppend(options.testWriteGateRetryMessages)}`;
  }
  if (options?.mutateGateRetryMessages?.length) {
    sys += `\n\n${buildMutateGateRetrySystemAppend(options.mutateGateRetryMessages)}`;
  }
  let userContent = await resolveInput(stage, runtime, panel);
  if (options?.writeIntegrityRetry) {
    userContent += `\n\n${WRITE_INTEGRITY_RETRY_USER_APPEND}`;
  }
  if (options?.testWriteGateRetryMessages?.length) {
    userContent += `\n\n${buildTestWriteGateRetryUserAppend()}`;
  }
  if (options?.mutateGateRetryMessages?.length) {
    userContent += `\n\n${buildMutateGateRetryUserAppend()}`;
  }
  if (isImplStageId(stage.id)) {
    const gateImpl = await applyPreStageQualityGates(params, stage, ctx.stageIndex, 'before-impl', attempt);
    if (gateImpl === 'failed') {
      throw new StageAlreadyHandledError('pre-impl-quality-gate-failed');
    }
    const guarded = await executeImplWithHollowGuard(sys, userContent, (nextSys, nextUser) =>
      executeLlmText(stage.id, nextSys, nextUser, panel),
    );
    if (guarded.note) {
      runtime.outputs._implExecNote = guarded.note;
    }
    return guarded.text;
  }
  return executeLlmText(stage.id, sys, userContent, panel);
}
