/**
 * 语言适配接缝（language-adapter seam）· 测试质量探测维度。
 *
 * 背景：`TestQualityLint` 曾把 Python 专用假设（`sys.modules` 劫持、`is not None`
 * 弱断言、`from indicators import`、`@patch('signals…')`、`np.nan` 身份比较等）硬编码进
 * 质量门禁，使引擎「名通用、实 Python 专用」。本接缝把语言知识收敛为可插拔的 adapter：
 *
 * - **policy（语言无关，留在 `TestQualityLint`）**：坏味的「类型 + 是否 hard 阻断」分类学，
 *   即「无断言 / 恒真 / 仅断言存在 / 劫持被测模块 = 假绿高危」这类跨语言成立的纪律。
 * - **detector（语言相关，进 adapter）**：在具体语言里「如何识别」上述坏味、以及如何用该语言的
 *   术语解释（detail）。Python 的 detector 给出 `sys.modules` 正则；TS 版给出 `jest.mock(<被测模块>)`。
 *
 * 新增一门语言 = 实现一个 `LanguageTestQualityAdapter`，core 的 policy 与 gate 框架零改动。
 */

/**
 * 语言无关的坏味种类（policy 把它映射到对外的 `TestQualityWarningType` 与 hard 分级）。
 * 注意：故意不叫 `sys-modules-hijack` 这类 Python 词，让 detector 与 policy 都语言中立。
 */
export type TestQualityFindingKind =
  | 'no-assertion'
  | 'tautological-assertion'
  | 'existence-only'
  | 'implementation-detail'
  | 'missing-production-import'
  | 'inline-impl-double'
  | 'internal-module-mock'
  | 'module-system-hijack'
  | 'brittle-assertion';

/** adapter 探测到的单条坏味：种类（交给 policy 定级）+ 该语言术语的人读说明。 */
export interface TestQualityFinding {
  kind: TestQualityFindingKind;
  detail: string;
}

/**
 * 某语言的测试质量探测器。core policy 只消费 `detectFindings` 的结果，不感知任何语言正则。
 */
export interface LanguageTestQualityAdapter {
  /** 语言标识（如 `python` / `node`）。 */
  id: string;
  /** 该段代码是否「像测试」（决定无断言等是否适用）。 */
  looksLikeTest(code: string): boolean;
  /**
   * 按该语言规则探测全部测试坏味，顺序即对外报告顺序。
   * 各子探测各自决定是否需要 `looksLikeTest` 守卫（与历史行为一致，不做全局包裹）。
   */
  detectFindings(code: string): TestQualityFinding[];
}
