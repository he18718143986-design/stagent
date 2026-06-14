# T4 Live 迭代日志（南华期货自动下单）

## 验收分栏（ADR-0004 · 2026-06-10）

| 档位 | pipeline pass | strict delivery pass |
|------|---------------|-------------------|
| T1–T3 | headless 流水线完成（T3 可 `acceptRunnerFailure`） | 不适用 |
| T4/T5 | `workflowCompleted` 或历史 runner-failed-accepted | **必须** pytest 全绿 + MVP 目录 + traceability + `workflowCompleted` |

- `npm run feedback:live:all` 报告含 `strict delivery: X/Y`
- Engine：`blockDeliveryOnTestFailure` 对 software 默认 true；test 红不得 delivery
- 详见 [`docs/adr/0004-t4-delivery-hardening.md`](adr/0004-t4-delivery-hardening.md)

---

## 离线根治 — 2026-06-14（架构评估结论 + 复发性假红测试 SSOT · 零 API）

> **架构是否重写？否。** 证据（#66–#69）符合健康架构特征「失败单调前移、越来越具体」：缺陷均为局部、确定性、可 gate/SSOT/retry 收敛的点，或外部阻断（402）；主干（DAG + Plan Compiler + Gate/SSOT + fix/replan + 异族出题人 + integration 路由）已产出过完整 strict 交付（#66）。应重估的是**验收纪律**——按「先离线根治、再 Live 复验」收敛复发点，而非重写架构（与 2026-06-13 决策记录一致）。

### 复发点根治：test_write 自遮蔽假红（run5/run6 indicators 反复红的成因之一）

run5/run6 indicators `test_run` 反复红，其中 `test_cci_known_values` 含 `expected_cci = expected_cci(...)`：name 被赋值即全程视为函数局部，RHS 调用自身抛 `UnboundLocalError`。这是 **test_write 产出的结构性坏测试**，fix 链只改 impl **永远修不好**，只有重写测试可救。

| # | 机制 | 落点 |
|---|------|------|
| 1 | `TestQualityLint` 新增 `test-self-shadowed-call`（hard）：`name = name(...)` 且 name 非参数/非更早绑定/非 global → UnboundLocalError 假红 → post test_write 硬阻断触发同 stage 重写（P1）/testfix | `TestQualityLint.ts` |
| - | 单测：`test-quality-lint.test.ts` 命中 + 参数/重赋值不误报；`@stagent/core` **915 pass** |

> 说明：模块级 `def name`/`import name` **不**使其安全（函数内赋值即遮蔽），故 guard 仅认参数 / 同函数更早赋值 / global，避免假阴同时杜绝假阳。

---

## 运行 #69 — 2026-06-14（稳定性轮次 run6：indicators 测试链中途 API 余额耗尽 402 ❌ · 非代码缺陷）

| 字段 | 值 |
|------|-----|
| 命令 | `feedback:live:t4`（全新工作区 `/tmp/t4-acc/run6`，无 `--resume`） |
| 耗时 | 518.0s（10 calls） |
| headless 判定 | **FAIL** `LLM API 请求失败 [402] Insufficient Balance` @ `stage_fix_if_failed_indicators` |
| instance | （`/tmp/t4-acc/run6/.stagent/instances`） |

### RCA（外部阻断，非引擎缺陷）

与文档 Run #52 同类：DeepSeek 账户余额在 indicators fix 链途中耗尽（连跑 T1 + run1/2/3 + run4/5/6 共约 7 次 T4 量级、每次约 290k tokens）。`curl /v1/chat/completions` 复核仍返回 `Insufficient Balance`。**非代码可修**，Live 循环暂停待充值（同 #52 处理）。

> 另：run6 与 run5 同样在 indicators `test_run` 反复红（fix 链自愈中被 402 打断）——疑为 test_write 偶发假红测试（如 #68 记录的 `expected_cci` 自遮蔽类），待充值后复验 testfix 链能否收敛。

### 稳定性验收当前结论（截至 #69）

| 项 | 状态 |
|----|------|
| 单次 strict delivery pass | ✅ 已达成（#66，instance `a692cb2e`，83 pytest 全绿，完整 MVP） |
| **连续 2–3 次 strict pass** | ❌ **未达成**（#66 ✅ → #67/#68/#69 ❌；#67/#68 为引擎根因已修，#69 为 API 余额外部阻断） |
| 本阶段根治的引擎缺陷 | behaviorSpec 拒绝挂死(#66A)、库名 export 噪声(#66B)、typing 原语 export 噪声(#67)、LLM 瞬态掉线未重试(#68) —— 均含单测 |

**待办（解除 API 阻断后）**：重置连击重跑 ≥3 次全新工作区 → 取得连续 2–3 次 strict pass → 收口 `STAGENT-PRD-ENGINEER.md` 能力矩阵/§7/附录B。

---

## 运行 #68 — 2026-06-14（稳定性轮次 run5：fix-chain LLM 调用瞬态掉线 `terminated` 整轮失败 ❌）

| 字段 | 值 |
|------|-----|
| 命令 | `feedback:live:t4`（全新工作区 `/tmp/t4-acc/run5`，无 `--resume`） |
| 耗时 | 938.6s（12 calls；in 49617 / out 59189 tok） |
| headless 判定 | **FAIL** `workflowFailed: terminated` @ `stage_fix_if_failed_indicators` |
| instance | `2cf8d99c-71c4-499b-af48-6d47578cf319` |

### RCA（瞬态网络错误未重试 → 整轮失败）

indicators 切片 pytest 2 红（`test_macd_constant_close…` NaN 容差、`test_cci_known_values` 测试自身 `expected_cci = expected_cci(...)` 自遮蔽 UnboundLocalError），fix 链正在自愈；但 `stage_fix_if_failed_indicators` 的一次 LLM 调用在 ~6 分钟后 `llm_error: "terminated"`（连接被掐断，非 idle 超时——idleMs=600s 未到）。`CoreLlmInvoker` 仅对**空响应/拒答**重试，**不对网络掉线重试** → 单次掉线让整轮 ~30 次调用的 T4 直接 `workflowFailed`。22 分钟长跑中任一调用掉线都会团灭，是稳定性的主要噪声源。

### 根治（Run #68 代码 · 重试结构）

| # | 机制 | 落点 |
|---|------|------|
| 1 | `CoreLlmInvoker` 抽出 `invokeOnce` + 外层瞬态重试循环（每次新建 AbortController/idle）；瞬态错误（terminated/ECONNRESET/socket hang up/fetch failed/und_err… 且非 idle-abort）退避重试 ≤2 次 | `core/CoreLlmInvoker.ts` |
| 2 | `isTransientLlmError(err, idleAborted)` 谓词 + `MAX_TRANSIENT_LLM_RETRIES`；idle 超时主动 abort 不重试（genuine 卡死） | 同上 |
| - | 单测：`llm-transient-retry.test.ts`（谓词 + 掉线重试成功 / 超上限放弃 / 非瞬态不重试）；`@stagent/core` **913 pass** |

> 残留观察：indicators `test_cci_known_values` 自遮蔽是 test_write 产出的假红测试，本轮因瞬态掉线先死、未走到 testfix replan；留待后续轮次复验（testfix 链应能重写）。
> 连续 strict 计数：#66 ✅ → #67 ❌ → #68 ❌（根治后重启连击）。

---

## 运行 #67 — 2026-06-13（稳定性轮次 run4：signals export 噪声 `NamedTuple` 早败 ❌）

| 字段 | 值 |
|------|-----|
| 命令 | `feedback:live:t4`（全新工作区 `/tmp/t4-acc/run4`，无 `--resume`） |
| 耗时 | 548.4s（14 calls；in 46997 / out 55404 tok） |
| headless 判定 | **FAIL** `python-impl-export-missing` @ `stage_impl_signals` |
| instance | `7c1a47c1-b536-423e-bcbf-7c425cc5278d` |

### RCA（与 #66b 同类：导入名被当 export，本次是 typing 原语）

`decide_signals` 合成 exports = 函数/条件名 + **`NamedTuple`**（`signals` exports 实测 `[…generate_long_signal, generate_short_signal, ma_convergence, NamedTuple, …]`）。`NamedTuple` 是 `typing` 的类型构造器（正文「返回一个 NamedTuple」），impl 合理不导出原语名 → `module-contract（export-missing）` 误拦。#66b 只覆盖库**包名**（numpy/pandas），未覆盖 **typing/dataclasses 成员原语**。

### 根治（Run #67 代码 · 确定性噪声 SSOT）

| # | 机制 | 落点 |
|---|------|------|
| 1 | `isNoiseExportName` 增加 `PYTHON_TYPING_DATACLASS_NOISE`：typing（NamedTuple/TypedDict/Protocol/Optional/Callable…）+ dataclasses（dataclass/field/asdict…）+ enum/abc/collections 原语，大小写不敏感 | `commitment/decisionRecordExports.ts` |
| - | 单测：`pruneExportNoise` 剔除 NamedTuple/TypedDict/dataclass/Protocol/Enum，保留 `generate_*`/领域类名；`@stagent/core` **908 pass**（3 fail 为预存环境性 ADR 种子缺失） |

> 连续 strict 计数：#66 ✅ → #67 ❌（streak 中断，根治后重启连击）。

---

## 运行 #66 — 2026-06-13（behaviorSpec 拒绝挂死 + NumPy export 噪声根治 → strict delivery ✅ GREEN）

| 字段 | 值 |
|------|-----|
| 命令 | `node scripts/headless/run.mjs --live --scenario execute --live-tier 4 --keep --workspace /tmp/t4-run/task` |
| 模型 | main `deepseek-v4-flash` / test-write+integration `deepseek-v4-pro`（异族出题人 + Run #65 integration 路由） |
| 耗时 | 1323.9s（22min；49 stages；29 calls；in 147860 / out 143484 tok） |
| headless 判定 | **PASS** `workflowCompleted` · **strict delivery 1/1** |
| instance | `a692cb2e-…`（run3；run1=behaviorSpec 挂死，run2=NumPy export-missing 早败） |

### 里程碑（史上首次 strict delivery GREEN）

| 切片 | test_run |
|------|----------|
| indicators / signals / risk / broker / **main** | ✅ 全绿（signals 经 fix + `runtime_replan_fix_signals` 收敛） |
| smoke_run / write_config / delivery_wrapup | ✅ |

交付物：`config.yaml`（指标参数与需求逐项对齐：MA 5/6/7/8/9/11/20、BOLL 20+2、VOL 3+100、MACD 14+53+60、CCI 89、止损 15 点）、`indicators/`（compute_ma/boll/volume/macd/cci）、`signals/`（check_long/short_signal）、`risk/`（calculate_stop_loss/classify_order/should_stop_loss 四情形对冲）、`broker/`（BrokerAdapter 抽象 + SimBroker）、`main.py`、`tests/`（**复跑 83 passed**）、`DELIVERY.md`。

### RCA（两个确定性引擎根因，先后暴露）

**根因 A（run1 挂死）— 决策拒绝错误面不一致**：decide 阶段两条「批准被拒」路径文案不一致：内容 lint 拒绝恰好携带 `decisionLintRejected`（uiMsg 无 nls 时回退为 key），而 behaviorSpec 硬校验拒绝只发裸中文。AFK 驾驶员用「是否含 `decisionLintRejected`」判定重试 → behaviorSpec 拒绝（signals 缺 `decisionArtifacts.behaviorSpec`）永不重试 → decide stage 停 paused → 整轮挂死到 40min timeout。

**根因 B（run2 早败）— 第三方库名被当 export**：`decide_indicators` 合成契约 exports `[calc_ma,calc_boll,calc_vol,calc_macd,calc_cci,NumPy]`，库展示名 `NumPy`（来自正文「使用 NumPy 计算…」）被抽成 export → impl 合理不导出库名 → `python-impl-export-missing` 误拦（与 #59/#60 datetime/index_sh 同类，但 PascalCase 库名漏网）。

### 根治（本轮代码）

| # | 机制 | 落点 |
|---|------|------|
| A1 | 决策拒绝 SSOT：`DECISION_LINT_REJECTED_MARKER` + `formatDecisionRejectionError(kind,detail)` + `isDecisionLintRejectedError` + `decisionRejectionKindFromError`；两条拒绝路径统一格式化，错误恒含可机读 marker + kind | `hitl/DecisionRejection.ts`、`hitl/DecisionLintGate.ts` |
| A2 | `buildBehaviorSpecRetryUserComment()`：behaviorSpec 拒绝注入「补机读行为规格」反馈（而非 I-17 章节）；headless 用 SSOT 谓词 + 按 kind 选反馈 | `DecisionRecordVerify.ts`、`index.ts`、`scripts/headless/run.mjs` |
| B1 | 第三方库名（import 根名 numpy/pandas/yaml… 或展示名 NumPy/PyYAML）不得作为 export | `commitment/decisionRecordExports.isNoiseExportName`（`isExternalPythonModuleRoot` + 展示名集合） |
| - | 单测：`decision-rejection.test.ts`（5 例，含 behaviorSpec 拒绝可检测回归）、`decision-record-exports.test.ts`（NumPy/Pandas 剔除）；`@stagent/core` **907 pass**（3 fail 为预存环境性 ADR 校准种子缺失，详见末节） |

> **判定**：架构按设计「失败单调前移」——run1 卡 signals decide（挂死），根治后 run3 一举推进到全切片 + main + smoke + delivery 全绿。证明主干（DAG + Plan Compiler + Gate/SSOT + fix/replan + 异族出题人 + integration 路由）在真实 T4 任务上可稳定产出高质量可交付 MVP。

### 预存环境性单测缺口（非本轮回归）

`detectAdrCriteria` / `evaluateAdrDetector` / `loadAdrCalibrationQuestions` 读取仓库外 `…/.stagent/charter/calibration/questions.jsonl`（gitignored 本地校准种子），本环境解析到 `/.stagent/…` 不存在 → 3 fail。建议把校准种子纳入仓库使单测自洽（需确认 ground-truth 数据，避免臆造）。

---

## 运行 #63 — 2026-06-13（全新工作区；signals behavior-spec 与契约 exports 冲突）

| 字段 | 值 |
|------|-----|
| 耗时 | 491s |
| headless 判定 | **FAIL** `behavior-spec-function-uncovered` @ `stage_test_write_signals` |
| instance | `c46fe8a3-2e16-4b81-b291-950fc9028b03` |

### RCA

`test_write` 重试 2 次 gate 互相打架：
1. **behavior-spec** 硬要求测试调用 `generate_long_signal()`
2. **module-contract** 重试反馈：契约 exports 未声明 `generate_long_signal`（仅 `generate_signal` 等）
3. 最终仍被 behavior-spec 阻断

indicators 切片已完成；卡在 signals `test_write`。

### 根治（Run #64 代码）

| # | 机制 | 落点 |
|---|------|------|
| 1 | decide 硬拒：behaviorSpec.functions[].name 须在 modules.exports 中 | `validateBehaviorSpecForSemantic` + `DecisionLintGate` |
| 2 | test_write gate 仅校验 **exports 内** 的 behaviorSpec 函数 | `lintTestAgainstBehaviorSpec({ contractExports })` + `postStageGates` |
| 3 | 单入口 `generate_signals("bear")` 别名覆盖逻辑分组函数名 | `BehaviorSpecLint.functionAppearsCalledInTest`（Run #54 回归） |
| - | 单测 Run #63 + #54 场景 | `behavior-spec.test.ts` · `behavior-spec-gate.test.ts` |

**单测验收（2026-06-14）**：`behavior-spec*.test.js` **30/30 pass**（含 Run #54 别名、Run #63 exports 子集）；`rm -rf dist && npm run build` 后 dist 与源码对齐。

---

## 运行 #64 — 2026-06-14（#63 behaviorSpec↔exports 根治后；全新 live）

| 字段 | 值 |
|------|-----|
| 命令 | `npm run build:core && npm run feedback:live:t4` |
| 耗时 | ~1500s（trace 19:35:10→20:00:23） |
| headless 判定 | **FAIL** `invariant-violation: test_run still failing after fix chain exhausted (blockDeliveryOnTestFailure)` @ `stage_fix_if_failed_main` |
| instance | `bf15dd73-2b56-4cc6-9878-50bbaf7c2796` |

### 里程碑（#63 根治验证 ✅）

| 阶段 | 状态 |
|------|------|
| **signals test_write** | ✅ **不再被 behaviorSpec↔exports 互卡**（#63 根治生效） |
| indicators / signals / risk / broker | ✅ test_run 绿 |
| **main** | ❌ fix 链耗尽（`no-plan-or-budget`） |

> 注：`artifacts/headless-feedback.json`（ts 19:13）为 **Run #63 残留**（function-uncovered），非 #64；#64 真实终态以 instance `bf15dd73` 的 `.wf-debug.log` 为准。

### RCA（main 集成切片跨模块 API/符号漂移 — 与 #62 同类）

main test_run 失败演变：`EEEEEEE`（setup 全错）→ testfix 重写 test_main.py → `..FFF..`（`test_main_engine_run_generates_long_order` 等 3 行为失败）→ posttestfix_fix → 最终 `pytest-symbol-missing: OrderResult`。

1. **符号漂移**：`main.py` 某轮 `from broker import OrderResult`，broker 真实仅导出 `Order, OrderStatus, SimBroker, BrokerAdapter` → pytest 收集期 ImportError；fix 模型（deepseek-v4-flash）在 `compute`/`OrderResult` 间反复横跳不收敛。
2. **dict 列名漂移**：`test_main.py` 消费 `'vol'`，`indicators` 产出 `'low'`（`cross-file-key-mismatch` 仅 warn）。
3. **mock 掩盖集成**：`test_main.py` mock 掉 `indicators.compute`/`signals.generate_*`（`test-mocks-internal-module` warn），真实签名漂移延后到运行时才暴露。
4. `buildIntegrationApiBridgePromptSuffix`（Run #57）虽已注入 test_write_main + impl_main，但为 prompt 建议、非硬门禁，LLM 仍臆造 `OrderResult`。

### 根治（Run #65 代码）— 集成切片模型增强

定性：非确定性引擎 bug，而是**异族出题人架构下 flash 在 main 集成切片的能力天花板**（多模块编排 + autospec mock + 跨文件键名，fix 链耗尽仍不收敛）。预算充足（fix×2 + 3 级 replan），故根治方向为**模型路由**而非加预算。

| # | 机制 | 落点 |
|---|------|------|
| 1 | 新增 AgentRole `integration`；`stage_(impl\|fix_if_failed\|runtime_replan_{fix,testfix,posttestfix_fix})_main` → `integration` 角色 | `AgentSpecializationRouter.ts`（`classifyStageRoleFromId` + `isIntegrationSliceStageId`） |
| 2 | headless 把 `integration` 角色路由到出题人(pro)模型（复用已注册 `llmExtraModels`）；叶子切片 impl/fix 仍用全局 flash | `scripts/headless/run.mjs` `llmModelByRole.integration` |
| 3 | settings catalog 角色清单补 `integration` | `settings/catalog/llm.ts` |

**策略**：叶子切片（indicators/signals/risk/broker）保持异族非对称（pro 出题 / flash 实现）——已稳定通过；仅最难的集成切片 main 的 impl/fix 升到 pro。`test_write_main` 本就走 `test-write`(pro)。

**单测验收（2026-06-14）**：`agent-role-model-routing.test.js` **9/9 pass**（新增 integration 分类 / hint / invoker 路由 3 例）；`stagent-core` 全量 **902 pass / 0 fail**（2 skip）。

---

| 字段 | 值 |
|------|-----|
| 耗时 | 586s（resume 续跑含 generate 跳过） |
| headless 判定 | **FAIL** `workflowFailed: terminated` @ `stage_test_run_main` |
| instance | `2d3c7864-84af-4dda-b08b-039b99ae8fc9` |

### 里程碑

| 阶段 | 状态 |
|------|------|
| indicators / signals / risk / broker | ✅ test_run 绿 |
| **main** | ❌ fix 链 + runtime replan 预算耗尽（`no-plan-or-budget`） |

### RCA

1. **main → indicators API 漂移**：`main.py` 调用 `calculate_ma(data)`，已落盘 `indicators` 签名要求 `(data, config)` → `TypeError: missing 1 required positional argument: 'config'`
2. **抽象类误实例化**：`broker.BrokerAdapter()` 直接构造（抽象类）
3. replan 已走 testfix + posttestfix_fix，仍红后 `fix-exhausted` 无预算 → `blockDeliveryOnTestFailure` 终止

### 验证（#61 根治）

- `stage_test_run_risk` export gate 切片 scope ✅
- risk fix 1 次后绿 ✅

### 附带修复（引擎，已合入）

- `demo-delivery-acceptance.mjs` 补全
- `--resume`：`findResumableInstance` 跳过 generate
- disk-bootstrap：`writeOutputToFile` 非 string 时不再 `.trim()` 崩溃

---

## 运行 #61 — 2026-06-13（#60 列名噪声修复后；risk test_run 全局 export gate 误伤 signals）

| 字段 | 值 |
|------|-----|
| 耗时 | 851.4s |
| headless 判定 | **FAIL** `python-test-import-symbol-missing` @ `stage_test_run_risk`（signals） |
| instance | `ec94e43d-0a60-4890-b696-5f66bbccb55e` |

### 里程碑

| 阶段 | 状态 |
|------|------|
| indicators | ✅ test_run 绿（列名噪声修复生效） |
| **signals** | ✅ **35 passed** |
| risk impl | ✅ 完成 |
| **risk test_run** | ❌ 前置 gate 扫描**全部** test 文件，误拦 signals import |

### RCA

`before-test-run` 的 `python-export-contract` hard gate 用 `lintPythonExportContractOnDisk` 扫描**工作区全部** `tests/test_*.py`。risk 切片 test_run 时仍检查已绿 signals 测试 → 触发 gate-repair 写 signals/__init__.py → 流水线卡死。

另：`lintPythonExportContractFromPaths` 对 `signals/__init__.py` 误把模块名解析为 `__init__` 而非 `signals`（post-impl 路径检查假阳）。

### 根治（Run #62 代码）

| # | 机制 | 落点 |
|---|------|------|
| 1 | test_run 前置 export gate **仅检查当前切片** test/impl | `resolveExportContractTestFiles` + `preStageGates` |
| 2 | `__init__.py` impl 路径模块名解析为包名（`signals`） | `PythonExportContractLint.moduleNameFromImplPath` |
| - | 单测：切片 scope + `__init__.py` 模块名 | `workspace-export-contract.test.ts` / `python-export-surface.test.ts` |

---

## 运行 #60 — 2026-06-13（#59 broker 修复后；indicators 列名误当 export）

| 字段 | 值 |
|------|-----|
| 耗时 | 267.3s |
| headless 判定 | **FAIL** `python-impl-export-missing` @ `stage_impl_indicators` |
| instance | `11745bd6-6a48-4d38-9cb2-11978013ea25` |

### 里程碑

| 阶段 | 状态 |
|------|------|
| indicators decide | ❌ 契约误合成 `boll_lower,ma5,NaN,...` + `compute_*` |
| indicators test_write | ❌ 测试 import 列名符号 |
| indicators impl | ❌ gate 要求 export `boll_lower` |

### RCA

indicators decide 正文描述 DataFrame **输出列**（`` `ma5` ``/`` `boll_lower` ``/`` `NaN` `` 等），`BACKTICK_IDENT_RE` 全收进 exports。stub/test_write/impl 绑定 22 个符号，impl 只实现 5 个 `compute_*` 函数 → `python-impl-export-missing`。

### 根治（Run #61 代码）

| # | 机制 | 落点 |
|---|------|------|
| 1 | 指标输出列名（`ma5`、`boll_*`、`vol_ma*`、`dif/dea/hist/cci`、`NaN`）不得作为 export | `decisionRecordExports.isIndicatorColumnNoise` |
| 2 | sidecar 污染列名经 `pruneExportNoise` 后仅保留 `compute_*` | `moduleExportsForSemantic` / `sanitizeModuleExports` |
| 3 | 误导 sidecar 时优先 `fromRecord` 而非 prune 后残留（Run #59 回归） | `synthesizeSliceDecisionArtifacts` export 选择 |
| 4 | `src/commitment/**` 纳入 `tsc` 编译（修复 dist 不更新） | `packages/stagent-core/tsconfig.json` |
| - | 单测：**15/15 pass**（Run #59+#60 离线验证） | `decision-record-exports.test.ts` |

---

## 运行 #59 — 2026-06-13（smoke 修复后早败：broker 契约误合成 datetime）

| 字段 | 值 |
|------|-----|
| 耗时 | 1072.6s |
| headless 判定 | **FAIL** `python-impl-export-missing` @ `stage_impl_broker` |
| instance | `c37fbc90-13b7-4650-80b5-bf38feb22dfd` |

### 里程碑

| 阶段 | 状态 |
|------|------|
| indicators/signals/risk | ✅ test_run 绿 |
| **broker decide** | ❌ 未输出 sidecar；契约误合成 `datetime, query_market` |
| broker impl | ❌ gate 要求 export `datetime`（stdlib 噪声） |

### RCA

broker decide 阶段 LLM **未输出 decisionArtifacts sidecar**（应有 `BrokerAdapter, SimBroker`）。`synthesizeSliceDecisionArtifacts` 从正文误抽：
1. CSV 列名列表 `datetime, open, high, low, close, volume` → `datetime` 被当成 export
2. `SimBroker.query_market()` → `query_market` 被当成模块级 export

stub/test_write/impl 全链路绑定错误契约 → impl 合理不写 `export datetime` → gate 误拦。

### 根治（Run #60 代码）

| # | 机制 | 落点 |
|---|------|------|
| 1 | stdlib 模块名（`datetime` 等）不得作为 export 噪声过滤 | `decisionRecordExports.isNoiseExportName` + `isPythonStdlibRoot` |
| 2 | `Class.method(` 实例方法不得当模块级 export | `PUBLIC_FUNC_CALL_RE` 负向 lookbehind |
| 3 | 正文 PascalCase 类型名（BrokerAdapter/SimBroker）抽取 | `PASCAL_CASE_TYPE_RE` |
| 4 | sidecar 仅 snake_case 但正文含 PascalCase API → 判定误导、重抽 | `isMisleadingSidecarExports` |
| 5 | sidecar 读取时同步 `pruneExportNoise` | `moduleExportsForSemantic` |
| - | 单测：Run #59 broker 真实 record 离线验证 | `decision-record-exports.test.ts` |

---

## 运行 #58 — 2026-06-13（全切片 pytest 绿 + main 绿；死在 smoke serve 误判）

| 字段 | 值 |
|------|-----|
| 耗时 | 1803.9s |
| headless 判定 | **FAIL** `code-runner exitCode=1` @ `stage_smoke_run` |
| instance | `c442f6e9-e08e-4a51-ba5a-e3519c4a07ed` |

### 里程碑（史上最深：到交付门口）

| 阶段 | 状态 |
|------|------|
| indicators/signals/risk/broker/**main** test_run | ✅ 全绿（API 签名桥接生效，main 4 failed→绿） |
| stage_write_config | ✅ |
| **stage_smoke_run** | ❌ serve 模式误判一次性 CLI |
| delivery_wrapup | 未到达 |

### RCA

smoke 阶段对 `main.py` 一律 `serve: true`（grace 5s 存活探测）；但本任务 `main.py` 是**一次性批处理 CLI**（跑完 exit 0）。`ProcessRunner` serve 模式下「graceMs 内退出」判为 `crashed`（无视 exit 0）→ 假失败。手动 `python main.py --config config.yaml` 实为 exit 0。

### 根治（Run #59 代码）

| # | 机制 | 落点 |
|---|------|------|
| 1 | smoke 对 `main.py` 类 CLI 用**非 serve（一次性，exit 0=通过）**；`server/app/manage.py`、npm start、uvicorn 等仍 serve | `smokeStage.injectSmokeStage` / `deriveStartFromEntry` oneShot |
| - | 单测：main.py→one-shot、server.py→serve；**847 pass** | `smoke-stage.test.ts` |

---

## 运行 #57 — 2026-06-13（全切片到 impl；main 集成测试 fix 链耗尽）

| 字段 | 值 |
|------|-----|
| 耗时 | 1607.2s |
| headless 判定 | **FAIL** `fix chain exhausted` @ `stage_fix_if_failed_main`（blockDeliveryOnTestFailure） |
| instance | `221c3609-9f4a-46bb-8502-b71c8ca780df` |

### 里程碑

| 切片 | 状态 |
|------|------|
| indicators/signals/risk/broker | ✅ test_run 绿 |
| main | ✅ 越过 export-extra gate（#56 修复生效）→ ❌ 集成 pytest fix 耗尽 |

### RCA

`test_main.py` 用 `mock.patch("broker.SimBroker", autospec=True)` 锁真实签名；main impl 调 `SimBroker(config)`，但 broker 真实 `__init__(self)` 不收参 → `TypeError: takes 1 positional but 2 given`。main fix 链**看不到下游切片真实签名** → 反复改不对而耗尽（4 failed / 2 passed）。

### 根治（Run #58 代码）

| # | 机制 | 落点 |
|---|------|------|
| 1 | 集成切片（main）impl/fix 注入下游 broker/indicators/signals/risk **真实公开签名 SSOT** | `buildIntegrationApiBridgePromptSuffix` + `extractPublicPythonSignatures` |
| - | 单测：签名抽取 + main 注入/非 main 不注入；**846 pass** | `test-import-bridge-prompt-suffix.test.ts` |

---

## 运行 #56 — 2026-06-13（史上最远：signals/risk/broker 全过，main impl 契约误拦）

| 字段 | 值 |
|------|-----|
| 耗时 | 1515.6s |
| headless 判定 | **FAIL** `python-impl-export-extra` @ `stage_impl_main` |
| instance | `993dee61-d5bc-4e27-8fe1-263bad413bf9` |

### 里程碑（D1 窗口关键证据：behaviorSpec 生效）

| 切片 | test_run |
|------|----------|
| indicators | ✅ |
| **signals** | ✅ **behaviorSpec 打通 AND 链语义墙** |
| risk | ✅ |
| broker | ✅ |
| main | ❌ impl 导出 `main` 被判 export-extra（首次到达 main impl） |

### RCA

main decide 契约欠声明：`exports=[run_trading_loop]`，但需求要求 `main/cli`，impl 合理导出 CLI 入口 `main` → `python-impl-export-extra` 误拦。`main`/`run`/`cli` 是约定俗成入口符号（`sliceContractExports` 已声明「main 切片 export 必须是入口函数名」）。

### 根治（Run #57 代码）

| # | 机制 | 落点 |
|---|------|------|
| 1 | main 切片放行约定入口符号 `main`/`run`/`cli`（非入口 extra 仍拦） | `ModuleContractLint.MAIN_ENTRY_CONVENTIONAL_EXPORTS` |
| - | 单测：main 入口放行 + 非入口仍拦；**844 pass** | `module-contract-lint.test.ts` |

> **D1 判定**：signals 经 behaviorSpec 已稳定通过（#56 signals/risk/broker 全绿），方向验证为 **go**；剩余为结构性收尾（main 入口契约），非语义墙。

---

## 决策记录 — 2026-06-13（迭代 50+ 次仍未 strict 通过：是否重估架构？）

> **触发**：#14→#53 迭代多轮、单切片/短链曾绿但 T4 5 模块 strict delivery 仍未稳定通过。提出「是否应重新评估架构」。
> **结论**：**不重写架构**；重估对象是**验收靶子 + 迭代纪律**，非主干设计。

### 判据：架构是健康的（失败单调前移、越来越具体）

| 阶段 | 失败性质 | 证据 |
|------|----------|------|
| #14–#31 | 结构性（路径/export/pip/replan） | 每类用 gate+SSOT 修一个稳一个 |
| #31 之后 | 行为语义（signals AND 链/CCI/fixture 顺序） | 卡点后移，非原地发散 |
| #49/#50 | 已跑到 main；四切片 pytest 曾全绿 | 主干（DAG+Plan Compiler+Gate+SSOT+fix/replan）成立 |

健康架构特征即「失败向前推进、越来越具体」；若架构有根本缺陷应表现为「同点反复死、失败发散」——日志显示相反。`behaviorSpec`（#53）是架构按设计长出的新一层，非重写信号。

### 真正该重估的三件事

1. **验收靶子过硬**：把「平台正确性」与「signals 量化策略语义正确性」绑成一个验收 = 用奥数题考编译器。建议拆分（见 §决策项 D1/D2）。
2. **打地鼠边际递减**：#45/#50/#51 根治趋于点状（CCI 提示 / `_set_ideal_*` 顺序 / `index_sh` 噪声）；纯 prompt 补丁收益下降，应收敛为机读 SSOT（`behaviorSpec`）并设判定窗口。
3. **单轮成本 vs 验收形态**：单次 30–40min + 连跑 2–3 次，#52 被 API 余额打断；「连续 N 次」对方差/成本不友好。

### 决策项（待评审表态，本记录不改代码）

| ID | 决策 | 倾向 |
|----|------|------|
| D1 | `behaviorSpec` go/no-go 判定窗口：signals 真正注入 spec 后跑 3–5 次，绿率较 #42–#51 基线显著上升则继续 P2/P3，否则判为 **LLM 能力天花板** | 推荐 |
| D2 | 拆分验收线：①平台正确性（确定性多切片任务）②signals 量化语义（独立专项，不阻塞平台结论） | 推荐 |
| D3 | 平台 strict pass 改用确定性多切片任务（数据管道/CRUD/状态机）作及格线 | 备选（D2 落地手段） |
| D4 | 验收口径「连续 2–3 次」→「`--repeat N` 成功率 ≥ 阈值」 | 推荐（与 §6.1 成功率口径一致） |

**关键认知**：若确定性多切片任务能稳定 strict pass，则证明架构 OK、signals 卡的是模型能力 → 此时正确动作是**降级验收任务**，而非重写架构。

> 详见工程师 PRD [STAGENT-PRD-ENGINEER.md](./STAGENT-PRD-ENGINEER.md) §7「当前瓶颈」与 §4.3.1 行为规格 SSOT。

---

## 运行 #16 — 2026-06-09（Plan Compiler 最终验收 · 真 GREEN）

| 字段 | 值 |
|------|-----|
| instance | `0a83571c-0368-4afc-be87-518e9ed03b2e` |
| 耗时 | 603.6s |
| headless 判定 | **PASS** `workflowCompleted` |
| 阶段数 | 13 |
| 工作区 | `T4/.headless-iter` |

### 结果

- `stage_verify_imports_system` **exit 0**（`status: done`）— Plan Compiler 最终验收通过
- 全流程跑通至 `stage_delivery_wrapup` approve → `run_end: completed`
- 非 PYTHONPATH / 非 venv：根因是 verify 脚本 stdlib 白名单漂移 + `writeOutput` 默认落 `instance` 导致路径错位

### 修复（#14/#15 根因 → #16 GREEN）

| 问题 | 根因 | 修复 |
|------|------|------|
| #14 `verify_imports` exit 1 | `verify-python-test-imports.mjs` 缺 `datetime` 等 stdlib（与 `pythonExternalModules.ts` 不同步） | SSOT：`scripts/python-external-module-roots.json` 双端共享 |
| #15 `verify_imports` exit 1 | `writeOutput.ts` 默认 `writePathBase: instance`，verify 在 workspace cwd 找 `tests/*.py` → file not found | `writeOutput` 改默认 `DEFAULT_TOOL_PATH_BASE`（workspace）；`hoistStageWriteOutputToToolConfig` 补齐 |

---

## 运行 #15 — 2026-06-09（stdlib 修复后，路径仍错位）

| 字段 | 值 |
|------|-----|
| instance | `db64aa8e-f86b-4c4e-8e68-d32268792e01` |
| headless 判定 | **PASS** `runner-failed-accepted` |
| 根因 | `test_write` 落盘至 `.stagent/instances/.../tests/`，verify 在 workspace 根找 `tests/test_core.py` |

---

## 运行 #14 — 2026-06-09（Plan Compiler 四步路线图落地后）

| 字段 | 值 |
|------|-----|
| instance | `2d3fb3c9-5de0-429b-9c1e-41f4613033dd` |
| 耗时 | 244.8s |
| headless 判定 | **PASS** `runner-failed-accepted` |
| 阶段数 | 13（`parse_success` attempt 1） |
| 工作区 | `T4/.headless-iter` |

### 结果

- 生成：单次 `parse_success`，无 `parse_failed_retry` / 缺 `tool` 类失败
- 执行：进入 `stage_decide_signal` → approve → `stage_test_write_signal` 落盘 ✓
- 终止：`stage_verify_imports_signal` code-runner exit 1（headless 配置 `acceptRunnerFailure`）
- 计划形态：express + Python 信号切片；日志未见 `stage_init_npm_workspace`

### Plan Compiler 落地项（PR 范围 Step 0–4）

| 步 | 要点 |
|----|------|
| ADR-0002 | L1–L5 分层、四步 roadmap、sidecar 定案 |
| Step 1 | `invokeLlmRaw` opts 管道 + `jsonMode` / 空响应重试 |
| Step 2a | `stackProfile` + `EXPRESS_PYTHON` prompt 分叉 |
| Step 2b | `lintArtifactGraph` + `contract.planPreflightV2`（T4 headless 已开） |
| Step 3 | `sanitizeInfraStages` + `compilePlan` 编排 |
| Step 4 | `decisionArtifacts` sidecar 解析 / approve / artifact preflight 虚拟 key |

单元测试：`@stagent/core` **622 pass**（含 artifact-graph / sanitize / plan-compiler / sidecar / path-router T4）。

---

## 运行 #13 — 2026-06-09（E11 test_write trim 修复后）

| 字段 | 值 |
|------|-----|
| instance | `9b3aec96-5101-4e05-87fc-f20ac38fba7d` |
| 耗时 | 444.4s |
| headless 判定 | **FAIL** `workflowFailed` |
| 阶段数 | 15（P0 第 3 轮 parse_success） |
| 工作区 | `T4/.headless-iter` |

### 结果

- 生成：attempt 1/2 截断重试，attempt 3 `parse_success` ✓
- 执行：`stage_decide_auto_trade` ✓ → `stage_write_config` ✗ `file-write empty content`（`configContent` 未从决策阶段产出）
- **E11 未在本轮复现**：未跑到 `stage_test_write_*`（与 #11 不同计划形态）

### E11 引擎补丁

| 改动 | 说明 |
|------|------|
| `OutputQualityScorer.scoreSpecCompliance` | `systemPrompt ?? ''` 再 `.trim()`，避免 LLM 省略 prompt 时崩溃 |
| `LlmTextInvokeStep` | `tc.systemPrompt ?? ''` 防御性默认 |

---

## 运行 #12 — 2026-06-09（E11 同期）

| 字段 | 值 |
|------|-----|
| instance | `502bca91-cd91-4382-8ce1-aa5d5b33f7eb` |
| 耗时 | 210.3s |
| headless 判定 | **FAIL @ generate** |
| 根因 | `workflow-gen-continue` 空响应 → repair 产出缺 `tool` 的 `stage_develop_*` 阶段 |

---

## 运行 #11 — 2026-06-09（E10 express+Python npm 剥离后）

| 字段 | 值 |
|------|-----|
| instance | `2eabc63d-7431-49f7-8a1b-82f00f663b0d` |
| 耗时 | 210.3s |
| headless 判定 | **FAIL** `workflowFailed` |
| 阶段数 | 16（bootstrap 后无 npm 阶段） |
| 工作区 | `T4/.headless-iter` |

### 结果

- 生成：attempt=1 `parse_success` ✓，`globalConfig.language: python`
- **E10 验证 ✓**：最终计划无 `stage_init_npm_workspace` / `stage_npm_install_server`（pytest `test_run` 触发 Python 栈判定 + strip）
- 执行：`stage_decide_core` → `stage_impl_core`（`app.py`）→ `stage_impl_conftest` ✓
- 失败：`stage_test_write_core` — `Cannot read properties of undefined (reading 'trim')`（**E11 已修**：`toolConfig` 无 `systemPrompt` 时 `scoreSpecCompliance` 崩溃）

### E10 引擎补丁

| 改动 | 说明 |
|------|------|
| `workflowSignalsPythonTestStack` / `workflowSignalsNodeJsStack` | 以 test_run 命令 + impl 扩展名判定栈，不把 LLM 误写的 npm 阶段当 Node 信号 |
| `isPythonOnlyWorkflow` | 支持 `globalConfig.language=python`、无 `.py` writeOutput 的 bundle 计划 |
| `stripNodeJsBootstrapStages` | Python 栈时移除 npm init / server npm install |

---

## 运行 #10 — 2026-06-09（E9 venv/requirements 顺序修复后）

| 字段 | 值 |
|------|-----|
| instance | `bbd65157-ff57-4619-bbd8-181b39ba6894` |
| 耗时 | 115.3s |
| headless 判定 | **PASS** `runner-failed-accepted` |
| 阶段数 | 12 |

### 结果

- 生成：attempt=1 `parse_success` ✓
- 执行：**首阶段即败** `stage_init_npm_workspace`（`npm init -y` exitCode=1）— Python 项目被 express 模板插入 npm 初始化，**未跑到 venv pip**
- E9 修复已通过单测 `venv-chain-requirements-order.test.ts`；#9 场景的 venv/requirements 顺序问题应在下次完整 TDD 计划上验证

### E9 引擎补丁

| 改动 | 说明 |
|------|------|
| `lastRequirementsTxtWriterStageId` | 定位 requirements.txt 落盘阶段 |
| `reorderVenvChainAfterRequirementsWriter` | 将 venv 三段链移到该阶段之后 |
| `preflightRequirementsTxtForPipInstall` | pip 前 requirements.txt 必须存在（运行时兜底） |

---

## 运行 #9 — 2026-06-09（P0/P1 引擎补丁后）

| 字段 | 值 |
|------|-----|
| instance | `cb2777c2-2a26-4a72-b283-d53120c806ca` |
| 耗时 | 242.3s |
| headless 判定 | **PASS** `runner-failed-accepted` |
| 阶段数 | **25**（含 test_write / test_run / verify_imports / venv 链） |
| 工作区 | `T4/.headless-iter` |

### 生成（P0 验证 ✓）

- `workflow-gen` **12469 chars**，**attempt=1 parse_success**（无截断重试）
- 完整 TDD 链：`stage_test_write_indicators` + `stage_test_run_*` + `stage_verify_imports_*`

### 执行进展

| 阶段 | 结果 |
|------|------|
| `stage_decide_indicators` → 多段 `stage_impl_*` | ✓ 落盘 `src/indicators/{ma,boll,vol,macd}.py` |
| `stage_test_write_indicators` | ✓ `tests/test_indicators.py` |
| `stage_verify_imports_indicators` | ✓ |
| `stage_venv_create` | ✓ `.venv`（**E8 路径对齐**） |
| `stage_venv_pip_install` | ✗ exitCode=1（**requirements.txt 尚未落盘**） |

### 新暴露 **E9**

`stage_venv_pip_install` 在 `requirements.txt` impl 阶段之前执行 → pip 找不到文件。

---

## 运行 #8 — 2026-06-09（P0 重试，LLM 三轮皆败）

| 字段 | 值 |
|------|-----|
| instance | `4cd0a557-ce15-44a7-bc9b-b000bf2e3257` |
| 结果 | **FAIL @ generate** `stages 不能为空` |

### P0 重试日志（有效）

| attempt | 触发原因 |
|---------|----------|
| 1 | `empty_stages_after_parse` |
| 2 | **`stage_count_too_low`**（2 阶段）← 新逻辑 |
| 3 | `empty_stages_after_parse`（repair → wf_invalid） |

---

## 运行 #7 — 2026-06-09（planCompleteness 全开误伤）

| 字段 | 值 |
|------|-----|
| instance | `5ebcfaca-6af2-4846-8b15-072f3592cc0e` |
| 结果 | **FAIL** `template-stage-cap-exceeded`（14 阶段 > express cap 8） |

### 教训

live 不宜开启完整 `plan.requireCompleteness`（会阻断合法的大计划）；**TDD 硬阻断**由 `plan-completeness-hard` gate 独立负责。

---

## 本轮引擎补丁（P0 + P1）

| 项 | 实现 |
|----|------|
| **P0** | `assessGeneratedPlanStructure` — parse 后检测 `stages<4` / 缺 impl / 缺 test_run → 消耗 attempt 重跑 |
| **P1** | `GeneratedWorkflowGate` + `GATE_ID_PLAN_COMPLETENESS_HARD` — software 硬阻断 `missing-test-run-pair` / `missing-verification-stage` |
| live 配置 | `generation.maxParseRetries: 3`（不开启完整 planCompleteness） |

---

## 运行 #6 — 2026-06-09（venv 路径修复后，LLM 截断）

| 字段 | 值 |
|------|-----|
| commit | `800bee53` |
| 命令 | `npm run feedback:live:t4` |
| 工作区 | `T4/.headless-iter`（每轮 wipe 后仅需求 md） |
| 耗时 | 151.5s |
| 结果 | **FAIL @ generate 门禁** |
| instance | `b823fbb3-a95b-4fed-806c-63fa43754b84` |

### 失败摘要

```
stage count 3 < min 6
```

### 根因

- `path_router: express` ✓
- `workflow-gen` 2289 chars + `continue` 369 chars → JSON **在 `stage_test_write_slice_mvp` 中段截断**
- 落盘工作流仅 3 阶段：`stage_init_npm_workspace` / `stage_decide_slice_mvp` / `stage_test_write_slice_mvp`（无 impl / test_run）
- headless `minStages: 6` 正确拒绝；**未进入执行**

### 待修项

| 优先级 | 问题 | 建议 |
|--------|------|------|
| **P0** | express 路径下 workflow-gen 仍可能截断为残缺计划 | 空/短 stages 触发 generate 重试（已有逻辑需覆盖「stages<阈值」） |
| **P1** | 残缺计划（test_write 无 test_run）应被 plan-completeness **block** 而非仅 headless minStages | 接 `GeneratedWorkflowGate` 硬阻断 |

---

## 运行 #5 — 2026-06-09（E4/E5/E6 + 干净工作区）

| 字段 | 值 |
|------|-----|
| commit | `800bee53` |
| 命令 | `npm run feedback:live:t4`（默认 `T4/.headless-iter`） |
| 工作区 | `/Users/tina/Documents/auto_skills/T4/.headless-iter` |
| 耗时 | 255.9s |
| headless 判定 | **PASS** `runner-failed-accepted` |
| instance | `a32eea65-0abb-4f73-9c10-13a35716259d` |
| 阶段数 | 14（计划）/ 执行至第 5 阶段失败 |

### 本轮引擎补丁（#4 优先级）

| ID | 修复 |
|----|------|
| **E4** | `multiFileBundleOutput.ts` — 多 `file_*` bundle 拆分到 `runtime.outputs` |
| **E5** | `file-write` 空 `sourceOutputKey` 内容 → `throw` |
| **E6** | `tddChainChecks.ts` — `test_write`↔`test_run` 配对 + software 验证门禁 |
| **P2** | `prepareT4IterWorkspace()` — 干净迭代目录（仅需求 md） |

### 生成 / 路由

- `path_router: express`（干净工作区 ✓，非 #4 棕场）
- `workflow-gen` 6546 + `continue` 669 + `}` → **一次 parse 成功**
- 工作流含 `stage_setup`（venv）、`stage_impl_slice_1`（bootstrap.py）、conftest、TDD 链

### 执行失败点（#5 新暴露 **E8**）

| 检查项 | 结果 |
|--------|------|
| `stage_setup` | `python3 -m venv **venv**` + pip |
| `stage_venv_import_check`（自修复注入） | 使用 **`.venv/bin/python`** → exitCode **127** |
| `bootstrap.py` | ✓ 15551 chars 已落盘（未执行 bootstrap） |

**E8 修复（#5→#6 间已落地）**：`resolveVenvDirName` / `resolveVenvImportCheckCommand` — 从已有 setup 命令解析 venv 目录。

### 产物

- `T4/.headless-iter/bootstrap.py`（generator 脚本，含 config/indicators/… 内嵌）
- 引擎日志：`.stagent/instances/a32eea65-.../.wf-debug.log`

---

## 运行 #2 — 2026-06-09（P0/P1 修复后）

| 字段 | 值 |
|------|-----|
| commit | `800bee53` |
| 命令 | `npm run feedback:live:t4` |
| 工作区 | `/Users/tina/Documents/auto_skills/T4`（绝对路径 ✓） |
| 模型 | `deepseek-v4-flash` @ `https://api.deepseek.com/v1` |
| 耗时 | 131.8s |
| 结果 | **FAIL @ generate** |
| instance | `47176b1c-d436-4071-9172-44a2f956ccfd` |

### 失败摘要

```
generate failed: stages 不能为空
```

### 根因链（引擎 debug）

1. **polish** ✓（4652 chars）
2. **path_router** → `brownfield_full`（T4 已有 `main.py` / `tests/` / `config.yaml` 等，非绿场）
3. **workflow-gen** ✗：`responseChars: 0`，`chunkCount: 0`，耗时 ~96s，**空 SSE 流**
4. **workflow-gen-repair** → 兜底 `wf_invalid` + `stages: []`
5. **validateGeneratedWorkflow** → `stages 不能为空` → `workflowFailed`

### 与运行 #1 对比

| 维度 | 运行 #1（736f76ae） | 运行 #2（47176b1c） |
|------|---------------------|---------------------|
| path_router | `express`（绿场） | `brownfield_full`（棕场） |
| 生成 | ✓ 工作流落盘 | ✗ generate 空响应 |
| 执行失败点 | `stage_verify_imports_main`（路径/API） | 未进入执行 |
| taskWorkspacePath | 相对 `../T4` | 绝对 `/Users/.../T4`（P1 已修） |

### 待修项（按优先级）

| 优先级 | 问题 | 建议修复 |
|--------|------|----------|
| **P0** | `workflow-gen` 空响应无重试 | `CoreLlmInvoker` 空流重试 + `LlmParseRetryLoop` 跳过空 raw 解析 |
| **P1** | 棕场 prompt 12.7k chars 可能触发模型空回 | 提高 `maxOutputTokens`；或 T4 迭代子目录 `--workspace T4/clean-run` |
| **P1** | 空响应错误信息不清晰 | `workflowFailed` reason 改为 `workflow-gen 返回空响应` 而非 `stages 不能为空` |
| **P2** | T4 残留产物影响 path_router | 文档约定：迭代前归档 `main.py` 或专用子工作区 |

### 产物路径

- 报告：`autoAI/artifacts/headless-feedback.json`
- Trace：`autoAI/artifacts/headless-feedback.trace.jsonl`
- 引擎日志：`T4/.stagent/instances/47176b1c-d436-4071-9172-44a2f956ccfd/.wf-debug.log`

---

## 运行 #1 — 2026-06-09（P0 修复前，摘要）

| 字段 | 值 |
|------|-----|
| instance | `736f76ae-219d-42a6-aa59-341dc650952c` |
| 结果 | 链路跑完 ~3min，**FAIL @ `stage_verify_imports_main`** |
| 根因 | `inferPythonTestFile` → `tests/test_main.py`（实际 `test_core.py`）；相对 `taskWorkspacePath`；API `moving_average` vs `calculate_ma` |

P0/P1 引擎修复已落地（test_write 路径、绝对 workspace、API align suffix）。待运行 #3 验证执行期。

---

## 运行 #3 — 2026-06-09（空响应重试后）

| 字段 | 值 |
|------|-----|
| instance | `b1942973-9ece-4107-9cfa-0084a001b19c` |
| 耗时 | 185.2s |
| 结果 | **FAIL @ generate**（同上 `stages 不能为空`） |

### 根因链（与 #2 不同）

1. **workflow-gen** 有输出（3050 chars）但 JSON **截断**
2. **workflow-gen-continue** 16102 chars，内容为 Markdown 指标说明，**非 JSON 续写**
3. **workflow-gen-repair** → 仍产出 `wf_invalid` + `stages: []`
4. `parse_success` 在 attempt=1 即通过（repair 可解析），**未触发第 2 次 generate 重试**

### 引擎补丁（#3 后）

- `LlmParseRetryLoop`：`stages.length === 0` 视为解析失败，消耗 attempt 并重跑 workflow-gen
- 待运行 #4 验证

---

## 运行 #4 — 2026-06-09（stages 空重试 + 第 2 次 generate）

| 字段 | 值 |
|------|-----|
| instance | `6c6a06ea-7fca-41cc-961a-1aa9ff4fc589` |
| trace | `trace_0465dafe-92c2-4ed6-bd98-2bf6f61ea70b` |
| 耗时 | 308.5s |
| headless 判定 | **PASS** `workflowCompleted` |
| 阶段数 | 15 |
| taskWorkspacePath | `/Users/tina/Documents/auto_skills/T4` ✓ |

### 生成路径

- `path_router: brownfield_full`（棕场）
- `workflow-gen` 5352 chars → `workflow-gen-continue` 3239 chars → 解析成功（第 2 次 generate 或续写成功）
- 工作流形态：**无 test_run**；`stage_impl_mvp` 多文件 bundle + 9× `file-write` 落盘

### 执行结果（质量审计 — 未达 T4 真验收）

| 检查项 | 结果 |
|--------|------|
| `pytest` / `stage_test_run_*` | **未生成** |
| `verify_imports` | **未生成** |
| `config.yaml` | ✗ 写入整段 Markdown bundle（含 `file_indicators/...` 围栏），非纯 YAML |
| `main.py` | ✗ 空文件 |
| `indicators/`、`broker/` 等 | ✗ 目录未创建 |
| `tests/test_all.py` | ✓ 有内容（test_write 落盘）但与 impl 模块路径不对齐 |
| 落盘根 | ✓ `pathBase: workspace` → T4 根目录 |

### 新引擎问题（#4 暴露）

| ID | 问题 | 位置/线索 |
|----|------|-----------|
| **E4** | 多输出键 `file_*` impl：LLM 一次返回多文件 Markdown，引擎只认 `file_config.yaml` 单键 | `stage_impl_mvp` llm_end 8831 chars；`stage_end outputKey: file_config.yaml` |
| **E5** | 后续 `file-write` 从空 `sourceOutputKey` 刷出空文件仍标 `done` | `main.py` / `DELIVERY.md` 0 字节 |
| **E6** | 棕场计划可省略 TDD 链仍 `workflowCompleted` | 缺 Rule20 / plan-completeness 对 `test_run` 硬门禁 |
| **E7** | `wf-state.json` 与 debug 不一致（write 阶段 debug=done，state=pending） | 持久化竞态或提前 `run_end` |

### 本轮已落地引擎补丁

1. `CoreLlmInvoker`：空 SSE 流自动重试一次
2. `LlmParseRetryLoop`：空 raw / 空 stages 不视为 parse 成功，消耗 attempt

### 棕场路径提示

T4 目录已有上轮产物 → `path_router: brownfield_full` → prompt 12751 chars + 大 JSON 输出，截断风险高。可选：

- 迭代专用子目录：`--workspace T4/.iter-clean`（仅保留需求 md）
- 或临时移走 `main.py` / `tests/` 回到 express 路径做 A/B

---

## R3b 契约生命周期 + Live T4（2026-06-10）

### 代码落地（stagent-core）

- `decisionArtifacts.dependencies[]` + `collectDeclaredDependenciesFromInstance`
- post impl/fix：`module-contract-post-mutate` / `export-contract-post-impl` / `declared-deps-post-mutate`
- post test_write：`python-declared-deps-test-write`
- pre test_run：`python-requirements-merge` / `python-pip-resync` / `python-declared-deps-pre-test-run`
- fix：`additionalWriteTargets` 分隔落盘 + routing prompt
- **关键修复**：`createWorkflowEngineParts` 调用 `registerBuiltinQualityGates()`（headless 此前门禁注册表为空）

### Live T4 三轮（R3b + M39 包布局）

| Run | instance | 耗时 | 终态 | 备注 |
|-----|----------|------|------|------|
| 1（无 registerBuiltin） | `686395d2` | ~366s | fix 链耗尽 · talib | 门禁未生效 |
| 2（R3b 完整） | `0906692d` | ~357s | `sdk-path-contract` hard @ test_run | post-impl `charter-constraint-warn` 已打出；未进 fix（pre-test_run 阻断） |
| 3（registry SSOT） | `56f70e07` | ~344s | fix #2 `module-contract` hard | **M39.2 通过**；进 test_run + fix chain；见 #17 |
| 4（export SSOT） | `ad980644` | ~173s | verify_imports fail | `from __init__ import`；见 #18 |
| 5（层1+层3 桥接） | `09869baa` | ~188s | impl `module-contract` hard | `from indicators import` ✓；stub `compute` vs slice `compute_ma`；见 #19 |
| 6（decisionRecord exports） | `35133fbd` | ~507s | test_run fix 链耗尽 | stub/契约对齐 ✓；进 pytest + fix×2；见 #20 |
| 7（GREEN 行为桥接） | `31a0098d` | ~414s | signals test_write gate | **indicators pytest ✓**；signals 契约漂移；见 #21 |

---

## 运行 #17 — 2026-06-10（M39 包布局 SSOT 后）

| 字段 | 值 |
|------|-----|
| commit | `800bee53`（本地未提交：registry SSOT patch） |
| 命令 | `npm run build:core && npm run feedback:live:t4` |
| 工作区 | `T4/.headless-iter` |
| 耗时 | 343.6s |
| headless 判定 | **FAIL** `execution ended early` |
| instance | `56f70e07-566d-498c-a826-1347c17d128d` |
| 引擎日志 | `T4/.headless-iter/.stagent/instances/56f70e07-.../.wf-debug.log` |

### 相对 Run 2 的变化

| 检查项 | Run 2 | Run 3 |
|--------|-------|-------|
| M39.2 `test-import-path-not-in-plan` | ❌ pre-test_run 阻断 | ✅ 无此错误 |
| `from indicators import …` + `indicators/__init__.py` | 不认包布局 | registry SSOT 覆盖 |
| 进入 `stage_test_run_indicators` | 否 | ✅ pytest 执行（exit 1） |
| fix chain | 未触发 | ✅ `stage_fix_if_failed_indicators` ×2 |
| pre-test_run `pip-resync` | — | ✅ 第二次 test_run 前执行 |

### 执行路径摘要

```
greenfield_full · 50 stages · indicators 切片
  → test_write（from indicators import compute_*）✓
  → verify_imports ✓
  → impl indicators/__init__.py ✓（charter-constraint-warn only）
  → venv + pip ✓
  → test_run pytest exit 1
  → fix #1 落盘 impl ✓ → loop back test_run（仍 fail，pip-resync）
  → fix #2 落盘 impl → module-contract hard 阻断
```

### 失败摘要

```
module-contract（python-impl-export-extra）：
indicators/__init__.py 导出未声明符号 ema
（契约 exports: compute_ma, compute_boll, compute_vol, compute_macd, compute_cci）
```

### 根因（非 LLM 顶层漂移）

落盘文件中 `ema` 为 **`compute_macd` 内嵌套函数**（4 空格缩进），并非模块顶层 API：

```python
def compute_macd(...):
    def ema(series, span):
        return series.ewm(span=span, adjust=False).mean()
```

`extractExportedSymbols` 使用 `^\s*def`，把**任意缩进**的 `def` 都计为模块导出 → `python-impl-export-extra` **误报**。Python 中 `from indicators import ema` 并不可行。

### R3b 验收（本轮）

| Gate | 结果 |
|------|------|
| M39.2 sdk-path-contract | ✅ |
| post-impl charter warn | ⚠️ |
| pre-test_run pip-resync | ✅（重试路径） |
| fix routing（多文件 prompt） | ✅ 注入 |
| module-contract-post-mutate | ⚠️ **误报阻断**（嵌套 def） |
| declared-deps / talib | ⏭️ 未触发 |

### 待修项（Run #17 时）

| 优先级 | 问题 | 状态 |
|--------|------|------|
| **P0** | `extractExportedSymbols` 嵌套 `def` 误报 | ✅ 已落地（见 Run #18 代码节） |
| P1 | fix #1 未写出 `requirements.txt` 分隔段 | 待查 |
| P2 | declared-deps / talib 场景 | 待 LLM 复现 |

---

## 运行 #18 — 2026-06-10（export 表面 SSOT 后）

### 代码补丁（stagent-core）

- `PythonExportContractLint.extractExportedSymbols`：`^def` / `^class` **仅模块顶层**（行首无缩进）；`__all__` 不变
- 单测：`python-export-surface.test.ts`（嵌套 `ema` 不触发 extra；顶层 `rogue_helper` 仍阻断）
- `@stagent/core`：**717 pass**

| 字段 | 值 |
|------|-----|
| 命令 | `npm run build:core && npm run feedback:live:t4` |
| 耗时 | 173.1s |
| headless 判定 | **FAIL** `workflowFailed` @ verify_imports |
| instance | `ad980644-a92d-4242-9b3c-803793ff7e17` |

### 失败摘要（LLM 方差，非 export lint）

`stage_test_write_indicators` 落盘：

```python
from __init__ import (compute_ma, ...)
```

`verify-python-test-imports.mjs --strict` exit 1 → `workflowFailed`（未进入 impl / test_run / fix）。

### 与 Run #17 对比

| 项 | Run #17 | Run #18 |
|----|---------|---------|
| 失败阶段 | fix #2 `module-contract`（嵌套 ema 误报） | verify_imports |
| export SSOT | 未修 | ✅ 已修 |
| 验证 fix 链越过 ema gate | — | **未跑到**（需再跑或 mock 回归） |

### R3b 表更新

| Run | instance | 耗时 | 终态 | 备注 |
|-----|----------|------|------|------|
| 3（registry SSOT） | `56f70e07` | ~344s | fix #2 module-contract | M39.2 ✓；嵌套 ema 误报 |
| 4（export SSOT） | `ad980644` | ~173s | verify_imports exit 1 | `from __init__ import` LLM 幻觉 |
| 5（层1+层3） | `09869baa` | ~188s | impl export-extra | import 模块名已对齐；stub/decide exports 漂移 |
| 6（record exports） | `35133fbd` | ~507s | test_run + fix 耗尽 | stub 从 decisionRecord 合成；impl gate ✓ |
| 7（GREEN 桥接） | `31a0098d` | ~414s | signals module-contract | indicators pytest 绿 |
| 8（exports SSOT） | `4738a595` | ~365s | indicators fix 耗尽 | 未进 signals；弱断言 test 红 |

---

## 运行 #32 — 2026-06-11（broker 死锁 → test_run code-runner-timeout）

| 字段 | 值 |
|------|-----|
| 耗时 | 1730.8s |
| headless 判定 | **FAIL** `code-runner-timeout` @ `stage_test_run_broker`（replan fix 后 pytest 挂起 60s） |
| instance | `ddd614cd-ec3a-4153-945c-3c90956b0f97` |

### RCA

replan fix 写出 `SimBroker`：`place_order` 持 `threading.Lock` 调 `_fill_order` → `_generate_order_id` 再 acquire 同锁 → 死锁；pytest 永不结束。

### 根治

| # | 机制 | 落点 |
|---|------|------|
| 1 | GREEN 桥接：测试含 `threading` 时 prompt 要求 RLock/禁嵌套 acquire | `testImportBridgePromptSuffix.ts` |
| 2 | `stage_test_run_*` code-runner timeout 60→120s | `expandGreenfieldPythonSkeleton.ts` |

---

## 离线迭代 — 2026-06-12（behaviorSpec P2 gate + golden fixture 回归 · 零 API）

> Live 暂停（DeepSeek 402），按「先离线根治、再 Live 复验」推进 §4.3.1 P2。

### 代码补丁（stagent-core · behaviorSpec P2）

| # | 机制 | 落点 |
|---|------|------|
| 1 | `lintTestAgainstBehaviorSpec`：条件 id 覆盖（全缺 hard / 部分缺 warn）、函数覆盖、`_set_ideal_*` 先于边界覆写（Run #45 假红形态，edge_rules 声明才检查） | `commitment/BehaviorSpecLint.ts` |
| 2 | `behavior-spec-test-write` post-stage gate（test_write + testfix replan；block 走 P1 同 stage 重写链） | `quality-gates/postStageGates.ts` |
| 3 | 设置 `python.behaviorSpecLint`（off/warn/hard；AFK 默认 hard） | `settings/readers/exec.ts`、`execution-bindings/*` |
| 4 | decide 硬拒：必填切片缺 behaviorSpec → 拒绝批准触发 decide 重试链（堵 Run #52 实证洞：decide_signals 仅 warning 放行） | `hitl/DecisionLintGate.ts`、`HitlApproveDecision.ts` |
| 5 | bug 修复：`synthesizeSliceDecisionArtifacts` 合成 exports 时丢失 `behaviorSpec` 字段 | `commitment/decisionRecordExports.ts` |

### golden fixture 离线回归（历史失败固化进仓库）

| fixture | 来源 | 回归断言 |
|---------|------|----------|
| `fixtures/run48PlanShapes.ts` | Run #48 generate 失败形态（外部落盘已被清理，按 RCA 固化等价 plan） | sanitize 前有 `multi-file-prompt-mismatch`/`test-write-import-not-in-plan`，sanitize 后清零；替换原依赖外部绝对路径的静默跳过测试 |
| `fixtures/run52-golden.json` | Run #52 instance `3ca5c7d3` 真实落盘（plan + decide_signals 产物 + test_signals 代码） | ① 真实 plan 为 completeness 正样本；② decide_signals 当时缺 behaviorSpec → P2 decide 硬拒可拦截；③ 真实测试函数覆盖通过、条件 id 未引用可检出 |

### 单测

`behavior-spec-gate.test.ts`（18 用例：lint 6 + gate 三档 8 + decide 硬拒 4，含 synthesize 保留 behaviorSpec）+ `golden-run52.test.ts`（4 用例）全绿。

### Run #52 补充 RCA

复查 `.wf-state.json`：**全切片 test_run 一次绿（fix_if_failed 全 skipped）**，推进至 `stage_smoke_run` 才因 402 中断——结构契约修复链已生效；但 `stage_decide_signals` 未产出 behaviorSpec 仅记 warning（本次 P2 decide 硬拒已堵）。

---

## 运行 #55 — 2026-06-13（单入口 behaviorSpec 修复 · generate 早败 ❌）

| 字段 | 值 |
|------|-----|
| 耗时 | 291.6s |
| headless 判定 | **FAIL** `plan_incomplete` @ generate |
| instance | `1c6f9570-0491-4b31-9fe1-d516ca1d60da` |

### 失败摘要

`stage_impl_main`：`实现 main/cli.py 和 main/__init__.py（可选）`（无反引号 prose 路径）+ lint 将 `config.yaml` 引用误计为第二落盘文件 → `multi-file-prompt-mismatch`。sanitize 仅处理反引号路径，未收敛 Run #55 形态。

### 根治（Run #55→#56）

| # | 机制 | 落点 |
|---|------|------|
| 1 | sanitize：`PROSE_DUAL_PY` + `PLAIN_PY_PATH` 收敛 prose 多 `.py` 暗示 | `sanitizeSemanticFillPrompts.ts` |
| 2 | lint：multi-file 检查仅计 `.py` 路径（`config.yaml` 等引用不算第二落盘） | `multiFileImplChecks.ts` |

---

## 运行 #54 — 2026-06-13（forward-slice import 修复 · behaviorSpec 单入口 API 误拦 ❌）

| 字段 | 值 |
|------|-----|
| 命令 | `npm run build:core && npm run feedback:live:t4` |
| 耗时 | 712.9s |
| headless 判定 | **FAIL** @ `stage_test_write_signals`（gate 耗尽，未进 test_run） |
| instance | `6be970e5-d184-476f-9776-27f7c5e3a760` |
| commit | `e7da2b87`（含 ForwardSliceImportLint） |

### 进展

| 项 | 结果 |
|----|------|
| indicators test_run | ✅ 绿（fix×1 后） |
| decide_signals behaviorSpec | ✅ 产出 |
| signals test_write | ❌ behavior-spec gate 3 次重写后耗尽 |

### 失败摘要

decide exports 为单入口 `generate_signals`，behaviorSpec.functions 为逻辑分组 `generate_bear_signal` / `generate_bull_signal`；gate 要求测试直接调用 spec 函数名 → 假红阻断（测试已正确调用 `generate_signals("bear"|"bull", …)`）。

### 根治（Run #54→#55）

| # | 机制 | 落点 |
|---|------|------|
| 1 | 单入口 API：测试调用契约 export 且不在 spec.functions 名中时，跳过逐函数名覆盖，仍检 condition id | `BehaviorSpecLint.ts`、`postStageGates.ts` |

---

## 运行 #53 — 2026-06-13（P3 Live 复验 · signals behaviorSpec ✅ · risk 前向依赖 broker ❌）

| 字段 | 值 |
|------|-----|
| 命令 | `npm run build:core && npm run feedback:live:t4` |
| 耗时 | 1357.5s |
| headless 判定 | **FAIL** `fix chain exhausted` @ `stage_test_run_risk` |
| instance | `9a64bb58-670e-4091-bf73-7195896e78af` |
| LLM | 29 calls · 258667 tok |

### P3 验收（signals 切片）

| 项 | 结果 |
|----|------|
| `stage_decide_signals` 产出 `behaviorSpec` | ✅ `check_long_signal` / `check_short_signal` + 9 条 conditions + edge_rules（含 `_set_ideal_*` 先行） |
| `stage_test_run_signals` pytest | ✅ exit 0，fix 链未触发 |
| strict delivery pass | ❌ 未达（risk 阻断） |

### 失败摘要

`risk/__init__.py` 顶层 `from broker import SimBroker`；broker 切片尚未 materialize → pytest 收集期 `ModuleNotFoundError: No module named 'broker'`（exit 5/2）。fix 链 2 次 + testfix replan 1 次仍写回顶层 import，fix 耗尽。

### RCA

| # | 根因 | 机制缺口 |
|---|------|----------|
| 1 | 垂直切片按序推进时，较早切片 impl 硬依赖尚未落盘的后续切片 | 无 post-impl forward-slice import lint；fix 路由未区分「第三方包缺失」vs「后续切片未建」 |

### 根治（Run #53→#54）

| # | 机制 | 落点 |
|---|------|------|
| 1 | post impl/fix `lintForwardSliceImportsInImpl`（后续切片模块未落盘 → module-contract gate block + mutate 同 stage 重写） | `ForwardSliceImportLint.ts`、`sliceContractGateHelpers.ts` |
| 2 | fix 链注入 lazy import / 可注入 callable 提示 | `fixRoutingPromptSuffix.ts`、`LlmTextInvokeStep.ts` |

---

## 运行 #53（旧记 · P0 接线）— 2026-06-12

| 字段 | 值 |
|------|-----|
| 命令 | `npm run build:core && npm run feedback:live:t4` |
| 备注 | P0：`behaviorSpecSchema` + `buildBehaviorSpecPromptSuffix` 接入 decide→test_write/impl/fix/testfix；signals decide 必填 behaviorSpec |

### 代码补丁（stagent-core · behaviorSpec P0）

| # | 机制 | 落点 |
|---|------|------|
| 1 | `DecisionArtifactsV1.behaviorSpec` schema + `validateBehaviorSpecForSemantic` | `behaviorSpecSchema.ts` |
| 2 | `buildBehaviorSpecPromptSuffix` / `buildBehaviorSpecFixHints` | `behaviorSpec.ts` |
| 3 | signals decide prompt + parse 校验 | `parseDecisionArtifacts.ts`、`expandGreenfieldPythonSkeleton.ts` |
| 4 | test_write / impl / fix / testfix 注入 | `LlmTextInvokeStep.ts`、`fixRoutingPromptSuffix.ts` |

---

## 运行 #52 — 2026-06-12（API 余额不足 · 中断）

| 字段 | 值 |
|------|-----|
| 耗时 | 664.9s |
| headless 判定 | **FAIL** `LLM API 402 Insufficient Balance` |
| 备注 | DeepSeek 账户余额耗尽，Live 循环暂停待充值 |

---

## 运行 #51 — 2026-06-12（signals impl · index_sh 契约污染）

| 字段 | 值 |
|------|-----|
| 耗时 | 1099.2s |
| headless 判定 | **FAIL** `python-impl-export-missing` @ `stage_impl_signals` |
| instance | `485857e8-fa68-49a5-8703-052b7b5f5d1f` |

### RCA

decide sidecar exports 混入 `index_sh/index_sz`（非 API）；test_write import 之；impl gate 要求导出 `index_sh` 但 LLM 3 次 mutate 重试仍失败。

### 根治（Run #52 代码）

| # | 机制 | 落点 |
|---|------|------|
| 1 | `pruneExportNoise` 剔除 `index_sh/index_sz` 行情占位符 | `decisionRecordExports.ts` |

---

## 运行 #50 — 2026-06-12（main 通过 · signals fix 链耗尽）

| 字段 | 值 |
|------|-----|
| 耗时 | 1928.2s |
| headless 判定 | **FAIL** `fix chain exhausted` @ `stage_fix_if_failed_signals` |
| instance | `13998656-382e-4425-a088-73eed10a8ee5` |

### 里程碑

| 切片 | test_run |
|------|----------|
| generate | ✅（#48 sanitize 生效） |
| indicators | ✅（replan 链） |
| signals | ❌ fix+replan 耗尽 |
| risk/broker/main | 未到达 |

### RCA

`test_bear_signal_all_conditions_met` 等：`generate_bear_signal()` 返回 None（CCI cross AND 链与 fixture 不一致）；8 failed / 6 passed。

### 根治（Run #51 代码）

| # | 机制 | 落点 |
|---|------|------|
| 1 | signals fix 路由：None 结果时注入 CCI/MA20/volume AND 链对齐提示 | `fixRoutingPromptSuffix.ts` |

---

## 运行 #49 — 2026-06-12（generate 根治复验 · main patch 阻断）

### 代码补丁（stagent-core，Run #48 根治）

- `sanitizeSemanticFillWorkflow`：语义填充后收敛 impl 多文件路径暗示、`your_module` 占位 import
- `fillSkeletonStagePrompts` FILL_SYSTEM_PROMPT：禁止多文件落盘暗示与 your_module
- 单测：`sanitize-semantic-fill-prompts.test.ts`（含 Run #48 wf-state 回归）；**801 pass**

| 字段 | 值 |
|------|-----|
| 耗时 | 2296.4s |
| headless 判定 | **FAIL** `python-test-patch-undeclared-export` @ `stage_test_write_main` |
| instance | `7e4e6ddf-0176-414c-994b-22ab58507de3` |

### 里程碑

| 项 | 结果 |
|----|------|
| generate plan_incomplete | ✅ 通过（#48 根治生效） |
| indicators/signals/risk/broker test_run | ✅（含 fix/replan 链） |
| main test_write | ❌ patch `indicators.compute` 非契约 export |

### RCA

gate 重试 2 次后耗尽：test_main 仍 patch 架构示例名 `indicators.compute`，契约 exports 为 `MA,BOLL,VOL,MACD,CCI,IndicatorCalculator`。

### 根治（Run #50 代码）

| # | 机制 | 落点 |
|---|------|------|
| 1 | main test_write 注入各切片 exports SSOT（跨模块 patch 合法目标表） | `buildCrossModulePatchExportsPromptSuffix` |
| 2 | test_write gate 重试规则补跨模块 patch 约束 | `testWriteGateRetry.ts` |

---

## 运行 #48 — 2026-06-12（generate · multi-file + your_module）

| 字段 | 值 |
|------|-----|
| 耗时 | 127.6s |
| headless 判定 | **FAIL @ generate** `multi-file-prompt-mismatch` + `test-write-import-not-in-plan` |
| instance | `13e7ff9a-c0ff-4fbd-935f-4e4118a13086` |

### RCA

语义填充 impl 提及 `broker/core.py`+`sim_broker.py` 或 `main/core.py`+`cli.py`（与 writeOutputToFile 单文件不一致）；test_write 使用 `from your_module.indicators import`。

### 根治（Run #49 代码）

| # | 机制 | 落点 |
|---|------|------|
| 1 | `repairImplPromptSingleFileTarget` / `repairTestWritePromptImports` | `sanitizeSemanticFillPrompts.ts` |
| 2 | 骨架语义填充后自动 sanitize | `generateWorkflowFromSkeleton.ts` |

---

## 运行 #46 — 2026-06-12（signals testfix 边界规则 · 复验中）

### 代码补丁（stagent-core，Run #45 根治）

- `buildReplanStage`：testfix 通用规则（`_set_ideal_*` 须在边界 MA 覆盖**之后**调用）；signals 专项（严格 `< 2*MIN_TICK`）
- `decisionRecordExports`：显式「五个公开函数为」优先；`pruneExportNoise` 剔除 KeyError/assign/rolling 等噪声
- 单测：runtime-replan signals 用例 + decision-record-exports；**796 pass**

| 字段 | 值 |
|------|-----|
| 命令 | `npm run build:core && npm run feedback:live:t4` |
| headless 判定 | *Run #48 复验中* |

---

## 运行 #47 — 2026-06-12（decide_main lint 重试注释错位）

| 字段 | 值 |
|------|-----|
| 耗时 | 1293.4s |
| headless 判定 | **FAIL** `decision lint rejected after 2 retries` @ `stage_decide_main` |
| instance | `4e4f8393-752a-4340-8ce1-e714f73a1b36` |

### 里程碑

| 切片 | test_run |
|------|----------|
| indicators | ✅（含 replan 链） |
| signals/risk/broker | 推进中 |
| main | 未到达 impl（decide 阻断） |

### RCA

`DECISION_LINT_RETRY_COMMENT` 要求「背景/问题、候选方案对比…」，与 `DecisionRecordVerify` 实际校验的 `### 职责边界` 等四节**不一致** → LLM 重试 3 次仍缺章。

### 根治（Run #48 代码）

| # | 机制 | 落点 |
|---|------|------|
| 1 | `buildDecisionLintRetryUserComment()` SSOT 对齐 I-17 四节标题 | `DecisionRecordVerify.ts` + `scripts/headless/run.mjs` |

---

## 运行 #46 — 2026-06-12（generate · multi-file-prompt-mismatch）

| 字段 | 值 |
|------|-----|
| 耗时 | 131.1s |
| headless 判定 | **FAIL @ generate** `plan_incomplete: multi-file-prompt-mismatch` |
| 工作区 | `T4/.headless-iter`（已 wipe） |

### RCA

LLM 语义填充 impl 阶段 systemPrompt 提及多文件路径，与 `writeOutputToFile` 单文件目标不一致 → planCompleteness 硬阻断，未进入执行（方差，非 #45 回归）。

---

## 运行 #45 — 2026-06-12（四切片推进 · signals fix 链耗尽）

| 字段 | 值 |
|------|-----|
| 耗时 | 1972.4s |
| headless 判定 | **FAIL** `fix chain exhausted` @ `stage_fix_if_failed_signals` |
| instance | `21f295f2-5e0f-4735-be3d-301d4e53dc65` |

### 里程碑

| 切片 | test_run |
|------|----------|
| indicators | ✅（testfix+replan 链后绿） |
| signals | ❌ fix 链耗尽 |
| risk/broker/main | 未到达 |

### RCA

`test_edge_convergence_exact_2_tick_no_signal`：先设 MA spread=2 再调 `_set_ideal_short_df` → 助手覆盖 MA 为 spread=1 → impl 正确触发信号但测试断言 no signal（假红）。

### 根治（Run #46 代码）

| # | 机制 | 落点 |
|---|------|------|
| 1 | testfix prompt：边界列须在 `_set_ideal_*` **之后**覆盖 | `buildReplanStage.TESTFIX_REWRITE_COMMON_RULES` |
| 2 | signals 专项：`< 2*MIN_TICK` 严格小于语义 | `buildReplanStage.signalsSliceReplanRules` |

---

## 运行 #44 — 2026-06-12（exports 噪声误阻断 @ indicators）

### 代码补丁（stagent-core，Run #43 根治）

- `ConfigContractLint`：`extractYamlTopLevelKeys` / `buildConfigYamlAccessGuide` / `buildConfigYamlAccessExamples` — 顶层键 + 嵌套 `cfg['broker']['sim']` 示例；禁止 `trade`/`modules`/`data_source` 幻觉键
- `buildConfigYamlBridgePromptSuffix`：扁平键列表 → 嵌套访问指南 + YAML 预览
- `mutateGateRetry`：config-contract block 时追加专项修正（RiskManager→`cfg['risk']`、SimBroker→`cfg['broker']['sim']['initial_balance']` 等）
- 单测：`config-contract-lint.test.ts` T4 嵌套 YAML 用例；**792 pass**

| 字段 | 值 |
|------|-----|
| 字段 | 值 |
|------|-----|
| 命令 | `npm run build:core && npm run feedback:live:t4` |
| 耗时 | 353.0s |
| headless 判定 | **FAIL** `module-contract export-missing` @ `stage_impl_indicators` |
| instance | `e21508c6-43c6-40c4-9efe-e007e7e43081` |

### RCA（exports 抽取噪声）

`stage_decide_indicators` 正文含 `df.assign()` / `抛出 KeyError` → 误合成 exports 含 `assign,KeyError,rolling,...` → mutate 重试×2 仍失败。

### 根治（Run #45 代码，见上表）

---

## 运行 #43 — 2026-06-11（main config 键漂移 @ impl）

| 字段 | 值 |
|------|-----|
| 耗时 | 2660.2s |
| headless 判定 | **FAIL** `config-contract-post-impl` @ `stage_impl_main`（trade/modules/data_source 等未定义键） |
| instance | `837fa316-830c-4a85-82bb-49d5b96ff386` |
| 里程碑 | indicators/signals/risk/broker pytest 均通过，首次进入 main impl |

### 根治（Run #44 代码）

| # | 机制 | 落点 |
|---|------|------|
| 1 | 嵌套 config 访问 SSOT（顶层键 + `cfg['broker']['sim']` 示例 + 禁止 trade/modules/data_source） | `ConfigContractLint.buildConfigYamlAccessGuide`、`testImportBridgePromptSuffix` |
| 2 | config-contract mutate 重试专项修正指引 | `mutateGateRetry.buildConfigContractMutateRetryAppend` |

---

## 运行 #42 — 2026-06-11（signals 行为断言 / MACD 零轴）

| 字段 | 值 |
|------|-----|
| 耗时 | 1433.3s |
| headless 判定 | **FAIL** fix 链耗尽 @ `stage_test_run_signals`（4/14 行为断言失败） |
| instance | `181d1e59-5c74-4a91-a408-a97833e51169` |

### 根因

- test 契约 `generate_short_signal`/`generate_long_signal` 与 impl 列名已对齐；失败为 MACD 零轴/布林带等行为语义未满足
- replan 三级链已耗尽（3 attempts/slice）

### 待观察

- Run #41 跨模块 patch gate 已生效（无 compute_indicators ImportError）
- 需复验 Run #40 路径（全 pytest 绿 + smoke CSV seed）

---

## 运行 #41 — 2026-06-11（signals test patch indicators.compute_indicators）

| 字段 | 值 |
|------|-----|
| 耗时 | 1486.2s |
| headless 判定 | **FAIL** fix 链耗尽 @ `stage_test_run_signals`（patch 架构粗粒度 export） |
| instance | `8e07ce23-944f-48d8-aa57-59779a87a4ca` |

### 根治

| # | 机制 | 落点 |
|---|------|------|
| 1 | test_write 硬阻断跨模块 patch 未声明 export | `ModuleContractLint.lintTestCrossModulePatchTargetsAgainstContracts` |
| 2 | prompt 示例改为 slice 级符号 compute_ma | `sliceContractExports.ts` |

---

## 运行 #40 — 2026-06-11（smoke 缺 mock CSV）

| 字段 | 值 |
|------|-----|
| 耗时 | 1443.6s |
| headless 判定 | **FAIL** `stage_smoke_run`（config broker.mock_csv_path 文件不存在） |
| instance | `9a733b47-14ab-4858-899b-f5dfce9cc9ec` |
| 里程碑 | 四切片 + main pytest 全绿后仅 smoke 失败 |

### 根治

| # | 机制 | 落点 |
|---|------|------|
| 1 | smoke 前 pre-gate 种子缺失 CSV fixture | `smokeDataBootstrap.ts` + `preStageGates.ts` |

---

## 运行 #39 — 2026-06-11（main config DI 误报 + data_source 键漂移）

| 字段 | 值 |
|------|-----|
| 耗时 | 1920.0s |
| headless 判定 | **FAIL** `config-contract-post-impl` @ `stage_impl_main`（config.get 函数注入键误报） |
| instance | `7487ca1d-61ff-401e-998b-8c845b365ff6` |

### 根因

- main.py 用 `config.get("compute_indicators")` 等同名 DI 注入函数，被 config 键契约 lint 误判为必需配置键
- 另含 `data_source` 等真实漂移键（应使用架构 config 已有键如 mock_csv_path）

### 根治

| # | 机制 | 落点 |
|---|------|------|
| 1 | `var=config.get("var")` 同名 DI 排除 | `ConfigContractLint.extractConfigDependencyInjectionKeys` |
| 2 | config.yaml 桥接 prompt 禁止 DI 注入 | `testImportBridgePromptSuffix.ts` |
| 3 | mutate 重试补充 DI 禁止规则 | `mutateGateRetry.ts` |

---

## 运行 #38 — 2026-06-11（main export=mode + patch main.SimBroker）

| 字段 | 值 |
|------|-----|
| 耗时 | 1203.3s |
| headless 判定 | **FAIL** `python-impl-export-extra` @ `stage_impl_main`（契约 exports: mode，impl 导出 SimBroker） |
| instance | `4866d5d9-b3e4-4b22-84a9-7533fc005f67` |

### 根因

- `stage_decide_main` 将 CLI `--mode` 误写为 export `mode`
- test_write 用 `patch("main.SimBroker")` 等未声明符号；impl 为迎合测试在 main.py 模块级定义 SimBroker → export-extra gate 阻断

### 根治

| # | 机制 | 落点 |
|---|------|------|
| 1 | main 切片 `mode` → `main` export 规范化 | `decisionArtifactsSchema.sanitizeModuleExports` |
| 2 | test_write 硬阻断 patch 未声明 export | `ModuleContractLint.lintTestPatchTargetsAgainstModuleContract` |
| 3 | prompt SSOT：main export + patch 指向真实模块 | `sliceContractExports.ts` |
| 4 | mutate 重试：禁止 main 模块级定义其它切片符号 | `mutateGateRetry.ts` |

---

## 运行 #37 — 2026-06-11（decide_signals 声明 talib → pip 重装失败）

| 字段 | 值 |
|------|-----|
| 耗时 | 622.9s |
| headless 判定 | **FAIL** `python-pip-resync` @ `stage_test_run_signals`（`talib` pip install exitCode=1） |
| instance | `1f20bac8-64f7-438b-a55c-4bbb8b06e206` |

### 根因

- `stage_decide_signals` 的 `decisionArtifacts.dependencies` 含 `talib`（架构决策已禁止 ta-lib）
- `python-requirements-merge` 合并后触发 pip resync；TA-Lib 无 C 库无法安装

### 根治

| # | 机制 | 落点 |
|---|------|------|
| 1 | `BLOCKED_PIP_DEPENDENCIES` 黑名单（talib/ta-lib/pandas-ta） | `blockedPipDependencies.ts` |
| 2 | `collectDeclaredDependenciesFromInstance` 过滤 blocked | `decisionArtifactsSchema.ts` |
| 3 | `pruneUndeclaredRequirements` 始终剔除 blocked | `requirementsMerge.ts` |
| 4 | pip resync 失败时 prune + 重试一次 | `preStageGates.ts` |

---

## 运行 #36 — 2026-06-11（declared-deps 误报 import __future__）

| 字段 | 值 |
|------|-----|
| 耗时 | 1055.9s |
| headless 判定 | **FAIL** `python-declared-deps` @ `stage_impl_broker`（`__future__` 未声明） |
| instance | （见 `.headless-iter/.stagent/instances` 最新） |

### 根治

| # | 机制 | 落点 |
|---|------|------|
| 1 | `PYTHON_STDLIB_ROOTS` 增加 `__future__` | `pythonStdlibRoots.ts` |

---

## 运行 #35 — 2026-06-11（broker export-extra Account/OrderResult）

| 字段 | 值 |
|------|-----|
| 耗时 | 1262.1s |
| headless 判定 | **FAIL** `module-contract export-extra` @ `stage_fix_if_failed_broker`（mutate 重试耗尽） |
| instance | `e3d35422-7fbd-4454-a56a-3fb2dbf71ce0` |

### 相对 Run #34

| 项 | Run #34 | Run #35 |
|----|---------|---------|
| talib prune | — | ✅ 未再遇 pip 失败 |
| indicators/signals/risk | 未全过 | ✅ 过 |
| broker | — | impl+test_run 红 → fix mutate×2 仍 export-extra |

---

## 运行 #34 — 2026-06-11（requirements 含未声明 talib → pip 失败）

| 字段 | 值 |
|------|-----|
| 耗时 | 464.7s |
| headless 判定 | **FAIL** `requirements 变更后 pip 重装失败` @ `stage_test_run_signals` |
| instance | `183cc0ba-bce0-4a8c-9f3a-…` |

### RCA

fix 链将 `talib` 写入 requirements.txt；未在 decisionArtifacts.dependencies 声明 → pip 无法安装 → PYTHON_PIP_RESYNC 阻断。

### 根治

| # | 机制 | 落点 |
|---|------|------|
| 1 | test_run 前 `pruneUndeclaredRequirements`：requirements 白名单=已声明依赖 | `requirementsMerge.ts`、`preStageGates.ts` |

---

## 运行 #33 — 2026-06-11（smoke config 键契约 · main 读 data）

| 字段 | 值 |
|------|-----|
| 耗时 | 1069.8s |
| headless 判定 | **FAIL** `invariant-violation` @ `stage_smoke_run`（四切片+main pytest 绿） |
| instance | `8575b1a7-cf1b-4649-aab7-940a39225af8` |

### RCA

fix 后 `main.py` 使用 `config['data']`；落盘 config.yaml 仅有 `kline_path`/`data_source` 等 → `ConfigContractLint` @ smoke 硬阻断。

### 根治

| # | 机制 | 落点 |
|---|------|------|
| 1 | impl/fix main 注入 architecture config.yaml 键 SSOT | `buildConfigYamlBridgePromptSuffix` |
| 2 | post impl/fix `config-contract-post-impl` 硬门禁 + mutate 重试 | `configContractGateHelpers.ts` |

---

## 运行 #31 — 2026-06-11（全切片 pytest 绿 · smoke 缺 --config）

| 字段 | 值 |
|------|-----|
| 耗时 | 1202.3s |
| headless 判定 | **FAIL** `tool-execution-failed` @ `stage_smoke_run`（四切片 pytest 均已绿） |
| instance | `4d0108fc-c654-4af0-802d-ed047c57ec4a` |

### 里程碑

| 切片 | test_run |
|------|----------|
| indicators | ✅ |
| signals | ✅ |
| risk | ✅ |
| broker | ✅ |
| main | ✅（fix×1） |

### RCA

`injectSmokeStage` 推导 `python3 main.py`；`main.run_cli` 要求 `--config` → argparse exit 2 → serve 判「启动后立即退出」。

### 根治

| # | 机制 | 落点 |
|---|------|------|
| 1 | 计划含 `stage_write_config` 时 smoke 用 `.venv/bin/python main.py --config config.yaml` | `smokeStage.ts` |

---

## 运行 #30 — 2026-06-11（indicators fix 链在 posttestfix 后未重置）

| 字段 | 值 |
|------|-----|
| 耗时 | 602.9s |
| headless 判定 | **FAIL** `test_run still failing after fix chain exhausted` @ `stage_test_run_indicators` |
| instance | `691a3974-74af-4890-930d-6b57fbc39c74` |

### 相对 Run #29

| 项 | Run #29 | Run #30 |
|----|---------|---------|
| 升级链 3 级 | 新代码首跑（signals 挂） | ✅ indicators 跑满 fix→testfix→posttestfix |
| 失败切片 | signals | indicators（`test_compute_ma_with_nan_close`） |
| posttestfix 后 fix | 未到达 | ❌ fix 计数未重置 → 直接 workflowFailed |

### 根治

| # | 机制 | 落点 |
|---|------|------|
| 1 | `afterRuntimeReplanFixStage` 回绕 test_run 前 `resetFixChainLedger` | `testRunSelfHeal.ts`、`FixExhaustedRouter.ts` |

---

## 运行 #29 — 2026-06-11（signals fix 链耗尽 @ testfix 后 impl 未对齐）

| 字段 | 值 |
|------|-----|
| 耗时 | 888.9s |
| headless 判定 | **FAIL** `test_run still failing after fix chain exhausted` @ `stage_test_run_signals` |
| instance | `74b8cbd1-aaf0-44b4-b170-fbed8bda41c9` |

### 相对 Run #28

| 项 | Run #28 | Run #29 |
|----|---------|---------|
| llmTimeout=600 | — | ✅ 未再遇流式超时 |
| indicators | 未到达 | ✅ 过 |
| signals | 超时 @ test_write | 到 test_run；fix×2 + impl replan + testfix 后仍 1–5 红 |
| 终态 | 瞬态超时 | fix 升级链三级未闭合 |

### RCA

1. `runtime_replan_fix_*`（impl 升级）**未注入** `buildFixTestGreenBridgePromptSuffix` → LLM 只见 pytest 摘要，不见测试全文与 `prev_*` 动态列语义。
2. testfix 重写测试后（如 `prev_vol_ma_short` 白线上升检查），fix 链 + impl replan **无第 3 级**按新测试对齐 impl → `already-inserted` / 预算耗尽 → `workflowFailed`。
3. 终盘 workspace 仅余 1 红：`vol_ma_short` override 期望 False，impl 用 `vol_ma_short < vol_ma_long` 而非 `prev_vol_ma_short` 比较。

### 根治

| # | 机制 | 落点 |
|---|------|------|
| 1 | `runtime_replan_fix_*` / `posttestfix_fix_*` 注入 fix 行为桥接（测试全文 + pytest 失败） | `LlmTextInvokeStep.ts` |
| 2 | fix-exhausted 升级链第 3 级：`posttestfix_fix` impl 按新测试对齐 | `planDeterministicReplan.ts`、`buildReplanStage.ts` |
| 3 | per-slice replan 预算 2→3；impl replan prompt 明确 `prev_*` 列 | `constants.ts`、`buildFixExhaustedReplanStage` |

---

## 运行 #28 — 2026-06-11（LLM 流式空闲超时 @ signals test_write）

| 字段 | 值 |
|------|-----|
| 耗时 | 1716.7s |
| headless 判定 | **FAIL** LLM 流式响应中断（180s 空闲超时）@ `stage_test_write_signals` |
| instance | `c1800302-909e-457b-bb88-ffc4090faeb5` |

### 相对 Run #27

| 项 | Run #27 | Run #28 |
|----|---------|---------|
| pip resync | ❌ yaml 无效包名 | ✅ 修复后通过 |
| indicators | 未到达 | ✅ 过（含 testfix+fix replan） |
| 失败点 | pip | 瞬态 LLM 超时（非代码缺陷） |

### 根治

| # | 机制 | 落点 |
|---|------|------|
| 1 | T4 live AFK 将 `llmTimeoutSeconds` 提升至 600（引擎允许上限） | `scripts/headless/run.mjs` `buildLiveConfigOverrides` |

---

## 运行 #27 — 2026-06-11（requirements 含无效 pip 包名 yaml）

| 字段 | 值 |
|------|-----|
| 耗时 | 313.3s |
| headless 判定 | **FAIL** `requirements 变更后 pip 重装失败（exitCode=1）` @ `stage_test_run_indicators` |
| instance | `c322100e-07a5-403e-8853-4cfad48ee412` |

### RCA

Run #26 根治 `inferImplicitDependenciesFromArtifacts` 同时加入 `pyyaml` + `yaml` → `PYTHON_REQUIREMENTS_MERGE` 将 `yaml` 写入 requirements.txt → pip 无此包名 → 首次 test_run 前 pip resync 失败。

### 根治

| # | 机制 | 落点 |
|---|------|------|
| 1 | 隐式依赖仅 `pyyaml`；`import yaml` 继续由 `isDeclaredImportRoot` 别名放行 | `decisionArtifactsSchema.ts` |
| 2 | `toPipInstallableDependencies` 过滤 import 别名后再 merge requirements | `preStageGates.ts` |

---

## 运行 #26 — 2026-06-11（main 切片 export-extra + yaml 未声明）

| 字段 | 值 |
|------|-----|
| 命令 | `npm run build:core && npm run feedback:live:t4` |
| 耗时 | 1454.6s |
| headless 判定 | **FAIL** `workflowFailed` @ `stage_impl_main` |
| instance | `109b8deb-9d49-4fa2-b79e-4c1a96e375de` |

### 相对 Run #24（replan 链已验证）

| 项 | Run #24 | Run #26 |
|----|---------|---------|
| indicators/signals/risk/broker | broker testfix 失败 | ✅ 四切片均过（含 replan 自愈） |
| 到达 main | ❌ | ✅ 到达 `stage_impl_main` |
| 失败点 | broker testfix 虚构 API | main `DataPipeline` export-extra |

### RCA

1. **export-extra（假红对偶）**：`main.py` 模块级 `class DataPipeline` 未在契约 exports 中 → post-impl `module-contract` hard block，**无同 stage 重试** → 一次即 `workflowFailed`。
2. **declared-deps yaml**：架构决策含 `config.yaml` 但 `dependencies` 未列 pyyaml → `test_write_main` / `main.py` 的 `import yaml` 被 gate 拦截；test_write 有 P1 重试但无依赖 SSOT 预防。

### 根治（确定性机制 + 单测）

| # | 机制 | 落点 |
|---|------|------|
| 1 | `config.yaml` 落盘 → 隐式 `pyyaml`/`yaml`；`import yaml` 在 pyyaml 已声明时合法 | `decisionArtifactsSchema.ts`、`PythonDeclaredDependenciesLint.ts` |
| 2 | 运行时注入**已声明依赖 SSOT** + impl **export 表面规则**（仅契约符号；helper 须 `_` 或嵌套） | `buildDeclaredDependenciesPromptSuffix`、`buildSliceContractExportsPromptSuffix`、`LlmTextInvokeStep.ts` |
| 3 | impl/fix post-mutate gate block → **同 stage 重试 ≤2 次**（`MutateGateBlockedError`） | `mutateGateRetry.ts`、`LlmTextScoreStep.ts`、`LlmTextStageRunner.ts` |

- 单测：`declared-deps-inference.test.ts`、`mutate-gate-retry.test.ts`；**775 pass**
- mock 回归 `feedback:quick` 6/6

---

## 运行 #25 — 2026-06-11（decision lint 拒绝 → AFK 挂死）

| 字段 | 值 |
|------|-----|
| headless 判定 | **HANG**（手动终止）@ `stage_decide_indicators` paused |
| instance | `f38c74f7-22a3-468f-b763-deaab4f25172` |

### RCA

`stage_decide_indicators` 产出低质量 decisionRecord（confidence 0.1 / quality 0.405，缺必需章节）→ harness 自动 `approveDecision` 被 decision content lint 拒绝（`decisionLintRejected`，invariant-violation）→ stage 停 paused；harness `decisionApprovalAttempted` 只尝试一次 → 无人值守挂死直到 timeout。

### 根治（确定性机制）

| # | 机制 | 落点 |
|---|------|------|
| 1 | AFK 驾驶员：decision lint 拒绝 → `engine.retry(stageId, lint 反馈)` 重生成 decisionRecord 并重新批准（≤2 次）；耗尽则快速失败给出确定性终因 | `scripts/headless/run.mjs`（drainHitl） |

- 复用引擎既有 `handleRetry` decision 重试链（回滚 artifacts + 下游 reset + retryComment 注入），无引擎改动
- mock 回归 `feedback:quick` 6/6

---

## 运行 #24 — 2026-06-11（replan 原地突变 + testfix 升级链首次实战）

### 代码补丁（stagent-core，本轮前置 = Run #23 根治）

- `applyRuntimeReplan` 原地突变 + 执行循环每轮重读 instance
- fix-exhausted 升级链：impl replan 仍红 → `stage_runtime_replan_testfix_<slice>` 重写测试
- `test-brittle-assertion` hard 规则（`is np.nan` / 内置异常 match）

| 字段 | 值 |
|------|-----|
| 命令 | `npm run build:core && npm run feedback:live:t4` |
| 耗时 | 1136.9s |
| headless 判定 | **FAIL** `instance status failed without workflowFailed` @ broker |
| instance | `323d99cb-0dee-4e87-b756-7dedd73b04f4` |

### 相对 Run #23（结构性根治全部验证生效）

| 项 | Run #23 | Run #24 |
|----|---------|---------|
| indicators | fix 耗尽失败 | ✅ 一次绿（fix skipped） |
| signals | 未到达 | ✅ 一次绿 |
| risk | 未到达 | ✅ 一次绿 |
| replan stage 执行 | ❌ 插入但被跳过 | ✅ `runtime_replan_applied` → 执行 → `fix_replan_loop_back` |
| 升级链 | 无 | ✅ fix replan → testfix replan 顺序触发 |

### RCA（broker 切片，两个新根因）

1. **testfix 重写测试无实现上下文（假红→假接口）**：testfix prompt 只有 pytest 失败输出，无 `broker/__init__.py` 源码 → LLM 虚构 `SimBroker(initial_cash=…, contract_specs=…)` 构造签名 → 重写后全部 setup `TypeError`，回绕 test_run 仍红 → 预算耗尽 → invariant-violation。
2. **harness 终态竞态**：`instance.status='failed'` 同步置位，但 stageError/workflowFailed 走异步 delivery chain；`waitForTerminal` 轮询命中窗口 → 误报 `failed without workflowFailed`（真实终因 blockDeliveryOnTestFailure 被遮蔽），且 scheduleSave 未 flush（盘上 status 仍 running）。

### 根治（确定性机制 + 单测）

| # | 机制 | 落点 |
|---|------|------|
| 1 | testfix replan 注入**实现源码 SSOT**（impl 文件全文 + 当前测试 + pytest 失败；指令禁止虚构 API） | `testImportBridgePromptSuffix.ts`（`buildTestRewriteImplBridgePromptSuffix`）、`LlmTextInvokeStep.ts` |
| 2 | harness `waitForTerminal` 检测到 failed 后给 delivery chain 3s flush 宽限，再按 workflowFailed → gateReason → 误报顺序定性 | `scripts/headless/run.mjs` |

- 单测：`test-import-bridge-prompt-suffix.test.ts` 新增 testfix 桥接用例（实现签名在场 / 文件缺失回退）；**767 pass**
- mock 回归 `feedback:quick` 6/6

---

## 运行 #23 — 2026-06-10（P0 测试质量硬门禁 + P1 同 stage 重试）

### 代码补丁（stagent-core，本轮前置）

- P0：`TestQualityLint` 新增 `test-sys-modules-hijack` 规则；弱断言/无断言/恒真/劫持标记 `hard`；新 gate `GATE_ID_TEST_QUALITY_TEST_WRITE`（post `test_write`，AFK 默认 hard block）
- P1：gate block → `TestWriteGateBlockedError` → 同 stage 带 gate 反馈重写测试 ≤2 次（`LlmTextStageRunner` 重试环）
- 单测：`test-quality-gate.test.ts`、`test-write-gate-retry.test.ts`；全绿后进 live

| 字段 | 值 |
|------|-----|
| 命令 | `npm run build:core && npm run feedback:live:t4` |
| headless 判定 | **FAIL** `invariant-violation: test_run still failing after fix chain exhausted` @ indicators |
| instance | `468ff73b-9771-4c8f-8f3c-1a6affc8e115` |

### 相对 Run #22

| 项 | Run #22 | Run #23 |
|----|---------|---------|
| 测试质量 | 弱断言 `is not None` | ✅ 行为级断言（P0 生效） |
| pytest | 全红 | 12/17 通过，5 失败 |
| 失败性质 | 假绿（测试太弱） | **假红**（测试断言非契约属性） |
| replan | 未触发 | 触发但 stage 未执行（见根因 1） |

### RCA（两个结构性根因）

1. **replan stage 永不执行**：`applyRuntimeReplan` 返回新 instance 对象，但 `executeNextStageLoopLinear` 在循环外解构缓存了旧 `instance` 引用 → 插入的 replan stage 不可见 → fix prelude 二次进入 → `runtime_replan_skipped: already-inserted` → 终态 invariant-violation。
2. **脆弱测试（假红）无修复通道**：5 个失败断言全部源于测试自身缺陷——`assert x is np.nan`（NaN 非单例）、`pytest.raises(AttributeError, match="can't set attribute")`（消息随 Python 版本变化）、数学上不可保证的数值巧合阈值；fix 链与 impl replan 只能改实现，结构上无解。

### 根治（确定性机制 + 单测）

| # | 机制 | 落点 |
|---|------|------|
| 1 | `applyRuntimeReplan` 改为**原地突变**（splice stages / 重建 runtimes / 置 currentStageIndex）；执行循环每轮重读 `params.instance` | `applyRuntimeReplan.ts`、`StageStepDriver.ts` |
| 2 | fix-exhausted 升级链第 2 级：impl replan 已试过仍红 → 插入 `stage_runtime_replan_testfix_<slice>` **重写假红嫌疑测试**（预算仍受 replanBudget 约束）；回绕路由识别 testfix id | `planDeterministicReplan.ts`、`buildReplanStage.ts`、`constants.ts`、`FixExhaustedRouter.ts`、`testRunSelfHeal.ts` |
| 3 | `TestQualityLint` 新增 `test-brittle-assertion`（hard）：`is np.nan` 身份比较、内置异常 `match=` 消息原文；testfix replan stage 同样过 test 质量 gate + P1 重试；重试 prompt 增补脆弱断言禁令 | `TestQualityLint.ts`、`postStageGates.ts`、`LlmTextScoreStep.ts`、`testWriteGateRetry.ts` |

- 单测：`runtime-replan-apply-in-place.test.ts`（原地突变 / already-inserted / 升级链 / testfix 路由）+ `test-quality-lint.test.ts` 脆弱断言用例；**758 pass**
- mock 回归 `feedback:quick` 6/6

---

## 运行 #22 — 2026-06-10（契约 exports 运行时 SSOT）

### 代码补丁（stagent-core）

- `sliceContractExports.ts`：`resolveSliceContractExports` + `buildSliceContractExportsPromptSuffix`（覆盖骨架静态 exports 示例）
- `decisionRecordExports`：`BUILTIN_EXPORT_NOISE` 过滤 `int(0~3)`；`isWeakModuleExports` 重合成；主方法 `` `generate` `` 抽取
- `LlmTextInvokeStep`：test_write/impl 优先注入契约 SSOT；fix 同源 `resolveSliceContractExports`
- 单测：`slice-contract-exports-prompt.test.ts` + signals 噪声用例；**734 pass**

| 字段 | 值 |
|------|-----|
| 命令 | `npm run build:core && npm run feedback:live:t4` |
| 耗时 | 365.0s |
| headless 判定 | **FAIL** `fix chain exhausted` @ indicators |
| instance | `4738a595-814f-4d6a-b919-3afa821cec4a` |

### 相对 Run #21

| 项 | Run #21 | Run #22 |
|----|---------|---------|
| 到达 signals | ❌ test_write gate | ⏭️ 未到达（indicators 先失败） |
| indicators pytest | ✅ exit 0 | ❌ exit 1 + fix×2 |
| test_run-contract-lint | cross-file key | **弱断言** `is not None` |
| test_write prompt | 6523 chars（含 SSOT） | 6523 chars（含 SSOT） |

### 失败摘要

```
test-run-contract-lint: tests/test_indicators.py 仅断言 is not None
pytest exit 1 → fix×2 仍红 → fix-exhausted
```

Run #21 signals 根因（SignalGenerator vs `generate`）**本 run 未验证**——工作流生成方差使 indicators 切片先以弱测试失败。

### 待修项（Run #22）

| 优先级 | 问题 |
|--------|------|
| P1 | post `test_write` 弱断言 gate（`is not None` / `assert True`）hard block |
| P2 | 下轮再验 signals exports SSOT（Run #21 场景） |

---

## 运行 #21 — 2026-06-10（GREEN 行为桥接）

### 代码补丁（stagent-core）

- `buildTestGreenBridgePromptSuffix`：impl 注入落盘 `tests/test_<semantic>.py` 全文（≤14k chars）+ GREEN 规则
- `buildFixTestGreenBridgePromptSuffix`：fix 注入 test 全文 + pytest 失败摘要（≤6k）
- `readTestRunFailureExcerpt`：fix 路由统一读 verifyOut/stdout/stderr
- impl prompt 实测 ~14k chars（含 test 全文）；**730 pass**

| 字段 | 值 |
|------|-----|
| 命令 | `npm run build:core && npm run feedback:live:t4` |
| 耗时 | 414.3s |
| headless 判定 | **FAIL** @ `stage_test_write_signals` module-contract |
| instance | `31a0098d-7a1e-4e47-ad2b-b144b8d60dec` |

### 里程碑：indicators 切片首次 pytest 绿

```
stage_test_run_indicators → exit 0（fix_if_failed 被 skip）
```

相对 Run #20（indicators fix 链耗尽），GREEN 行为桥接在 **impl 主路径** 上生效。

### 失败摘要（signals 切片 · LLM 方差）

```
post test_write module-contract：
tests/test_signals.py import SignalGenerator
契约 exports（slice）未声明该符号
```

prompt 示例写 `SignalGenerator`，但 slice decide 合成 exports 不含该类名 → gate 正确阻断（未进入 impl/test_run）。

### R3b 验收（Run #21）

| Gate | 结果 |
|------|------|
| indicators pytest 绿 | ✅ **首次** |
| GREEN 桥接 impl prompt | ✅ ~14k chars |
| signals test_write 契约 | ❌ export 名漂移 |

---

## 运行 #20 — 2026-06-10（decisionRecord → exports SSOT）

### 代码补丁（stagent-core）

- `extractModuleExportsFromDecisionRecord` / `synthesizeSliceDecisionArtifacts`：切片 decide 无 JSON sidecar 时从正文抽取 exports
- `resolveModuleExports` 优先级：slice sidecar → **slice decisionRecord** → global
- `materialize-python-module-stub.mjs` 调用 dist `resolveModuleExports`（含 record 回退）
- decide 落盘 / approve 时自动合成 `decisionArtifacts.modules[]`
- 单测：`decision-record-exports.test.ts` + materialize 集成；**728 pass**

| 字段 | 值 |
|------|-----|
| 命令 | `npm run build:core && npm run feedback:live:t4` |
| 耗时 | 507.2s |
| headless 判定 | **FAIL** `workflowFailed` · fix chain exhausted |
| instance | `35133fbd-b895-496f-920d-88cae408e7d3` |

### 相对 Run #19 的变化

| 项 | Run #19 | Run #20 |
|----|---------|---------|
| stub exports | `compute`（global 回退） | `compute_ma,compute_boll,…,IndicatorResult` |
| post-impl module-contract | ❌ hard | ✅ 通过 |
| verify_imports | ✅ | ✅ |
| 失败阶段 | impl | test_run pytest exit 1 → fix×2 仍红 |

### 失败摘要

pytest 断言失败（非契约 gate）；fix 链 2 次后 `fix-exhausted` → `blockDeliveryOnTestFailure`。

### R3b 验收（Run #20）

| Gate | 结果 |
|------|------|
| stub/decide exports 对齐 | ✅ |
| post-impl module-contract | ✅ |
| test_run + fix routing | ✅ 触发 |
| pytest 绿 | ❌ LLM impl 质量 |

---

## 运行 #19 — 2026-06-10（层1 apiAlign + 层3 test→impl 桥接）

### 代码补丁（stagent-core）

- `resolveSlicePythonImportModuleName`：`test_write` / `apiAlign` 用 semantic（`indicators`），不再 `basename(__init__.py)`
- `buildTestImportBridgePromptSuffix`：`impl_*` 读取 `tests/test_<semantic>.py` 已落盘 import 注入 system prompt
- 单测：`decision-api-align-prompt-suffix.test.ts`、`test-import-bridge-prompt-suffix.test.ts`；**723 pass**

| 字段 | 值 |
|------|-----|
| 命令 | `npm run build:core && npm run feedback:live:t4` |
| 耗时 | 188.3s |
| headless 判定 | **FAIL** `execution ended early` @ `stage_impl_indicators` |
| instance | `09869baa-0b71-48de-9cd1-a26bd9f56130` |

### 相对 Run #18 的变化

| 项 | Run #18 | Run #19 |
|----|---------|---------|
| test_write import | `from __init__ import` | ✅ `from indicators import compute_*` |
| verify_imports | ❌ exit 1 | ✅ done |
| 失败阶段 | verify_imports | post-impl `module-contract` |
| 失败原因 | 模块名幻觉 | stub exports=`compute` vs 切片 decide/test=`compute_ma`… |

### 失败摘要

```
module-contract（python-impl-export-extra）：
indicators/__init__.py 导出 compute_ma（契约 exports: compute）
```

`stage_materialize_stub_indicators` 日志：`exports=compute`（全局/骨架 stub）；`stage_decide_indicators` prompt 示例为 `compute_ma`…；test_write 与 impl 跟随后者 → gate 以 stub 契约为 SSOT 阻断。

### 待修项（Run #19 → Run #20 已闭合 P0）

| 优先级 | 问题 | 状态 |
|--------|------|------|
| **P0** | stub materialize 与 slice exports 同源（decisionRecord 合成） | ✅ Run #20 |
| P1 | pytest 绿 / fix 链收敛 | ✅ indicators @ Run #21；全链路待多切片 |

---

## PR-2 Charter Gate 1（headless 验收）

**日期**：2026-06-09

### Calibration（`.stagent/charter/calibration/questions.jsonl`）

- `evaluateAdrDetectorMetrics`：adr 召回 ≥ 95%，non-adr 误升级 ≤ 5%
- 单元：`packages/stagent-core/src/test/adr-criteria-detector.test.ts`

### Headless smoke

| 命令 | 链路 |
|------|------|
| `npm run feedback:charter-suggest` | suggest → `waiting-questions` → enrich `suggestedAnswer` → 自动作答 → `workflowCompleted` |
| `npm run feedback:charter-auto` | `auto-with-escalation`：seam 静默预填 + ADR 题 `stageQuestionsBefore` → 作答 → `workflowCompleted` |
