/**
 * P2 轻量 behaviorSpec gate（T4 Run #45/#50 根治续篇）：
 * - 条件 id 覆盖：test_write 产出的测试须引用 behaviorSpec 中每个函数的 condition id
 *   （P1 注入已要求"每个 condition id 至少一条行为级断言"，此处离线复核）。
 * - 函数覆盖：spec.functions 中的函数须在测试中被调用。
 * - edge_rules 确定性检查：`_set_ideal_*` fixture helper 必须先于边界列覆写执行
 *   （Run #45 假红根因：先改 MA 列再调 _set_ideal_* 把边界覆写冲掉）。
 *
 * 校准（轻量原则）：
 * - hard 档只阻断确定性问题（某函数 0 个条件 id 被引用 / _set_ideal_* 顺序违例）；
 * - 部分条件 id 缺失只 warn（避免子串启发式误伤行为等价但未点名 id 的测试）。
 */
import type { BehaviorSpecV1 } from './behaviorSpecSchema';

export interface BehaviorSpecLintIssue {
  code:
    | 'behavior-spec-condition-uncovered'
    | 'behavior-spec-function-uncovered'
    | 'behavior-spec-set-ideal-order';
  message: string;
  /** hard 档下是否阻断（warn 档一律降级为告警）。 */
  hard: boolean;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 测试是否覆盖 behaviorSpec 函数（含 Run #54 单入口 generate_signals("bear") 别名）。 */
function functionAppearsCalledInTest(
  fnName: string,
  testCode: string,
  contractExports?: string[],
): boolean {
  if (new RegExp(`\\b${escapeRegExp(fnName)}\\s*\\(`).test(testCode)) {
    return true;
  }
  const hasUnified =
    contractExports?.includes('generate_signals') || /\bgenerate_signals\s*\(/.test(testCode);
  if (!hasUnified) {
    return false;
  }
  const kind = fnName.replace(/^generate_/, '').replace(/_signal$/, '');
  if (!kind) {
    return false;
  }
  return new RegExp(`\\bgenerate_signals\\s*\\(\\s*["']${escapeRegExp(kind)}`, 'm').test(testCode);
}

/** 切出每个顶层 def 块（测试函数 / fixture helper），用于函数内顺序检查。 */
function splitDefBlocks(code: string): Array<{ name: string; lines: string[] }> {
  const lines = code.split(/\r?\n/);
  const blocks: Array<{ name: string; lines: string[] }> = [];
  let current: { name: string; lines: string[] } | null = null;
  for (const line of lines) {
    const m = /^def\s+([A-Za-z_]\w*)\s*\(/.exec(line);
    if (m) {
      current = { name: m[1]!, lines: [] };
      blocks.push(current);
      continue;
    }
    if (current && (/^\s+\S/.test(line) || line.trim() === '')) {
      current.lines.push(line);
    } else if (line.trim() !== '') {
      current = null;
    }
  }
  return blocks;
}

const SET_IDEAL_CALL_RE = /\b(_set_ideal_\w*)\s*\(/;
/** df["MA5"] = ... / df.loc[...] = ... 这类边界列覆写。 */
const COLUMN_OVERRIDE_RE = /\w+(?:\.loc|\.iloc)?\[["'][A-Za-z_]\w*["']\]\s*=[^=]/;

/** edge_rules 是否声明了 _set_ideal_* 先行纪律（声明才检查，避免误伤无此约定的项目）。 */
function specDeclaresSetIdealOrdering(spec: BehaviorSpecV1): boolean {
  return spec.edge_rules.some((r) => r.includes('_set_ideal_'));
}

function lintSetIdealOrdering(code: string): BehaviorSpecLintIssue[] {
  const issues: BehaviorSpecLintIssue[] = [];
  for (const block of splitDefBlocks(code)) {
    let overrideLine = -1;
    for (let i = 0; i < block.lines.length; i++) {
      const line = block.lines[i]!;
      if (overrideLine < 0 && COLUMN_OVERRIDE_RE.test(line) && !SET_IDEAL_CALL_RE.test(line)) {
        overrideLine = i;
        continue;
      }
      const setIdeal = SET_IDEAL_CALL_RE.exec(line);
      if (setIdeal && overrideLine >= 0) {
        issues.push({
          code: 'behavior-spec-set-ideal-order',
          message: `${block.name}：边界列覆写出现在 ${setIdeal[1]}() 之前，理想态 fixture 会把边界覆写冲掉（edge_rules 要求 _set_ideal_* 先行，再做边界覆写）`,
          hard: true,
        });
        break;
      }
    }
  }
  return issues;
}

/**
 * 用 behaviorSpec SSOT 复核测试文件：条件 id / 函数覆盖 + edge_rules 确定性纪律。
 * contractExports 存在时，仅校验 exports 中声明的函数（与 module-contract 同源，Run #63）。
 */
export function lintTestAgainstBehaviorSpec(
  testCode: string,
  spec: BehaviorSpecV1,
  options?: { contractExports?: string[] },
): BehaviorSpecLintIssue[] {
  const exportSet =
    options?.contractExports?.length && options.contractExports.length > 0
      ? new Set(options.contractExports)
      : null;
  const functions = exportSet
    ? spec.functions.filter((fn) => exportSet.has(fn.name))
    : spec.functions;
  const issues: BehaviorSpecLintIssue[] = [];
  for (const fn of functions) {
    const fnCalled = functionAppearsCalledInTest(fn.name, testCode, options?.contractExports);
    if (!fnCalled) {
      issues.push({
        code: 'behavior-spec-function-uncovered',
        message: `behaviorSpec 函数 ${fn.name}() 未在测试中被调用`,
        hard: true,
      });
      continue;
    }
    const missing = fn.conditions.filter((c) => !testCode.includes(c.id)).map((c) => c.id);
    if (missing.length === fn.conditions.length) {
      issues.push({
        code: 'behavior-spec-condition-uncovered',
        message: `${fn.name}：behaviorSpec 条件 id 全部未被测试引用（${missing.join(', ')}）；每个 condition id 须至少一条行为级断言（注释或测试名引用 id 亦可）`,
        hard: true,
      });
    } else if (missing.length > 0) {
      issues.push({
        code: 'behavior-spec-condition-uncovered',
        message: `${fn.name}：条件 id 未被测试引用：${missing.join(', ')}`,
        hard: false,
      });
    }
  }
  if (specDeclaresSetIdealOrdering(spec)) {
    issues.push(...lintSetIdealOrdering(testCode));
  }
  return issues;
}

/** hard 档下应阻断的子集。 */
export function hardBehaviorSpecIssues(issues: BehaviorSpecLintIssue[]): BehaviorSpecLintIssue[] {
  return issues.filter((i) => i.hard);
}

export function behaviorSpecIssuesToWarnings(
  testRelPath: string,
  issues: BehaviorSpecLintIssue[],
): string[] {
  return issues.map((i) => `behavior-spec（${i.code}）：${testRelPath}: ${i.message}`);
}
