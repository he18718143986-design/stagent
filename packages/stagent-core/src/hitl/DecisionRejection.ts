/**
 * 决策阶段「批准被拒」错误的单一事实源（SSOT）。
 *
 * 背景（T4 Run #66 根治）：决策阶段有两条独立的「批准被拒」路径——
 *   1. 内容 lint 拒绝（缺 I-17 必需章节）→ `evaluateApproveDecisionLintOrReject`
 *   2. behaviorSpec 硬校验拒绝（signals 等切片缺机读行为规格）→ `evaluateApproveBehaviorSpecOrReject`
 *
 * 这两条路径过去发出**互不一致**的 stageError 文案：内容 lint 路径恰好携带
 * `decisionLintRejected` 字样，而 behaviorSpec 路径只发中文文案。AFK 驾驶员
 * （headless 与真实 UI）用「是否包含 decisionLintRejected」来判定是否重试 decide，
 * 于是 behaviorSpec 拒绝**永不被重试** → 决策 stage 停在 paused → 整轮挂死到 timeout。
 *
 * 根治：两条拒绝路径统一经过本模块格式化，使 stageError 始终携带稳定可机读的
 * marker 与 kind；并导出检测谓词供任何 AFK 驾驶员复用，避免再次依赖脆弱的子串匹配。
 */

/** 稳定 marker：决策批准被拒的 stageError 必含此字样（向后兼容历史子串匹配）。 */
export const DECISION_LINT_REJECTED_MARKER = 'decisionLintRejected';

/** 决策拒绝的种类，决定 AFK 重试时注入哪种反馈注释。 */
export type DecisionRejectionKind = 'content-lint' | 'behavior-spec' | 'arch-config';

const KNOWN_KINDS: ReadonlySet<string> = new Set(['content-lint', 'behavior-spec', 'arch-config']);

const KIND_RE = new RegExp(`\\[${DECISION_LINT_REJECTED_MARKER}:([a-z-]+)\\]`);

/**
 * 统一格式化决策拒绝错误文案：`[decisionLintRejected:<kind>] <可读详情>`。
 * 既携带机读 marker + kind，又保留人读详情（含原中文说明）。
 */
export function formatDecisionRejectionError(kind: DecisionRejectionKind, detail: string): string {
  const body = detail.trim();
  return `[${DECISION_LINT_REJECTED_MARKER}:${kind}] ${body}`.trim();
}

/** 该 stageError 是否为「决策批准被拒（可重试）」。供 AFK 驾驶员判定重试。 */
export function isDecisionLintRejectedError(error: unknown): boolean {
  return typeof error === 'string' && error.includes(DECISION_LINT_REJECTED_MARKER);
}

/** 从拒绝错误文案解析 kind（无法识别时默认 content-lint，保持历史行为）。 */
export function decisionRejectionKindFromError(error: unknown): DecisionRejectionKind | undefined {
  if (typeof error !== 'string' || !error.includes(DECISION_LINT_REJECTED_MARKER)) {
    return undefined;
  }
  const m = KIND_RE.exec(error);
  if (m && KNOWN_KINDS.has(m[1]!)) {
    return m[1] as DecisionRejectionKind;
  }
  return 'content-lint';
}
