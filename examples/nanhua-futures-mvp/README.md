# 南华期货自动下单 MVP —— Stagent 生成的示例产物

本目录是 **Stagent 工作流引擎端到端自动生成**的一个真实任务产物，原样归档，未做人工修改（除本 README 外）。它对应 [`docs/t4-live-iteration-log.md`](../../docs/t4-live-iteration-log.md) 的 **运行 #66**，是该真实任务**首次 strict delivery 通过**的交付。

## 生成方式（provenance）

- 任务档位：`live-t4-nanhua-futures`（T4 真实任务）
- 输入真源：[`需求分析-南华期货自动下单.md`](需求分析-南华期货自动下单.md)
- 模型：`deepseek-v4-flash`（主）+ `deepseek-v4-pro`（test-write / 集成切片）——异族出题人 + Run #65 integration 路由
- 引擎判定：`workflowCompleted` · **strict delivery 1/1**（pytest 全绿 + MVP 目录 + 可追溯 + 完成态）
- 规模：49 stages · 29 次 LLM 调用 · ~22 分钟
- 复跑实测：**83 passed**

> 复现命令（需配置 `DEEPSEEK_API_KEY`，并在干净工作区放入需求文档）：
> ```bash
> LLM_MODEL=deepseek-v4-flash LLM_MODEL_TEST_WRITE=deepseek-v4-pro \
>   node scripts/headless/run.mjs --live --scenario execute --live-tier 4 --keep --workspace <空目录>
> ```

## 目录结构

```
indicators/__init__.py   MA / BOLL / VOL / MACD / CCI 五个技术指标（pandas/numpy 实现）
signals/__init__.py      check_long_signal / check_short_signal 多空信号判定
risk/__init__.py         calculate_stop_loss / classify_order / should_stop_loss（15 点止损 + 四情形对冲）
broker/__init__.py       BrokerAdapter 抽象 + SimBroker 模拟券商实现
main.py                  CLI 主程序：数据 → 指标 → 信号 → 风控 → 下单
config.yaml              集中配置（指标参数 / 风控点数 / 数据源 / 券商）
conftest.py              pytest flat-layout 引导
requirements.txt         依赖
tests/                   5 个测试文件，共 83 个用例
DELIVERY.md              引擎生成的交付说明
```

## 与需求的对齐

| 需求 | 落点 |
|------|------|
| K线均线 5+6+7+8+9+11+20 | `config.yaml: ma_periods` + `indicators.compute_ma` |
| BOLL 20+2 / VOL 3+100 / MACD 14+53+60 / CCI 89 | `config.yaml` 逐项 + `compute_boll/volume/macd/cci` |
| 多/空信号（并拢穿 20 线、横盘过滤、VOL 倍量、MACD 零轴、CCI 二次穿、1 分钟同向、指数共振） | `signals.check_long_signal / check_short_signal` |
| 买入后 15 点止损 + 昨日对冲单/当日开单多空区分 | `risk.calculate_stop_loss / classify_order / should_stop_loss` |
| SimBroker + BrokerAdapter 抽象；不接实盘；指数 mock | `broker/__init__.py` |

## 运行

```bash
cd examples/nanhua-futures-mvp
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
pytest -q          # 预期：83 passed
```

## 已知瑕疵（LLM 生成原样保留，不影响测试通过）

为忠实保存"引擎生成的产物本身"，以下小问题未做人工修正：

- `requirements.txt` 含 `datetime`（标准库，不应作为 pip 依赖；PyPI 上恰有同名遗留包故未导致安装失败）。
- `DELIVERY.md` 自述"不含 config.yaml"有误——`config.yaml` 实际已生成且 `main.py` 可加载。
- `main.py` 主循环为骨架编排（一次性跑通），未做实盘行情对接与异常重试。

这些属于"产物质量"层面的可观察项；引擎已在 strict 验收口径（pytest 全绿 + MVP 目录 + 可追溯）上判定通过。
