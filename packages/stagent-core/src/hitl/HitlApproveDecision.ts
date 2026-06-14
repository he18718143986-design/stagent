import type * as vscode from '../platform/HostTypes';
import { describeApproveDecisionRejection } from '../ApproveDecisionGate';
import { markDecisionApproved } from '../WorkflowStateTransitions';
import { emitStageDoneAdvancePersist } from '../WorkflowEngineContinuation';
import { primaryOutputKey } from '../WorkflowInputContent';
import {
  evaluateApproveArchitectureConfigOrReject,
  evaluateApproveBehaviorSpecOrReject,
  evaluateApproveDecisionLintOrReject,
} from './DecisionLintGate';
import {
  ensureDecisionRecordOutput,
  scheduleDecisionApprovePersistence,
} from './DecisionApprovePersistence';
import {
  COMMITMENT_SNAPSHOT_OUTPUT_KEY,
  extractCommitmentSnapshot,
  type DecisionArtifactsV1,
  isDecisionArtifactsV1,
} from '../commitment';
import { synthesizeSliceDecisionArtifacts } from '../commitment/decisionRecordExports';
import {
  GLOBAL_ARCHITECTURE_DECIDE_STAGE_ID,
  semanticNameFromDecideStageId,
} from '../workflow/StageIdPatterns';
import { DECISION_ARTIFACTS_OUTPUT_KEY } from '../WorkflowOutputKeys';
import type { HitlCoordinatorHost } from './HitlCoordinatorHost';
import { findHitlStage } from './resolveHitlStage';

export async function handleApproveDecision(
  host: HitlCoordinatorHost,
  stageId: string,
  decisionRecord: string,
  panel: vscode.WebviewPanel,
  instanceKey?: string,
): Promise<void> {
  host.bindPanel(panel);
  if (!host.ensureInstanceBound(instanceKey, panel)) {
    return;
  }
  const instance = host.getInstance();
  if (!instance) {
    host.rejectApproveDecision(panel, stageId, '未绑定任务实例，请从侧栏重新打开该任务后再批准决策。');
    return;
  }
  const binding = findHitlStage(instance, stageId);
  const idx = binding?.idx ?? -1;
  const rt = binding?.rt;
  const stage = binding?.stage;
  const gateReason = describeApproveDecisionRejection({
    hasInstance: true,
    stageFound: idx >= 0,
    stageIndex: idx,
    currentStageIndex: instance.currentStageIndex,
    isDecisionStage: stage?.isDecisionStage === true,
    status: rt?.status ?? 'pending',
  });
  if (gateReason) {
    host.rejectApproveDecision(panel, stageId, gateReason);
    return;
  }
  if (!stage || !rt) {
    return;
  }

  if (!evaluateApproveDecisionLintOrReject(host, panel, stageId, instance.definition, decisionRecord)) {
    return;
  }

  if (
    !evaluateApproveBehaviorSpecOrReject(
      host,
      panel,
      stageId,
      rt.outputs,
      DECISION_ARTIFACTS_OUTPUT_KEY,
    )
  ) {
    return;
  }

  if (
    !evaluateApproveArchitectureConfigOrReject(host, panel, stageId, instance.definition, rt.outputs)
  ) {
    return;
  }

  host.logUserAction('approve_decision', { stageId, decisionChars: decisionRecord.length });
  markDecisionApproved(
    stage,
    rt,
    decisionRecord,
    String(rt.outputs[primaryOutputKey(stage)] ?? ''),
    new Date().toISOString(),
  );

  const semantic = semanticNameFromDecideStageId(stageId);
  if (semantic && stageId !== GLOBAL_ARCHITECTURE_DECIDE_STAGE_ID) {
    const existing = isDecisionArtifactsV1(rt.outputs[DECISION_ARTIFACTS_OUTPUT_KEY])
      ? (rt.outputs[DECISION_ARTIFACTS_OUTPUT_KEY] as DecisionArtifactsV1)
      : null;
    const synthesized = synthesizeSliceDecisionArtifacts(semantic, decisionRecord, existing);
    if (synthesized) {
      rt.outputs[DECISION_ARTIFACTS_OUTPUT_KEY] = synthesized;
    }
  }

  if (host.isContractCommitmentsEnabled()) {
    const rawArtifacts = rt.outputs[DECISION_ARTIFACTS_OUTPUT_KEY];
    const decisionArtifacts = isDecisionArtifactsV1(rawArtifacts)
      ? (rawArtifacts as DecisionArtifactsV1)
      : null;
    const snapshot = extractCommitmentSnapshot({
      stageId,
      decisionRecord,
      workflow: instance.definition,
      decisionArtifacts,
    });
    rt.outputs[COMMITMENT_SNAPSHOT_OUTPUT_KEY] = snapshot;
    host.debugLog(stageId, 'commitment_snapshot', 0, {
      count: snapshot.commitments.length,
      warnings: snapshot.parserWarnings.length,
    });
  }

  scheduleDecisionApprovePersistence(host, stage, rt, decisionRecord);
  ensureDecisionRecordOutput(host, rt, stageId, decisionRecord);

  emitStageDoneAdvancePersist({
    emit: (msg) => host.postMessage(panel, msg),
    stageId,
    decisionUiFlag: true,
    bumpStageIndex: () => host.bumpCurrentStageIndex(),
    scheduleSave: () => host.scheduleSave(),
  });
  host.persistMilestone();
  await host.executeNextStage(panel);
}
