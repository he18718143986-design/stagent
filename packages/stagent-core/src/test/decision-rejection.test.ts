/**
 * T4 Run #66 根治回归：决策阶段两条「批准被拒」路径必须发出统一可机读的
 * stageError，使 AFK 驾驶员（headless / UI）都能检测并重试，避免 behaviorSpec
 * 拒绝因文案不含 marker 而永不重试 → 决策 stage 停 paused → 整轮挂死到 timeout。
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  DECISION_LINT_REJECTED_MARKER,
  formatDecisionRejectionError,
  isDecisionLintRejectedError,
  decisionRejectionKindFromError,
} from '../hitl/DecisionRejection';
import {
  evaluateApproveArchitectureConfigOrReject,
  evaluateApproveBehaviorSpecOrReject,
  evaluateApproveDecisionLintOrReject,
} from '../hitl/DecisionLintGate';
import { decideStageIdFromSemanticName } from '../workflow/StageIdPatterns';
import { GLOBAL_ARCHITECTURE_DECIDE_STAGE_ID } from '../workflow/StageIdPatterns';
import { DECISION_ARTIFACTS_OUTPUT_KEY } from '../WorkflowOutputKeys';
import type { WorkflowDefinition } from '../WorkflowDefinition';

function makeHitlHost() {
  const errors: string[] = [];
  const host = {
    postMessage: (_p: unknown, msg: { type?: string; error?: string }) => {
      if (typeof msg?.error === 'string') {
        errors.push(msg.error);
      }
    },
    getInstance: () => undefined,
    logUserAction: () => {},
    isDecisionContentLintVscodeDefault: () => true,
  } as never;
  return { host, errors };
}

// ---------- 纯函数 SSOT ----------

test('formatDecisionRejectionError：携带 marker + kind + 可读详情', () => {
  const msg = formatDecisionRejectionError('behavior-spec', 'behaviorSpec 硬校验未通过：缺 spec');
  assert.ok(msg.includes(DECISION_LINT_REJECTED_MARKER));
  assert.ok(msg.includes('behavior-spec'));
  assert.ok(msg.includes('behaviorSpec 硬校验未通过'));
});

test('isDecisionLintRejectedError：两类 kind 均可检测；无关错误为 false', () => {
  assert.equal(
    isDecisionLintRejectedError(formatDecisionRejectionError('content-lint', '缺章节')),
    true,
  );
  assert.equal(
    isDecisionLintRejectedError(formatDecisionRejectionError('behavior-spec', '缺 spec')),
    true,
  );
  assert.equal(isDecisionLintRejectedError('tool-execution-failed: code-runner exitCode=1'), false);
  // 历史裸文案（无 marker）正是 Run #66 挂死根因 → 必须为 false（佐证旧路径不可检测）
  assert.equal(isDecisionLintRejectedError('behaviorSpec 硬校验未通过：缺 spec'), false);
  assert.equal(isDecisionLintRejectedError(undefined), false);
});

test('decisionRejectionKindFromError：解析 kind', () => {
  assert.equal(
    decisionRejectionKindFromError(formatDecisionRejectionError('behavior-spec', 'x')),
    'behavior-spec',
  );
  assert.equal(
    decisionRejectionKindFromError(formatDecisionRejectionError('content-lint', 'x')),
    'content-lint',
  );
  assert.equal(decisionRejectionKindFromError('无关错误'), undefined);
});

// ---------- 集成回归：两条拒绝路径都可被 AFK 检测 ----------

test('behaviorSpec 拒绝：发出可被 AFK 检测的 stageError（Run #66 根因回归）', () => {
  const { host, errors } = makeHitlHost();
  const ok = evaluateApproveBehaviorSpecOrReject(
    host,
    {} as never,
    decideStageIdFromSemanticName('signals'),
    {}, // 无 behaviorSpec → 触发硬拒
    DECISION_ARTIFACTS_OUTPUT_KEY,
    'hard',
  );
  assert.equal(ok, false);
  assert.equal(errors.length, 1);
  // 关键断言：错误可被 AFK 驾驶员检测为「可重试的决策拒绝」，且 kind = behavior-spec
  assert.equal(isDecisionLintRejectedError(errors[0]), true);
  assert.equal(decisionRejectionKindFromError(errors[0]), 'behavior-spec');
  assert.match(errors[0]!, /behaviorSpec/);
});

function defWithWriteConfig(): WorkflowDefinition {
  return { stages: [{ id: 'stage_write_config' }] } as unknown as WorkflowDefinition;
}

test('架构决策缺 config.yaml 正文 → 拒绝（kind = arch-config，Run #70 根因回归）', () => {
  const { host, errors } = makeHitlHost();
  const ok = evaluateApproveArchitectureConfigOrReject(
    host,
    {} as never,
    GLOBAL_ARCHITECTURE_DECIDE_STAGE_ID,
    defWithWriteConfig(),
    {}, // 无 configContent / 无 decisionArtifacts.files → 触发拒绝
  );
  assert.equal(ok, false);
  assert.equal(errors.length, 1);
  assert.equal(isDecisionLintRejectedError(errors[0]), true);
  assert.equal(decisionRejectionKindFromError(errors[0]), 'arch-config');
});

test('架构决策含 configContent → 放行；无 write_config 计划 → 放行', () => {
  const { host: h1 } = makeHitlHost();
  assert.equal(
    evaluateApproveArchitectureConfigOrReject(h1, {} as never, GLOBAL_ARCHITECTURE_DECIDE_STAGE_ID, defWithWriteConfig(), {
      configContent: 'broker:\n  simulated: true\n',
    }),
    true,
  );
  // 含 decisionArtifacts.files 的 yaml 也放行
  const { host: h2 } = makeHitlHost();
  assert.equal(
    evaluateApproveArchitectureConfigOrReject(h2, {} as never, GLOBAL_ARCHITECTURE_DECIDE_STAGE_ID, defWithWriteConfig(), {
      [DECISION_ARTIFACTS_OUTPUT_KEY]: {
        version: 1,
        files: [{ key: 'configContent', path: 'config.yaml', format: 'yaml', content: 'x: 1' }],
      },
    }),
    true,
  );
  // 计划无 stage_write_config → 不要求
  const { host: h3 } = makeHitlHost();
  assert.equal(
    evaluateApproveArchitectureConfigOrReject(
      h3,
      {} as never,
      GLOBAL_ARCHITECTURE_DECIDE_STAGE_ID,
      { stages: [] } as unknown as WorkflowDefinition,
      {},
    ),
    true,
  );
});

test('内容 lint 拒绝：发出可被 AFK 检测的 stageError（kind = content-lint）', () => {
  const { host, errors } = makeHitlHost();
  const definition = {
    globalConfig: {},
  } as unknown as WorkflowDefinition;
  // 空 decisionRecord 缺全部 I-17 必需章节 → 内容 lint 拒绝
  const ok = evaluateApproveDecisionLintOrReject(
    host,
    {} as never,
    decideStageIdFromSemanticName('indicators'),
    definition,
    '',
  );
  assert.equal(ok, false);
  assert.equal(errors.length, 1);
  assert.equal(isDecisionLintRejectedError(errors[0]), true);
  assert.equal(decisionRejectionKindFromError(errors[0]), 'content-lint');
});
