import { isDecisionContentLintEnabled } from './DecisionContentLintPolicy';

/**
 * DecisionRecordVerify
 * --------------------
 * 对决策清单（DecisionRecord）正文做内容级结构校验。
 *
 * 对应 SPEC-v3 §4.4「DecisionRecord 强制约束」中 SOFT → HARD 升级的 3 条：
 *   - I-17 必含 4 主节（职责边界 / 关键设计决策 / ★ 边界压力测试 / AI 无法验证的假设）
 *   - I-18 「边界压力测试」节至少 2 个顶层场景
 *   - I-19 「AI 无法验证的假设」节至少 1 条
 *
 * 其余 3 条约束（"为何不选备选"语义 / 字数 / 不含代码块）仍属 SOFT，
 * 由 §8.1 决策质量核查清单 UI 兜底，不在本文件覆盖。
 *
 * 灰度开关：globalConfig.enableDecisionContentLint；M20.2.2 默认 **开启**（显式 false 关闭）。
 *
 * 纯函数，零运行时依赖；可被脚本（未来 verify:all）独立调用。
 */

export type DecisionViolationCode =
  | 'missing-section'
  | 'insufficient-stress-tests'
  | 'insufficient-assumptions';

export type DecisionInvariantId = 'I-17' | 'I-18' | 'I-19';

export interface DecisionViolationDetail {
  section?: string;
  actualCount?: number;
  requiredCount?: number;
}

export interface DecisionViolation {
  code: DecisionViolationCode;
  invariantId: DecisionInvariantId;
  message: string;
  detail?: DecisionViolationDetail;
}

export interface VerifyDecisionRecordResult {
  ok: boolean;
  violations: DecisionViolation[];
}

interface SectionSpec {
  /** 用于错误信息展示的人读名 */
  label: string;
  /** 匹配 SPEC §4.4 模板的标题正则（容忍 ★、空格、(v2.0 新增) 装饰） */
  titleRegex: RegExp;
}

const REQUIRED_SECTIONS: SectionSpec[] = [
  { label: '职责边界', titleRegex: /^###[\t ]+职责边界[\t ]*$/m },
  { label: '关键设计决策', titleRegex: /^###[\t ]+关键设计决策[\t ]*$/m },
  {
    label: '边界压力测试',
    titleRegex: /^###[\t ]+(?:★[\t ]*)?边界压力测试(?:（v2\.0 新增）)?[\t ]*$/m,
  },
  { label: 'AI 无法验证的假设', titleRegex: /^###[\t ]+AI[\t ]*无法验证的假设[\t ]*$/m },
];

const STRESS_TEST_LABEL = '边界压力测试';
const ASSUMPTIONS_LABEL = 'AI 无法验证的假设';

/**
 * 抓取某节标题之后、下一个 `^### ` 或文末之前的正文。
 * 返回 null 表示该节标题不存在。
 */
function extractSectionBody(record: string, titleRegex: RegExp): string | null {
  const titleMatch = titleRegex.exec(record);
  if (!titleMatch) return null;
  const startIdx = titleMatch.index + titleMatch[0].length;
  const rest = record.slice(startIdx);
  const nextHeading = /\n###[\t ]/.exec(rest);
  return nextHeading ? rest.slice(0, nextHeading.index) : rest;
}

/**
 * 计数节内**顶层列表项**（不含嵌套缩进）。
 * 顶层 = 行首零缩进的列表项标记 + 空格 + 内容，且不在代码围栏（```...```）内。
 * 接受的标记：`-` / `*`（无序）以及 `1.` / `1)`（有序编号），以容忍模型/用户用编号列表书写。
 */
function countTopLevelListItems(sectionBody: string): number {
  let count = 0;
  let insideFence = false;
  for (const rawLine of sectionBody.split(/\r?\n/)) {
    const trimmed = rawLine.trimStart();
    if (trimmed.startsWith('```')) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) continue;
    // 顶层（行首零缩进）且为 `- ` / `* ` 或编号（`1.` / `1)`）列表项
    if (/^(?:[-*]|\d+[.)])[\t ]+\S/.test(rawLine)) count++;
  }
  return count;
}

/**
 * 灰度门控结果：WorkflowEngine.approveDecision 根据 outcome 决定推进 / 阻断。
 *  - 'pass'：放行（开关未开 或 内容合规）
 *  - 'reject'：开关已开且内容不合规 → 应推 stageError(invariant-violation)
 */
export interface DecisionContentLintGateResult {
  outcome: 'pass' | 'reject';
  /** 仅 outcome === 'reject' 时存在；用于 stageError.error 文案 */
  rejectionSummary?: string;
  /** 仅 outcome === 'reject' 时存在；用于 logUserAction 详情 */
  violationCodes?: DecisionViolationCode[];
}

/**
 * 纯函数门控：判断是否应阻断 approveDecision。
 *
 * - globalConfig.enableDecisionContentLint === false → 'pass'
 * - 未设 / true（M20.2.2 default）+ verifyDecisionRecord ok → 'pass'
 * - 开关开 + 不合规 → 'reject'，附带聚合后的人读摘要供 stageError 文案使用
 */
export function evaluateDecisionContentLintGate(
  globalConfig: { enableDecisionContentLint?: boolean } | undefined,
  decisionRecord: string,
  options?: { vscodeDefault?: boolean },
): DecisionContentLintGateResult {
  if (!isDecisionContentLintEnabled(globalConfig, options?.vscodeDefault ?? true)) {
    return { outcome: 'pass' };
  }
  const verifyResult = verifyDecisionRecord(decisionRecord);
  if (verifyResult.ok) {
    return { outcome: 'pass' };
  }
  const rejectionSummary = verifyResult.violations
    .map((v) => `${v.invariantId}: ${v.message}`)
    .join('；');
  return {
    outcome: 'reject',
    rejectionSummary,
    violationCodes: verifyResult.violations.map((v) => v.code),
  };
}

/** AFK decide 重试注释 SSOT（须与 REQUIRED_SECTIONS 一致；T4 Run #47 误写「背景/问题」导致重试仍拒）。 */
export function buildDecisionLintRetryUserComment(): string {
  return [
    '决策记录被内容 lint 拒绝（缺少必需章节）。请重新输出完整结构化 decisionRecord，必须严格包含以下四个 Markdown 三级标题（###）：',
    '### 职责边界',
    '### 关键设计决策',
    '### 边界压力测试（至少 2 个顶层列表场景）',
    '### AI 无法验证的假设（至少 1 条）',
    '只输出决策内容本身，不要解释这次重写。',
  ].join('\n');
}

/**
 * behaviorSpec 硬校验拒绝后的重试反馈（T4 Run #66 根治）。
 * 与 `buildDecisionLintRetryUserComment` 区分：behaviorSpec 拒绝时必须补的是
 * 机读行为规格 `decisionArtifacts.behaviorSpec`，而非 I-17 章节。沿用旧的
 * 章节重试注释会答非所问，导致重试仍缺 spec。
 */
export function buildBehaviorSpecRetryUserComment(): string {
  return [
    '决策被 behaviorSpec 硬校验拒绝：必须在 decisionArtifacts.behaviorSpec 输出机读行为规格。',
    '请在保留原有 decisionRecord 章节的同时，补全 behaviorSpec：',
    '- functions[]：每个公开信号函数一条，name 必须在 modules.exports 中；',
    '- 每个 function 的 conditions[]：给出稳定的 id（如 ma_converge / cross_ma20 / cci_double_cross 等）与可读描述；',
    '- edge_rules：声明边界/横盘振荡过滤等不出信号的规则。',
    '只输出决策内容本身（含 decisionArtifacts），不要解释这次重写。',
  ].join('\n');
}

/**
 * 全局架构决策缺 config.yaml 正文时的重试反馈（T4 Run #70 根治）。
 * 下游 `stage_write_config` 以 sourceOutputKey=configContent 落盘 config.yaml；
 * 决策必须在 decisionArtifacts.files 提供该正文，否则交付前一刻才空内容失败。
 */
export function buildArchitectureConfigRetryUserComment(): string {
  return [
    '决策被拒：全局架构决策缺少 config.yaml 正文，下游 stage_write_config 依赖它。',
    '请在 decisionArtifacts.files 中补一条完整记录：',
    '{"key":"configContent","path":"config.yaml","format":"yaml","content":"<完整 config.yaml 正文>"}',
    'content 必须是非空、可被 yaml.safe_load 解析的完整配置（含各模块需要的键，如指标参数、风控点数、数据源、券商参数等）。',
    '只输出决策内容本身（含 decisionArtifacts sidecar），不要解释这次重写。',
  ].join('\n');
}

export function verifyDecisionRecord(record: string): VerifyDecisionRecordResult {
  const violations: DecisionViolation[] = [];
  const text = typeof record === 'string' ? record : '';

  // I-17 章节存在性
  const missingSections: string[] = [];
  for (const sec of REQUIRED_SECTIONS) {
    if (!sec.titleRegex.test(text)) {
      missingSections.push(sec.label);
    }
  }
  if (missingSections.length > 0) {
    for (const label of missingSections) {
      violations.push({
        code: 'missing-section',
        invariantId: 'I-17',
        message: `决策清单缺少必要章节：「### ${label}」`,
        detail: { section: label },
      });
    }
  }

  // I-18 边界压力测试 ≥ 2
  const stressBody = extractSectionBody(
    text,
    REQUIRED_SECTIONS.find((s) => s.label === STRESS_TEST_LABEL)!.titleRegex,
  );
  if (stressBody !== null) {
    const n = countTopLevelListItems(stressBody);
    if (n < 2) {
      violations.push({
        code: 'insufficient-stress-tests',
        invariantId: 'I-18',
        message: `「边界压力测试」节场景数不足（当前 ${n}，至少 2）`,
        detail: { section: STRESS_TEST_LABEL, actualCount: n, requiredCount: 2 },
      });
    }
  }

  // I-19 假设 ≥ 1
  const assumpBody = extractSectionBody(
    text,
    REQUIRED_SECTIONS.find((s) => s.label === ASSUMPTIONS_LABEL)!.titleRegex,
  );
  if (assumpBody !== null) {
    const n = countTopLevelListItems(assumpBody);
    if (n < 1) {
      violations.push({
        code: 'insufficient-assumptions',
        invariantId: 'I-19',
        message: `「AI 无法验证的假设」节条目数不足（当前 ${n}，至少 1）`,
        detail: { section: ASSUMPTIONS_LABEL, actualCount: n, requiredCount: 1 },
      });
    }
  }

  return { ok: violations.length === 0, violations };
}
