import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { resolveModuleExports, sanitizeModuleExports } from '../commitment/decisionArtifactsSchema';
import {
  extractModuleExportsFromDecisionRecord,
  pruneExportNoise,
  shouldPreferGlobalOverSlice,
  synthesizeSliceDecisionArtifacts,
} from '../commitment/decisionRecordExports';

const RUN19_RECORD = `### 关键设计决策
2. **每项指标独立导出函数**：compute_ma, compute_boll, compute_vol, compute_macd, compute_cci 各司其职，信号模块按需调用。
`;

test('extractModuleExportsFromDecisionRecord reads T4 Run #19 prose exports', () => {
  const exports = extractModuleExportsFromDecisionRecord('indicators', RUN19_RECORD);
  assert.deepEqual(exports, [
    'compute_boll',
    'compute_cci',
    'compute_ma',
    'compute_macd',
    'compute_vol',
  ]);
});

test('resolveModuleExports prefers decisionRecord over global coarse exports', () => {
  const global = {
    version: 1 as const,
    files: [],
    modules: [{ name: 'indicators', exports: ['compute'] }],
  };
  const exports = resolveModuleExports('indicators', { version: 1, files: [], modules: [] }, global, RUN19_RECORD);
  assert.ok(exports?.includes('compute_ma'));
  assert.ok(!exports?.includes('compute') || exports.length > 1);
});

test('synthesizeSliceDecisionArtifacts builds modules[] when sidecar missing', () => {
  const artifacts = synthesizeSliceDecisionArtifacts('indicators', RUN19_RECORD, null);
  assert.equal(artifacts?.modules?.length, 1);
  assert.deepEqual(artifacts?.modules?.[0]?.name, 'indicators');
  assert.ok(artifacts?.modules?.[0]?.exports.includes('compute_ma'));
});

test('extractModuleExportsFromDecisionRecord ignores int(0~3) type noise (Run #21 signals)', () => {
  const record = [
    '主方法 `generate` 组合结果。',
    "strength':int(0~3), timestamp:str",
    '采用统一字典 `SignalInput`',
  ].join('\n');
  const exports = extractModuleExportsFromDecisionRecord('signals', record);
  assert.ok(exports?.includes('generate'));
  assert.ok(!exports?.includes('int'));
  assert.ok(!exports?.includes('str'));
  assert.ok(!exports?.includes('SignalInput'));
});

const RUN44_INDICATORS_RECORD = `五个公开函数为 \`calculate_ma\`, \`calculate_boll\`, \`calculate_vol\`, \`calculate_macd\`, \`calculate_cci\`，内部辅助函数不得被外部导入。
- **纯函数返回新列而非原地修改**：由调用方选择 \`df.assign()\` 或 \`pd.concat\`。
- 引发 \`ValueError\` 或返回空 DataFrame。
- 抛出 \`KeyError\`。
- 均线用 \`rolling().mean()\`，布林带用 \`rolling().std()\`。
- 函数按指标独立拆分，而非合并为 \`compute_all\`。
`;

test('extractModuleExportsFromDecisionRecord prefers explicit 五个公开函数 list (Run #44)', () => {
  const exports = extractModuleExportsFromDecisionRecord('indicators', RUN44_INDICATORS_RECORD);
  assert.deepEqual(exports, [
    'calculate_boll',
    'calculate_cci',
    'calculate_ma',
    'calculate_macd',
    'calculate_vol',
  ]);
});

test('pruneExportNoise strips index_sh/index_sz market globals（Run #51）', () => {
  const cleaned = pruneExportNoise([
    'generate_long_signal',
    'generate_short_signal',
    'index_sh',
    'index_sz',
  ]);
  assert.deepEqual(cleaned, ['generate_long_signal', 'generate_short_signal']);
});

test('pruneExportNoise strips KeyError/assign from polluted artifacts list', () => {
  const cleaned = pruneExportNoise([
    'assign',
    'calculate_ma',
    'KeyError',
    'rolling',
    'calculate_boll',
  ]);
  assert.deepEqual(cleaned, ['calculate_boll', 'calculate_ma']);
});

test('sanitizeModuleExports prunes noise from stored sidecar exports', () => {
  const cleaned = sanitizeModuleExports('indicators', [
    'assign',
    'calculate_ma',
    'KeyError',
    'calculate_boll',
  ]);
  assert.deepEqual(cleaned, ['calculate_boll', 'calculate_ma']);
});

test('synthesizeSliceDecisionArtifacts replaces weak int-only exports', () => {
  const record = '主方法 `generate` 组合结果。';
  const artifacts = synthesizeSliceDecisionArtifacts('signals', record, {
    version: 1,
    files: [],
    modules: [{ name: 'signals', exports: ['int'] }],
  });
  assert.deepEqual(artifacts?.modules?.[0]?.exports, ['generate']);
});

const RUN59_BROKER_RECORD = `broker模块负责与外部交易/行情系统交互。提供抽象基类BrokerAdapter定义下单、查询持仓、查询行情接口；SimBroker为模拟适配器，使用本地CSV/内存数据模拟实盘行为。
- 当行情CSV中某条记录的K线时间戳缺失/非法时，SimBroker.query_market()抛出异常并记录错误日志。
- 假设CSV文件列名固定且顺序为：datetime, open, high, low, close, volume。`;

test('pruneExportNoise strips datetime stdlib from export list（Run #59）', () => {
  const cleaned = pruneExportNoise(['BrokerAdapter', 'SimBroker', 'datetime']);
  assert.deepEqual(cleaned, ['BrokerAdapter', 'SimBroker']);
});

test('extractModuleExportsFromDecisionRecord ignores CSV columns and instance methods（Run #59 broker）', () => {
  const exports = extractModuleExportsFromDecisionRecord('broker', RUN59_BROKER_RECORD);
  assert.deepEqual(exports, ['BrokerAdapter', 'SimBroker']);
});

test('synthesizeSliceDecisionArtifacts replaces misleading datetime/query_market sidecar（Run #59）', () => {
  const artifacts = synthesizeSliceDecisionArtifacts('broker', RUN59_BROKER_RECORD, {
    version: 1,
    files: [],
    modules: [{ name: 'broker', exports: ['datetime', 'query_market'] }],
  });
  assert.deepEqual(artifacts?.modules?.[0]?.exports, ['BrokerAdapter', 'SimBroker']);
});

const RUN60_INDICATORS_RECORD = `### 关键设计决策
1. **函数签名与返回结构**
   - \`compute_ma\`：返回追加 \`ma5\`/\`ma6\`/\`ma7\`/\`ma8\`/\`ma9\`/\`ma11\`/\`ma20\` 列的 DataFrame。
   - \`compute_boll\`：返回 \`boll_mid\`/\`boll_upper\`/\`boll_lower\` 列。
   - \`compute_vol\`：返回 \`volume\`/\`vol_ma3\`/\`vol_ma100\` 列。
   - \`compute_macd\`：返回 \`dif\`/\`dea\`/\`hist\` 列。
   - \`compute_cci\`：返回 \`cci\` Series。
3. **NaN 传播** 当数据长度不足时，对应位置填充 NaN。`;

test('pruneExportNoise strips indicator DataFrame column names（Run #60）', () => {
  const cleaned = pruneExportNoise([
    'compute_ma',
    'compute_boll',
    'boll_lower',
    'ma5',
    'NaN',
    'dif',
    'cci',
  ]);
  assert.deepEqual(cleaned, ['compute_boll', 'compute_ma']);
});

test('extractModuleExportsFromDecisionRecord keeps compute_* only for indicators（Run #60）', () => {
  const exports = extractModuleExportsFromDecisionRecord('indicators', RUN60_INDICATORS_RECORD);
  assert.deepEqual(exports, [
    'compute_boll',
    'compute_cci',
    'compute_ma',
    'compute_macd',
    'compute_vol',
  ]);
});

test('synthesizeSliceDecisionArtifacts prunes column-only polluted sidecar（Run #60）', () => {
  const polluted = [
    'boll_lower',
    'boll_mid',
    'boll_upper',
    'cci',
    'compute_boll',
    'compute_cci',
    'compute_ma',
    'compute_macd',
    'compute_vol',
    'dea',
    'dif',
    'hist',
    'ma11',
    'ma20',
    'ma5',
    'NaN',
    'vol_ma100',
    'vol_ma3',
  ];
  const artifacts = synthesizeSliceDecisionArtifacts('indicators', RUN60_INDICATORS_RECORD, {
    version: 1,
    files: [],
    modules: [{ name: 'indicators', exports: polluted }],
  });
  assert.deepEqual(artifacts?.modules?.[0]?.exports, [
    'compute_boll',
    'compute_cci',
    'compute_ma',
    'compute_macd',
    'compute_vol',
  ]);
});

const RUN63_INDICATORS_RECORD = `### 职责边界
本模块为南华期货自动下单系统提供纯技术指标计算能力。每个公开函数独立计算一个指标，\`compute_moving_averages\` 返回dict。备选方案是提供聚合式 \`compute_all\` 函数。
### ★ 边界压力测试
- 当输入数据长度小于最大计算周期（如89）时，本设计的行为是：改为在\`if len(data) < period\`时返回None。`;

const RUN63_GLOBAL_INDICATORS = {
  version: 1 as const,
  files: [],
  modules: [
    {
      name: 'indicators',
      exports: [
        'compute_moving_averages',
        'compute_bollinger',
        'compute_volume',
        'compute_macd',
        'compute_cci',
      ],
    },
  ],
};

test('pruneExportNoise strips len builtin from prose scan（Run #63）', () => {
  assert.deepEqual(pruneExportNoise(['compute_moving_averages', 'len']), ['compute_moving_averages']);
});

test('shouldPreferGlobalOverSlice when slice is incomplete subset of global（Run #63）', () => {
  assert.equal(
    shouldPreferGlobalOverSlice(
      ['compute_moving_averages', 'len'],
      RUN63_GLOBAL_INDICATORS.modules![0]!.exports,
    ),
    true,
  );
  assert.equal(shouldPreferGlobalOverSlice(['compute'], ['SignalGenerator']), false);
});

test('resolveModuleExports falls back to global when slice synthesized incomplete exports（Run #63）', () => {
  const sliceArtifacts = {
    version: 1 as const,
    files: [],
    modules: [{ name: 'indicators', exports: ['compute_moving_averages', 'len'] }],
  };
  const expected = [...RUN63_GLOBAL_INDICATORS.modules![0]!.exports].sort();
  assert.deepEqual(
    resolveModuleExports('indicators', sliceArtifacts, RUN63_GLOBAL_INDICATORS)?.sort(),
    expected,
  );
});

test('synthesizeSliceDecisionArtifacts prefers global when decide body omits sidecar（Run #63）', () => {
  const artifacts = synthesizeSliceDecisionArtifacts(
    'indicators',
    RUN63_INDICATORS_RECORD,
    null,
    RUN63_GLOBAL_INDICATORS,
  );
  const expected = [...RUN63_GLOBAL_INDICATORS.modules![0]!.exports].sort();
  assert.deepEqual(artifacts?.modules?.[0]?.exports?.sort(), expected);
});
