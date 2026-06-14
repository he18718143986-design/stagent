/**
 * M26：测试质量 lint（借鉴 skills `tdd/tests.md`：测行为而非结构/实现）。
 *
 * 检测「假绿」测试坏味：无断言、恒真断言、只断言导入成功/对象存在、断言私有实现细节、
 * sys.modules 劫持被测包。这类测试即使全过也没验证真实行为，是空心成功的温床。
 *
 * 纯函数。`hard: true` 的 issue（无断言 / 恒真 / 弱断言 only / sys.modules 劫持）供
 * post test_write 门禁硬阻断（T4 Run #22 根因）；其余坏味保持 warning-only
 * （`contract:test-*` 前缀，与既有契约告警同通道显示）。
 */

export type TestQualityWarningType =
  | 'test-no-assertion'
  | 'test-tautological-assertion'
  | 'test-tests-implementation'
  | 'test-no-production-import'
  | 'test-inline-impl-double'
  | 'test-mocks-internal-module'
  | 'test-sys-modules-hijack'
  | 'test-brittle-assertion'
  | 'test-self-shadowed-call';

export interface TestQualityIssue {
  type: TestQualityWarningType;
  detail: string;
  /** true = 假绿高危坏味，post test_write 门禁在 hard 模式下应阻断。 */
  hard?: boolean;
}

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

/** 测试须 import 真实生产模块；禁止在测试内重新定义 impl 类（Test Double 逃逸）。 */
export function lintTestProductionBinding(testCode: string): TestQualityIssue[] {
  const issues: TestQualityIssue[] = [];
  const code = testCode ?? '';
  if (!code.trim() || !looksLikeTest(code)) {
    return issues;
  }
  const hasProductionImport = PRODUCTION_IMPORT_RE.test(code);
  const inlineClasses = extractInlineTestClasses(code);
  if (inlineClasses.length > 0 && !hasProductionImport) {
    issues.push({
      type: 'test-no-production-import',
      detail:
        '测试未 import 生产模块（indicators/signals/risk/broker/src/main）；可能为内联 Test Double 假绿',
    });
    issues.push({
      type: 'test-inline-impl-double',
      detail: `测试内联定义 impl 类（${inlineClasses.slice(0, 4).join(', ')}），未绑定真实模块`,
    });
  }
  return issues;
}

// 脆弱断言（T4 Run #23 假红根因，正确实现也无法通过）：
// 1) NaN 身份比较：`x is np.nan` / `is not numpy.nan`（pandas 计算产生的 NaN 非单例）
const NAN_IDENTITY_RE = /\bis\s+(?:not\s+)?(?:np|numpy|pd|pandas)\.(?:nan|NA|NaN)\b/;
// 2) 匹配内置异常的消息原文（随 Python/库版本变化，如 "can't set attribute" → "cannot assign to field"）
const BUILTIN_EXC_MESSAGE_MATCH_RE =
  /pytest\.raises\s*\(\s*(?:AttributeError|TypeError|ValueError|KeyError|IndexError|RuntimeError|NotImplementedError|FrozenInstanceError)\s*,\s*match\s*=/;

/** 脆弱断言（正确实现也会假红）→ hard。 */
export function lintBrittleAssertions(testCode: string): TestQualityIssue[] {
  const issues: TestQualityIssue[] = [];
  const code = testCode ?? '';
  if (!code.trim() || !looksLikeTest(code)) {
    return issues;
  }
  if (NAN_IDENTITY_RE.test(code)) {
    issues.push({
      type: 'test-brittle-assertion',
      detail: 'NaN 身份比较（is np.nan）不可靠：计算产生的 NaN 非单例；应使用 np.isnan()/pd.isna()',
      hard: true,
    });
  }
  if (BUILTIN_EXC_MESSAGE_MATCH_RE.test(code)) {
    issues.push({
      type: 'test-brittle-assertion',
      detail: '匹配内置异常消息原文（pytest.raises(..., match=…)）随 Python 版本变化；应去掉 match 或断言自定义异常',
      hard: true,
    });
  }
  return issues;
}

// 自遮蔽调用（T4 Run #68/#69 假红根因）：`name = name(...)` —— name 被赋值即成为函数局部，
// RHS 调用自身会抛 UnboundLocalError（疑似本应调用同名辅助函数，却被结果赋值覆盖）。
// 正确实现也无法通过，且 fix 链只改 impl 不可救，必须在 test_write 落盘前拦截 → 重写测试。
const SELF_SHADOWED_CALL_RE = /^[ \t]*([A-Za-z_]\w*)\s*=\s*\1\s*\(/gm;

/** 自遮蔽调用 `x = x(...)` 且 x 未在别处定义（def/import/参数）→ hard。 */
export function lintSelfShadowedCall(testCode: string): TestQualityIssue[] {
  const issues: TestQualityIssue[] = [];
  const code = testCode ?? '';
  if (!code.trim() || !looksLikeTest(code)) {
    return issues;
  }
  const reported = new Set<string>();
  for (const m of code.matchAll(SELF_SHADOWED_CALL_RE)) {
    const name = m[1];
    if (!name || reported.has(name)) {
      continue;
    }
    // 注意：模块级 `def name`/`import name` 并不能让 `name = name(...)` 安全——函数内一旦
    // 赋值，name 即全程视为局部，仍 UnboundLocalError。真正安全的只有：
    //   ① name 是所在函数的参数；② 同函数更早已绑定 name；③ 显式 global/nonlocal name。
    const isParam = new RegExp(String.raw`\bdef\s+\w+\s*\([^)]*\b${name}\b`).test(code);
    const declaredGlobal = new RegExp(String.raw`\b(?:global|nonlocal)\s+[^\n]*\b${name}\b`).test(
      code,
    );
    const before = code.slice(0, m.index ?? 0);
    const assignedEarlier = new RegExp(String.raw`^[ \t]*${name}\s*=(?!=)`, 'm').test(before);
    if (isParam || declaredGlobal || assignedEarlier) {
      continue;
    }
    reported.add(name);
    issues.push({
      type: 'test-self-shadowed-call',
      detail: `测试中 \`${name} = ${name}(...)\` 自遮蔽局部变量：调用自身将抛 UnboundLocalError（疑似本应调用同名辅助函数但被结果赋值覆盖）。impl 无法修复，须重写测试为调用真实被测 API 或重命名辅助。`,
      hard: true,
    });
  }
  return issues;
}

/** sys.modules 劫持被测项目包 → hard（fix 链不可改 test，落盘前必须拦截）。 */
export function lintSysModulesHijack(testCode: string): TestQualityIssue[] {
  const issues: TestQualityIssue[] = [];
  const code = testCode ?? '';
  if (!code.trim() || !looksLikeTest(code)) {
    return issues;
  }
  const targets = new Set<string>();
  for (const m of code.matchAll(SYS_MODULES_HIJACK_RE)) {
    const target = (m[1] ?? m[2] ?? m[3])?.trim();
    if (target) {
      targets.add(target);
    }
  }
  if (targets.size > 0) {
    issues.push({
      type: 'test-sys-modules-hijack',
      detail: `sys.modules 劫持被测项目模块（${[...targets].slice(0, 3).join(', ')}），impl 再正确 pytest 也测不到真实代码`,
      hard: true,
    });
  }
  return issues;
}

/** @patch / mock.patch 指向项目内模块 → warn（首版不 hard block）。 */
export function lintInternalModuleMocks(testCode: string): TestQualityIssue[] {
  const issues: TestQualityIssue[] = [];
  const code = testCode ?? '';
  if (!code.trim() || !looksLikeTest(code)) {
    return issues;
  }
  const targets = new Set<string>();
  for (const m of code.matchAll(INTERNAL_MODULE_MOCK_RE)) {
    const target = m[1]?.trim();
    if (target) {
      targets.add(target);
    }
  }
  if (targets.size > 0) {
    issues.push({
      type: 'test-mocks-internal-module',
      detail: `mock/patch 指向项目内模块（${[...targets].slice(0, 3).join(', ')}），可能绕过真实集成`,
    });
  }
  return issues;
}

function hasAnyAssertion(code: string): boolean {
  return code.split(/\r?\n/).some((l) => ASSERT_LINE.test(l));
}

function looksLikeTest(code: string): boolean {
  return /\bdef\s+test_|\bclass\s+Test|\bit\(|\btest\(|unittest|pytest/.test(code);
}

/** 对单段测试代码做质量 lint。 */
export function lintTestQuality(testCode: string): TestQualityIssue[] {
  const issues: TestQualityIssue[] = [];
  const code = testCode ?? '';
  if (!code.trim()) {
    return issues;
  }

  if (looksLikeTest(code) && !hasAnyAssertion(code)) {
    issues.push({
      type: 'test-no-assertion',
      detail: '测试函数缺少任何断言（assert/expect），无法验证行为',
      hard: true,
    });
  }

  if (TAUTOLOGY.test(code)) {
    issues.push({
      type: 'test-tautological-assertion',
      detail: '存在恒真断言（如 assert True / 1==1），等于没测',
      hard: true,
    });
  }

  // 只断言「存在/导入成功」且没有任何其它实质断言 → 仅冒烟，不算测行为
  const assertionLines = code.split(/\r?\n/).filter((l) => ASSERT_LINE.test(l));
  const existenceOnly =
    assertionLines.length > 0 && assertionLines.every((l) => EXISTENCE_ONLY.test(l));
  if (existenceOnly) {
    issues.push({
      type: 'test-tests-implementation',
      detail: '仅断言对象/模块存在（is not None），未验证真实行为或输出',
      hard: true,
    });
  } else if (IMPLEMENTATION_DETAIL.test(code)) {
    issues.push({
      type: 'test-tests-implementation',
      detail: '断言指向私有实现细节（._private），耦合实现而非行为',
    });
  }

  issues.push(...lintTestProductionBinding(code));
  issues.push(...lintInternalModuleMocks(code));
  issues.push(...lintSysModulesHijack(code));
  issues.push(...lintBrittleAssertions(code));
  issues.push(...lintSelfShadowedCall(code));

  return issues;
}

/** 假绿高危坏味（post test_write 门禁 hard 模式阻断集）。 */
export function hardTestQualityIssues(issues: TestQualityIssue[]): TestQualityIssue[] {
  return issues.filter((i) => i.hard === true);
}

/** 转成展示用 warning 行（warning-only）。 */
export function testQualityIssuesToWarnings(filePath: string, issues: TestQualityIssue[]): string[] {
  return issues.map((i) => `contract:${i.type}:${filePath} ${i.detail}`);
}
