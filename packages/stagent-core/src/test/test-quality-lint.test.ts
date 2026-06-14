import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  hardTestQualityIssues,
  lintTestQuality,
  testQualityIssuesToWarnings,
} from '../TestQualityLint';

test('无断言的测试函数 → test-no-assertion', () => {
  const code = `def test_runs():
    result = process(data)
    print(result)
`;
  const issues = lintTestQuality(code);
  assert.ok(issues.some((i) => i.type === 'test-no-assertion'));
});

test('恒真断言 → test-tautological-assertion', () => {
  const code = `def test_ok():
    assert True
`;
  const issues = lintTestQuality(code);
  assert.ok(issues.some((i) => i.type === 'test-tautological-assertion'));
});

test('自遮蔽调用 expected_cci = expected_cci(...) → test-self-shadowed-call (hard, Run #68/#69)', () => {
  const code = `import numpy as np
from indicators import compute

def test_cci_known_values(sample_long_df, standard_config):
    result = compute(sample_long_df, standard_config)
    expected_cci = expected_cci(sample_long_df, window=89)
    assert np.allclose(result['CCI'].dropna(), expected_cci)
`;
  const issues = lintTestQuality(code);
  const hit = issues.find((i) => i.type === 'test-self-shadowed-call');
  assert.ok(hit, 'should flag self-shadowed call');
  assert.equal(hit?.hard, true);
});

test('合法重赋值/已定义同名不误报 self-shadowed-call', () => {
  // def 定义的辅助函数：x = x(...) 合法
  const okDef = `from indicators import compute

def expected_cci(df, window):
    return df['close'].rolling(window).mean()

def test_cci(sample_long_df):
    result = compute(sample_long_df, {'cci': {'window': 89}})
    expected_cci_val = expected_cci(sample_long_df, 89)
    assert result is not None and expected_cci_val is not None
`;
  assert.equal(
    lintTestQuality(okDef).some((i) => i.type === 'test-self-shadowed-call'),
    false,
  );
  // 参数同名：def f(parser): parser = parser(...) 合法（parser 是参数绑定）
  const okParam = `def test_build(parser):
    parser = parser(prog='x')
    assert parser is not None
`;
  assert.equal(
    lintTestQuality(okParam).some((i) => i.type === 'test-self-shadowed-call'),
    false,
  );
});

test('仅断言对象存在 → test-tests-implementation', () => {
  const code = `import mymod

def test_imports():
    assert mymod is not None
`;
  const issues = lintTestQuality(code);
  assert.ok(issues.some((i) => i.type === 'test-tests-implementation'));
});

test('断言私有实现细节 → test-tests-implementation', () => {
  const code = `def test_internal():
    obj = Service()
    assert obj._cache == {}
    assert obj.public_result() == 42
`;
  const issues = lintTestQuality(code);
  assert.ok(issues.some((i) => i.type === 'test-tests-implementation'));
});

test('测真实行为的健康测试 → 无坏味', () => {
  const code = `def test_diff_marks_price_increase():
    out = run_diff(old=10, new=12)
    assert out.status == "success"
    assert out.alert == "价格上涨"
`;
  const issues = lintTestQuality(code);
  assert.deepEqual(issues, []);
});

test('非测试代码不误报无断言', () => {
  const code = `def helper(x):
    return x + 1
`;
  assert.deepEqual(lintTestQuality(code), []);
});

test('testQualityIssuesToWarnings 生成 contract:test-* 行', () => {
  const issues = lintTestQuality('def test_x():\n    assert True\n');
  const warnings = testQualityIssuesToWarnings('test_x.py', issues);
  assert.ok(warnings.every((w) => w.startsWith('contract:test-')));
});

test('@patch 项目内模块 → test-mocks-internal-module', () => {
  const code = `from unittest.mock import patch

@patch('signals.resonance.check_index')
def test_signal(mock_check):
    mock_check.return_value = True
    assert mock_check() is True
`;
  const issues = lintTestQuality(code);
  assert.ok(issues.some((i) => i.type === 'test-mocks-internal-module'));
});

test('内联 impl 类且无生产 import → test-inline-impl-double', () => {
  const code = `class HedgeManager:
    pass

def test_hedge():
    assert HedgeManager() is not None
`;
  const issues = lintTestQuality(code);
  assert.ok(issues.some((i) => i.type === 'test-inline-impl-double'));
  assert.ok(issues.some((i) => i.type === 'test-no-production-import'));
});

test('productionModules 参数化：非 T4 切片名（T6 models）不被误判为内联 Test Double', () => {
  // 测试 import 了真实切片 models，但同时定义了内联辅助类 FakeClock。
  const code = `from models import validate_task

class FakeClock:
    pass

def test_validate():
    assert validate_task({'title': 'x', 'status': 'todo', 'priority': 3}) == []
`;
  // 默认 T4 模块表里没有 models → 误判「未 import 生产模块」（旧行为，量化任务专属）。
  const withDefault = lintTestQuality(code);
  assert.ok(withDefault.some((i) => i.type === 'test-no-production-import'));
  // 传入当前任务真实切片 → 识别 from models import 为生产绑定，不再误判。
  const withModules = lintTestQuality(code, {
    productionModules: ['models', 'store', 'statemachine', 'pipeline', 'main'],
  });
  assert.ok(!withModules.some((i) => i.type === 'test-no-production-import'));
  assert.ok(!withModules.some((i) => i.type === 'test-inline-impl-double'));
});

test('productionModules 参数化：sys.modules 劫持按真实切片名识别', () => {
  const code = `import sys

def test_hijack():
    sys.modules['store'] = object()
    assert store_loaded() == 1
`;
  // 默认表无 store → 不触发。
  assert.ok(!lintTestQuality(code).some((i) => i.type === 'test-sys-modules-hijack'));
  // 传入 store → 触发 hard 劫持告警。
  assert.ok(
    lintTestQuality(code, { productionModules: ['store'] }).some(
      (i) => i.type === 'test-sys-modules-hijack',
    ),
  );
});

test('sys.modules 赋值劫持项目模块 → test-sys-modules-hijack（hard）', () => {
  const code = `import sys
import types

fake = types.ModuleType('indicators')
sys.modules['indicators'] = fake

def test_compute():
    from indicators import compute_ma
    assert compute_ma([1, 2, 3]) == 2.0
`;
  const issues = lintTestQuality(code);
  const hijack = issues.find((i) => i.type === 'test-sys-modules-hijack');
  assert.ok(hijack);
  assert.equal(hijack.hard, true);
  assert.match(hijack.detail, /indicators/);
});

test('sys.modules.setdefault 劫持子模块 → test-sys-modules-hijack', () => {
  const code = `import sys
sys.modules.setdefault('signals.resonance', stub)

def test_signal():
    assert run_signal() == 'long'
`;
  const issues = lintTestQuality(code);
  assert.ok(issues.some((i) => i.type === 'test-sys-modules-hijack'));
});

test('monkeypatch.setitem(sys.modules, …) 劫持 → test-sys-modules-hijack', () => {
  const code = `def test_risk(monkeypatch):
    monkeypatch.setitem(sys.modules, 'risk', fake_risk)
    assert evaluate() == 'blocked'
`;
  const issues = lintTestQuality(code);
  assert.ok(issues.some((i) => i.type === 'test-sys-modules-hijack'));
});

test('sys.modules stub 第三方 SDK（如 ctpbee）不误报', () => {
  const code = `import sys
sys.modules['ctpbee'] = fake_sdk

def test_order_submit():
    from broker import SimBroker
    assert SimBroker().submit(order).status == 'filled'
`;
  const issues = lintTestQuality(code);
  assert.ok(!issues.some((i) => i.type === 'test-sys-modules-hijack'));
});

test('NaN 身份比较（is np.nan）→ test-brittle-assertion（hard）', () => {
  const code = `import numpy as np

def test_macd_warmup():
    df = compute_macd(prices)
    assert df['macd'].iloc[0] is np.nan
`;
  const issues = lintTestQuality(code);
  const brittle = issues.find((i) => i.type === 'test-brittle-assertion');
  assert.ok(brittle);
  assert.equal(brittle.hard, true);
  assert.match(brittle.detail, /isnan|isna/);
});

test('pytest.raises 匹配内置异常消息原文 → test-brittle-assertion（hard）', () => {
  const code = `import pytest

def test_frozen():
    sig = Signal(direction='long')
    with pytest.raises(AttributeError, match="can't set attribute"):
        sig.direction = 'short'
`;
  const issues = lintTestQuality(code);
  assert.ok(issues.some((i) => i.type === 'test-brittle-assertion' && i.hard === true));
});

test('np.isnan / 自定义异常 match 不误报 brittle', () => {
  const healthy = `import numpy as np
import pytest

def test_macd_warmup():
    df = compute_macd(prices)
    assert np.isnan(df['macd'].iloc[0])

def test_invalid_config():
    with pytest.raises(ConfigError, match='missing fast period'):
        compute_macd(prices, fast=None)
`;
  const issues = lintTestQuality(healthy);
  assert.ok(!issues.some((i) => i.type === 'test-brittle-assertion'));
});

test('hardTestQualityIssues 只保留高危坏味（弱断言/无断言/恒真/sys.modules）', () => {
  const weak = lintTestQuality(`import mymod

def test_imports():
    assert mymod is not None
`);
  assert.ok(hardTestQualityIssues(weak).length > 0);

  const privateDetail = lintTestQuality(`def test_internal():
    obj = Service()
    assert obj._cache == {}
    assert obj.public_result() == 42
`);
  assert.equal(hardTestQualityIssues(privateDetail).length, 0);

  const healthy = lintTestQuality(`def test_diff():
    out = run_diff(old=10, new=12)
    assert out.status == "success"
`);
  assert.equal(hardTestQualityIssues(healthy).length, 0);
});
