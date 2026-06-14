import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildDecisionLintRetryUserComment, verifyDecisionRecord } from '../DecisionRecordVerify';

const COMPLIANT_RECORD = `## 决策清单：用户缓存模块

### 职责边界
- **负责**：内存缓存用户会话
- **不负责**：持久化存储
- **对外暴露**：getSession / setSession / invalidate

### 关键设计决策
- **存储后端**：选择 LRU Map 而非 Redis — 理由：单实例足够；Redis 引入运维成本
- **过期策略**：选择滑动窗口而非固定窗口 — 理由：贴近用户实际行为

### 边界压力测试
- **场景 1**：当并发写入 > 1000 QPS 时，LRU 容量超限会触发同步淘汰，可能阻塞写入路径。若不可接受，需切换到异步淘汰。
- **场景 2**：当用户 session 在过期前 1ms 被读取，过期会延后，可能造成永不过期。若不可接受，需加最大寿命兜底。

### AI 无法验证的假设
- 假设 QPS < 1000：若不成立，需切换 Redis 后端。
`;

test('buildDecisionLintRetryUserComment lists exact ### headings (Run #47 SSOT)', () => {
  const comment = buildDecisionLintRetryUserComment();
  assert.match(comment, /### 职责边界/);
  assert.match(comment, /### 关键设计决策/);
  assert.match(comment, /### 边界压力测试/);
  assert.match(comment, /### AI 无法验证的假设/);
  assert.ok(!comment.includes('背景/问题'));
});

test('重试注释里的 ### 标题必须被 lint 接受（防 T6 括号漂移：标题行不得带括号说明）', () => {
  const comment = buildDecisionLintRetryUserComment();
  const headings = comment.split('\n').filter((l) => l.startsWith('### '));
  assert.equal(headings.length, 4, '应恰好列出 4 个三级标题');
  // 用重试注释给出的标题原样拼一份最小合规 decisionRecord，喂回 lint。
  const record = [
    '## 决策清单：示例',
    headings[0],
    '- 负责：X；不负责：Y',
    headings[1],
    '- 选 A 不选 B：理由…',
    headings[2],
    '- 场景 1：空输入边界',
    '- 场景 2：超大输入边界',
    headings[3],
    '- 假设：第三方接口稳定',
    '',
  ].join('\n');
  const result = verifyDecisionRecord(record);
  // 若标题带了 `（至少 …）` 等括号，titleRegex 不匹配 → missing-section，模型照抄即永拒。
  assert.deepEqual(
    result.violations,
    [],
    `重试注释标题必须与 lint titleRegex 完全一致；实际违反：${JSON.stringify(result.violations)}`,
  );
});

test('T1: 完整合规决策清单 → ok=true', () => {
  const result = verifyDecisionRecord(COMPLIANT_RECORD);
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
});

test('T2: 缺「边界压力测试」节 → missing-section / I-17', () => {
  const record = COMPLIANT_RECORD.replace(/### 边界压力测试[\s\S]*?(?=### AI)/, '');
  const result = verifyDecisionRecord(record);
  assert.equal(result.ok, false);
  const v = result.violations.find((x) => x.invariantId === 'I-17');
  assert.ok(v, '应至少含 I-17 违反');
  assert.equal(v!.code, 'missing-section');
  assert.equal(v!.detail?.section, '边界压力测试');
});

test('T3: 边界压力测试只有 1 个场景 → I-18', () => {
  const record = `## 决策清单：x

### 职责边界
- **负责**：x

### 关键设计决策
- **A**：x — 理由：y

### 边界压力测试
- **场景 1**：x

### AI 无法验证的假设
- 假设 X：y
`;
  const result = verifyDecisionRecord(record);
  assert.equal(result.ok, false);
  const v = result.violations.find((x) => x.invariantId === 'I-18');
  assert.ok(v, '应含 I-18 违反');
  assert.equal(v!.code, 'insufficient-stress-tests');
  assert.equal(v!.detail?.actualCount, 1);
  assert.equal(v!.detail?.requiredCount, 2);
});

test('T4: 假设节为空 → I-19', () => {
  const record = `## 决策清单：x

### 职责边界
- **负责**：x

### 关键设计决策
- **A**：x — 理由：y

### 边界压力测试
- **场景 1**：x
- **场景 2**：y

### AI 无法验证的假设

`;
  const result = verifyDecisionRecord(record);
  assert.equal(result.ok, false);
  const v = result.violations.find((x) => x.invariantId === 'I-19');
  assert.ok(v, '应含 I-19 违反');
  assert.equal(v!.code, 'insufficient-assumptions');
  assert.equal(v!.detail?.actualCount, 0);
});

test('T5: 多条同时违反 → violations 含全部', () => {
  const record = `## 决策清单：x

### 职责边界
- x

### 关键设计决策
- x
`;
  const result = verifyDecisionRecord(record);
  assert.equal(result.ok, false);
  // 缺「边界压力测试」+ 缺「AI 无法验证的假设」两节 → 两条 I-17
  const i17Count = result.violations.filter((v) => v.invariantId === 'I-17').length;
  assert.equal(i17Count, 2);
  // I-18 / I-19 因节不存在，按规约不另行计数（只算 I-17）
  assert.equal(
    result.violations.some((v) => v.invariantId === 'I-18'),
    false,
  );
});

test('T6: 章节标题含 ★ 装饰符 → 仍判定为存在', () => {
  const record = COMPLIANT_RECORD.replace('### 边界压力测试', '### ★ 边界压力测试');
  const result = verifyDecisionRecord(record);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

test('T6b: 章节标题含 (v2.0 新增) 装饰 → 仍判定为存在', () => {
  const record = COMPLIANT_RECORD.replace(
    '### 边界压力测试',
    '### ★ 边界压力测试（v2.0 新增）',
  );
  const result = verifyDecisionRecord(record);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

test('T7: 章节用 ## 而非 ### → 不合规', () => {
  const record = COMPLIANT_RECORD.replace('### 边界压力测试', '## 边界压力测试');
  const result = verifyDecisionRecord(record);
  assert.equal(result.ok, false);
  const v = result.violations.find(
    (x) => x.code === 'missing-section' && x.detail?.section === '边界压力测试',
  );
  assert.ok(v, '应判「边界压力测试」节缺失');
});

test('T8: 列表项用 * 而非 - → 计数正确', () => {
  const record = `## 决策清单：x

### 职责边界
- x

### 关键设计决策
- x

### 边界压力测试
* **场景 1**：x
* **场景 2**：y

### AI 无法验证的假设
* 假设 X：y
`;
  const result = verifyDecisionRecord(record);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

test('T8b: 列表项用编号 1./2. → 计数正确（容忍有序列表）', () => {
  const record = `## 决策清单：x

### 职责边界
- x

### 关键设计决策
- x

### 边界压力测试
1. **场景 1**：x
2. **场景 2**：y

### AI 无法验证的假设
1) 假设 X：y
`;
  const result = verifyDecisionRecord(record);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

test('T9: 列表项嵌套缩进 → 只计顶层', () => {
  const record = `## 决策清单：x

### 职责边界
- x

### 关键设计决策
- x

### 边界压力测试
- **场景 1**：x
  - 嵌套点 a
  - 嵌套点 b
  - 嵌套点 c

### AI 无法验证的假设
- 假设 X：y
`;
  // 嵌套缩进的 3 行不计入；顶层只有「场景 1」一项 → I-18 触发
  const result = verifyDecisionRecord(record);
  assert.equal(result.ok, false);
  const v = result.violations.find((x) => x.invariantId === 'I-18');
  assert.ok(v);
  assert.equal(v!.detail?.actualCount, 1);
});

test('T10: 代码围栏内的 - 不被误计为列表项', () => {
  const record = `## 决策清单：x

### 职责边界
- x

### 关键设计决策
- x

### 边界压力测试
- **场景 1**：x
\`\`\`
- 这是代码块内的伪列表项
- 也不应被计入
\`\`\`

### AI 无法验证的假设
- 假设 X：y
`;
  const result = verifyDecisionRecord(record);
  assert.equal(result.ok, false); // 边界压力只有 1 项（围栏内不计）
  const v = result.violations.find((x) => x.invariantId === 'I-18');
  assert.ok(v);
  assert.equal(v!.detail?.actualCount, 1);
});

test('T11: 空字符串 / 非字符串 → 四节全缺', () => {
  const result = verifyDecisionRecord('');
  assert.equal(result.ok, false);
  assert.equal(
    result.violations.filter((v) => v.invariantId === 'I-17').length,
    4,
  );
});
