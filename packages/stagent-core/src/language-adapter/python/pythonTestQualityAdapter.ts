/**
 * Python 测试质量 detector（从原 `TestQualityLint` 抽出的全部 Python 专用假设）。
 *
 * 仅负责「如何在 Python/pytest 代码里识别坏味」并给出 Python 术语的 detail；
 * 坏味的 type/hard 分级由 core `TestQualityLint` 的 policy 决定。
 *
 * 行为与重构前 `lintTestQuality` 逐条等价（含各子探测的 looksLikeTest 守卫与报告顺序）。
 */
import type {
  LanguageTestQualityAdapter,
  TestQualityFinding,
} from '../LanguageTestQualityAdapter';

const ASSERT_LINE = /\b(assert\b|assertEqual|assertTrue|assertIsNotNone|assertIs|expect\()/;

// 恒真：assert True / assert 1 == 1 / assertTrue(True) / assert "x" / expect(true)
const TAUTOLOGY =
  /\bassert\s+(True|true|1\s*==\s*1|['"][^'"]*['"])\s*(?:,|$)|assertTrue\(\s*True\s*\)|expect\(\s*true\s*\)\.toBe\(\s*true\s*\)/;

// 只验证「导入成功 / 对象存在」：assert module is not None / assert x is not None（无其他行为断言）
const EXISTENCE_ONLY = /\bassert\s+\w+\s+is\s+not\s+None\s*(?:,|$)|assertIsNotNone\(/;

// 断言私有实现细节：assert obj._private ... / patch 内部 _helper
const IMPLEMENTATION_DETAIL = /\bassert\s+[\w.]*\._[A-Za-z]/;

const PRODUCTION_IMPORT_RE =
  /^\s*(from\s+(indicators|signals|risk|broker|src)\b|import\s+(indicators|signals|risk|broker|main)\b)/m;

const INLINE_CLASS_RE = /^\s*class\s+([A-Z][A-Za-z0-9_]*)\s*[:(]/gm;

const INTERNAL_MODULE_MOCK_RE =
  /(?:@patch|patch|mocker\.patch)\s*\(\s*['"]((?:indicators|signals|risk|broker|src|main)\.[^'"]+)['"]/g;

// sys.modules 劫持被测项目包（Run #22 根因）：sys.modules['indicators']=… /
// sys.modules.setdefault('signals', …) / monkeypatch.setitem(sys.modules, 'risk', …)。
// 仅匹配项目内模块名；测试 stub 第三方 SDK（如 ctpbee）不在此列。
const PROJECT_MODULE_NAMES = String.raw`(?:indicators|signals|risk|broker|src|main)(?:\.[\w.]+)?`;
const SYS_MODULES_HIJACK_RE = new RegExp(
  String.raw`sys\.modules\s*\[\s*['"](${PROJECT_MODULE_NAMES})['"]\s*\]\s*=` +
    String.raw`|sys\.modules\.setdefault\s*\(\s*['"](${PROJECT_MODULE_NAMES})['"]` +
    String.raw`|monkeypatch\.setitem\s*\(\s*sys\.modules\s*,\s*['"](${PROJECT_MODULE_NAMES})['"]`,
  'g',
);

// 脆弱断言（T4 Run #23 假红根因，正确实现也无法通过）：
// 1) NaN 身份比较：`x is np.nan` / `is not numpy.nan`（pandas 计算产生的 NaN 非单例）
const NAN_IDENTITY_RE = /\bis\s+(?:not\s+)?(?:np|numpy|pd|pandas)\.(?:nan|NA|NaN)\b/;
// 2) 匹配内置异常的消息原文（随 Python/库版本变化，如 "can't set attribute" → "cannot assign to field"）
const BUILTIN_EXC_MESSAGE_MATCH_RE =
  /pytest\.raises\s*\(\s*(?:AttributeError|TypeError|ValueError|KeyError|IndexError|RuntimeError|NotImplementedError|FrozenInstanceError)\s*,\s*match\s*=/;

function hasAnyAssertion(code: string): boolean {
  return code.split(/\r?\n/).some((l) => ASSERT_LINE.test(l));
}

function looksLikeTest(code: string): boolean {
  return /\bdef\s+test_|\bclass\s+Test|\bit\(|\btest\(|unittest|pytest/.test(code);
}

function extractInlineTestClasses(code: string): string[] {
  const names: string[] = [];
  for (const m of code.matchAll(INLINE_CLASS_RE)) {
    const name = m[1];
    if (name && !name.startsWith('Test')) {
      names.push(name);
    }
  }
  return names;
}

function detectProductionBinding(code: string): TestQualityFinding[] {
  if (!code.trim() || !looksLikeTest(code)) {
    return [];
  }
  const hasProductionImport = PRODUCTION_IMPORT_RE.test(code);
  const inlineClasses = extractInlineTestClasses(code);
  if (inlineClasses.length > 0 && !hasProductionImport) {
    return [
      {
        kind: 'missing-production-import',
        detail:
          '测试未 import 生产模块（indicators/signals/risk/broker/src/main）；可能为内联 Test Double 假绿',
      },
      {
        kind: 'inline-impl-double',
        detail: `测试内联定义 impl 类（${inlineClasses.slice(0, 4).join(', ')}），未绑定真实模块`,
      },
    ];
  }
  return [];
}

function detectInternalModuleMocks(code: string): TestQualityFinding[] {
  if (!code.trim() || !looksLikeTest(code)) {
    return [];
  }
  const targets = new Set<string>();
  for (const m of code.matchAll(INTERNAL_MODULE_MOCK_RE)) {
    const target = m[1]?.trim();
    if (target) {
      targets.add(target);
    }
  }
  if (targets.size > 0) {
    return [
      {
        kind: 'internal-module-mock',
        detail: `mock/patch 指向项目内模块（${[...targets].slice(0, 3).join(', ')}），可能绕过真实集成`,
      },
    ];
  }
  return [];
}

function detectModuleSystemHijack(code: string): TestQualityFinding[] {
  if (!code.trim() || !looksLikeTest(code)) {
    return [];
  }
  const targets = new Set<string>();
  for (const m of code.matchAll(SYS_MODULES_HIJACK_RE)) {
    const target = (m[1] ?? m[2] ?? m[3])?.trim();
    if (target) {
      targets.add(target);
    }
  }
  if (targets.size > 0) {
    return [
      {
        kind: 'module-system-hijack',
        detail: `sys.modules 劫持被测项目模块（${[...targets].slice(0, 3).join(', ')}），impl 再正确 pytest 也测不到真实代码`,
      },
    ];
  }
  return [];
}

function detectBrittleAssertions(code: string): TestQualityFinding[] {
  if (!code.trim() || !looksLikeTest(code)) {
    return [];
  }
  const findings: TestQualityFinding[] = [];
  if (NAN_IDENTITY_RE.test(code)) {
    findings.push({
      kind: 'brittle-assertion',
      detail: 'NaN 身份比较（is np.nan）不可靠：计算产生的 NaN 非单例；应使用 np.isnan()/pd.isna()',
    });
  }
  if (BUILTIN_EXC_MESSAGE_MATCH_RE.test(code)) {
    findings.push({
      kind: 'brittle-assertion',
      detail:
        '匹配内置异常消息原文（pytest.raises(..., match=…)）随 Python 版本变化；应去掉 match 或断言自定义异常',
    });
  }
  return findings;
}

function detectFindings(testCode: string): TestQualityFinding[] {
  const code = testCode ?? '';
  if (!code.trim()) {
    return [];
  }
  const findings: TestQualityFinding[] = [];

  if (looksLikeTest(code) && !hasAnyAssertion(code)) {
    findings.push({
      kind: 'no-assertion',
      detail: '测试函数缺少任何断言（assert/expect），无法验证行为',
    });
  }

  if (TAUTOLOGY.test(code)) {
    findings.push({
      kind: 'tautological-assertion',
      detail: '存在恒真断言（如 assert True / 1==1），等于没测',
    });
  }

  // 只断言「存在/导入成功」且没有任何其它实质断言 → 仅冒烟，不算测行为
  const assertionLines = code.split(/\r?\n/).filter((l) => ASSERT_LINE.test(l));
  const existenceOnly =
    assertionLines.length > 0 && assertionLines.every((l) => EXISTENCE_ONLY.test(l));
  if (existenceOnly) {
    findings.push({
      kind: 'existence-only',
      detail: '仅断言对象/模块存在（is not None），未验证真实行为或输出',
    });
  } else if (IMPLEMENTATION_DETAIL.test(code)) {
    findings.push({
      kind: 'implementation-detail',
      detail: '断言指向私有实现细节（._private），耦合实现而非行为',
    });
  }

  findings.push(...detectProductionBinding(code));
  findings.push(...detectInternalModuleMocks(code));
  findings.push(...detectModuleSystemHijack(code));
  findings.push(...detectBrittleAssertions(code));

  return findings;
}

export const pythonTestQualityAdapter: LanguageTestQualityAdapter = {
  id: 'python',
  looksLikeTest,
  detectFindings,
};
