import type * as vscode from '../platform/HostTypes';
import { uiMsg } from '../l10n/uiStrings';
import { evaluateDecisionContentLintGate } from '../DecisionRecordVerify';
import type { WorkflowDefinition } from '../WorkflowDefinition';
import { ERROR_TYPE_INVARIANT_VIOLATION } from '../WorkflowStageErrorHelpers';
import { getStagentConfiguration } from '../settings/getStagentConfiguration';
import { readBehaviorSpecLintMode } from '../settings/SettingsReaders';
import { validateBehaviorSpecForSemantic } from '../commitment/behaviorSpecSchema';
import { coerceDecisionArtifacts } from '../python-contract/ModuleContractLint';
import {
  GLOBAL_ARCHITECTURE_DECIDE_STAGE_ID,
  semanticNameFromDecideStageId,
} from '../workflow/StageIdPatterns';
import type {
  HitlDiagnosticsHost,
  HitlStateHost,
  HitlUiHost,
} from './HitlCoordinatorHost';
import { postHitlStageError } from './postHitlStageError';

export function evaluateApproveDecisionLintOrReject(
  host: HitlStateHost & HitlUiHost & HitlDiagnosticsHost,
  panel: vscode.WebviewPanel,
  stageId: string,
  definition: WorkflowDefinition,
  decisionRecord: string,
): boolean {
  const lintGate = evaluateDecisionContentLintGate(definition.globalConfig, decisionRecord, {
    vscodeDefault: host.isDecisionContentLintVscodeDefault(),
  });
  if (lintGate.outcome !== 'reject') {
    return true;
  }
  host.logUserAction('approve_decision_rejected', {
    stageId,
    violationCodes: lintGate.violationCodes,
  });
  postHitlStageError(
    host,
    panel,
    stageId,
    uiMsg('stagent.hitl.decisionLintRejected', lintGate.rejectionSummary ?? ''),
    ERROR_TYPE_INVARIANT_VIOLATION,
  );
  return false;
}

/**
 * P2（T4 Run #50 根治配套）：必填切片（signals 等）decide 批准前硬校验
 * decisionArtifacts.behaviorSpec；hard 档下缺失/形状非法 → 拒绝批准并触发
 * decide 重试链（与散文 lint 同路径）。返回 true 表示放行。
 */
export function evaluateApproveBehaviorSpecOrReject(
  host: HitlStateHost & HitlUiHost & HitlDiagnosticsHost,
  panel: vscode.WebviewPanel,
  stageId: string,
  decideOutputs: Record<string, unknown>,
  decisionArtifactsOutputKey: string,
  mode: 'off' | 'warn' | 'hard' = readBehaviorSpecLintMode(getStagentConfiguration()),
): boolean {
  if (stageId === GLOBAL_ARCHITECTURE_DECIDE_STAGE_ID) {
    return true;
  }
  const semantic = semanticNameFromDecideStageId(stageId);
  if (!semantic) {
    return true;
  }
  if (mode !== 'hard') {
    return true;
  }
  const artifacts = coerceDecisionArtifacts(decideOutputs[decisionArtifactsOutputKey]);
  const moduleExports =
    artifacts?.modules?.find((m) => m.name === semantic)?.exports ?? undefined;
  const violations = validateBehaviorSpecForSemantic(
    semantic,
    artifacts?.behaviorSpec,
    moduleExports,
  );
  if (violations.length === 0) {
    return true;
  }
  host.logUserAction('approve_decision_rejected', {
    stageId,
    violationCodes: violations.map((v) => v.code),
  });
  postHitlStageError(
    host,
    panel,
    stageId,
    `behaviorSpec 硬校验未通过：${violations.map((v) => v.message).join('；')}。请按 system 中 BEHAVIOR_SPEC 要求在 decisionArtifacts.behaviorSpec 输出机读行为规格（functions[].conditions[].id + edge_rules）。`,
    ERROR_TYPE_INVARIANT_VIOLATION,
  );
  return false;
}
