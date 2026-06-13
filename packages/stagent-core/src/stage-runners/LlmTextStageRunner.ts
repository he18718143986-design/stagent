import { invokeLlmTextForStage } from './LlmTextInvokeStep';
import { persistLlmTextOutputs } from './LlmTextPersistStep';
import { scoreLlmTextConfidenceAndGates } from './LlmTextScoreStep';
import { LOG_PREVIEW_SHORT } from '../LogPreviewLimits';
import type { StageStepContext } from './StageStepContext';
import { readWriteOutputIntegrityMode } from './llm-persist/writeOutputIntegrity';
import { WriteOutputIntegrityMismatchError } from './llm-persist/writeOutputIntegrityAssess';
import { isStageAlreadyHandledError } from './StageControlSignals';
import {
  MAX_MUTATE_GATE_RETRIES,
  MutateGateBlockedError,
} from './llm-persist/mutateGateRetry';
import {
  MAX_TEST_WRITE_GATE_RETRIES,
  TestWriteGateBlockedError,
} from './llm-persist/testWriteGateRetry';
import {
  applyMultiFileBundleOutputs,
  fileOutputKeysForStage,
  isMultiFileBundleStage,
} from './llm-persist/multiFileBundleOutput';
import { isDecisionArtifactsV1, type DecisionArtifactsV1 } from '../commitment/decisionArtifactsSchema';
import { synthesizeSliceDecisionArtifacts } from '../commitment/decisionRecordExports';
import { parseDecisionArtifactsFromText } from '../commitment/parseDecisionArtifacts';
import {
  GLOBAL_ARCHITECTURE_DECIDE_STAGE_ID,
  semanticNameFromDecideStageId,
} from '../workflow/StageIdPatterns';
import {
  DECISION_ARTIFACTS_OUTPUT_KEY,
  PRIMARY_DECISION_OUTPUT_KEY,
} from '../WorkflowOutputKeys';

/** llm-text 工具全路径：LLM 调用 → 落盘/patch → quality/confidence/post-impl gates。 */
export async function runLlmTextStage(
  ctx: StageStepContext,
  attempt: number,
  instanceKey: string,
): Promise<void> {
  const { params, stage, runtime, panel } = ctx;
  const { debugLogLlmPreview, primaryOutputKey } = params;

  let text = await invokeLlmTextForStage(ctx, attempt, panel);
  debugLogLlmPreview?.(stage.id, attempt, {
    chars: text.length,
    head: text.slice(0, LOG_PREVIEW_SHORT),
    tail: text.slice(Math.max(0, text.length - LOG_PREVIEW_SHORT)),
  });

  const outKey = primaryOutputKey(stage);
  if (stage.isDecisionStage) {
    const semantic = semanticNameFromDecideStageId(stage.id);
    const parsed = parseDecisionArtifactsFromText(text, {
      semantic: semantic && stage.id !== GLOBAL_ARCHITECTURE_DECIDE_STAGE_ID ? semantic : undefined,
    });
    if (parsed.markdownBody) {
      text = parsed.markdownBody;
    }
    if (parsed.artifacts) {
      runtime.outputs[DECISION_ARTIFACTS_OUTPUT_KEY] = parsed.artifacts;
      for (const f of parsed.artifacts.files) {
        if (f.key?.trim() && f.content != null) {
          runtime.outputs[f.key.trim()] = String(f.content);
        }
      }
    }
    if (parsed.warnings.length > 0) {
      runtime.outputs._decisionArtifactsWarnings = parsed.warnings;
    }
    runtime.outputs[PRIMARY_DECISION_OUTPUT_KEY] = text;
    if (semantic && stage.id !== GLOBAL_ARCHITECTURE_DECIDE_STAGE_ID) {
      const existing = isDecisionArtifactsV1(runtime.outputs[DECISION_ARTIFACTS_OUTPUT_KEY])
        ? runtime.outputs[DECISION_ARTIFACTS_OUTPUT_KEY]
        : null;
      const globalRt = params.instance.stageRuntimes.find(
        (r) => r.stageId === GLOBAL_ARCHITECTURE_DECIDE_STAGE_ID,
      );
      const globalArtifacts = isDecisionArtifactsV1(globalRt?.outputs?.[DECISION_ARTIFACTS_OUTPUT_KEY])
        ? (globalRt!.outputs![DECISION_ARTIFACTS_OUTPUT_KEY] as DecisionArtifactsV1)
        : null;
      const synthesized = synthesizeSliceDecisionArtifacts(semantic, text, existing, globalArtifacts);
      if (synthesized) {
        runtime.outputs[DECISION_ARTIFACTS_OUTPUT_KEY] = synthesized;
      }
    }
  }
  if (isMultiFileBundleStage(stage)) {
    applyMultiFileBundleOutputs(runtime.outputs, text, fileOutputKeysForStage(stage));
    runtime.outputs[outKey] = String(runtime.outputs[outKey] ?? text);
  } else {
    runtime.outputs[outKey] = text;
  }

  try {
    await persistLlmTextOutputs(ctx, attempt, outKey, instanceKey, text);
  } catch (e) {
    if (
      e instanceof WriteOutputIntegrityMismatchError &&
      readWriteOutputIntegrityMode() === 'retry'
    ) {
      text = await invokeLlmTextForStage(ctx, attempt, panel, { writeIntegrityRetry: true });
      debugLogLlmPreview?.(stage.id, attempt, {
        chars: text.length,
        head: text.slice(0, LOG_PREVIEW_SHORT),
        tail: text.slice(Math.max(0, text.length - LOG_PREVIEW_SHORT)),
      });
      if (isMultiFileBundleStage(stage)) {
        applyMultiFileBundleOutputs(runtime.outputs, text, fileOutputKeysForStage(stage));
        runtime.outputs[outKey] = String(runtime.outputs[outKey] ?? text);
      } else {
        runtime.outputs[outKey] = text;
      }
      try {
        await persistLlmTextOutputs(ctx, attempt, outKey, instanceKey, text, {
          integrityFailClosed: true,
        });
      } catch (inner) {
        if (isStageAlreadyHandledError(inner)) {
          throw inner;
        }
        throw inner;
      }
      params.postMessage(panel, {
        type: 'streamChunk',
        stageId: stage.id,
        chunk: '✅ 落盘完整性已自动重试纠正。\n',
      });
    } else if (isStageAlreadyHandledError(e)) {
      throw e;
    } else {
      throw e;
    }
  }
  // P1/P2：post test_write / impl/fix gate block → 同 stage 带 gate 反馈重写（≤ MAX 次）。
  for (let gateRetry = 0; ; gateRetry++) {
    try {
      await scoreLlmTextConfidenceAndGates(ctx, attempt, instanceKey, panel);
      return;
    } catch (e) {
      if (e instanceof TestWriteGateBlockedError) {
        if (gateRetry >= MAX_TEST_WRITE_GATE_RETRIES) {
          throw e;
        }
        params.postMessage(panel, {
          type: 'streamChunk',
          stageId: stage.id,
          chunk: `⚠️ 测试质量门禁拦截（第 ${gateRetry + 1}/${MAX_TEST_WRITE_GATE_RETRIES} 次自动重写）：${e.messages.join('；')}\n`,
        });
        text = await invokeLlmTextForStage(ctx, attempt, panel, {
          testWriteGateRetryMessages: e.messages,
        });
      } else if (e instanceof MutateGateBlockedError) {
        if (gateRetry >= MAX_MUTATE_GATE_RETRIES) {
          throw e;
        }
        params.postMessage(panel, {
          type: 'streamChunk',
          stageId: stage.id,
          chunk: `⚠️ 实现质量门禁拦截（第 ${gateRetry + 1}/${MAX_MUTATE_GATE_RETRIES} 次自动重写）：${e.messages.join('；')}\n`,
        });
        text = await invokeLlmTextForStage(ctx, attempt, panel, {
          mutateGateRetryMessages: e.messages,
        });
      } else {
        throw e;
      }
      debugLogLlmPreview?.(stage.id, attempt, {
        chars: text.length,
        head: text.slice(0, LOG_PREVIEW_SHORT),
        tail: text.slice(Math.max(0, text.length - LOG_PREVIEW_SHORT)),
      });
      if (isMultiFileBundleStage(stage)) {
        applyMultiFileBundleOutputs(runtime.outputs, text, fileOutputKeysForStage(stage));
        runtime.outputs[outKey] = String(runtime.outputs[outKey] ?? text);
      } else {
        runtime.outputs[outKey] = text;
      }
      await persistLlmTextOutputs(ctx, attempt, outKey, instanceKey, text);
    }
  }
}
