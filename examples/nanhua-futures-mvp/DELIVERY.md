# 交付说明

## 做了什么

本交付实现了一套期货自动下单软件的三个核心模块：技术指标计算（均线、布林带、成交量、MACD、CCI）、交易信号生成（多空条件）、风控止损判断（15点固定止损），以及一个模拟券商接口。所有模块都通过了单元测试，可以在离线环境独立验证，为后续接入真实行情和实盘打下基础。

## 文件清单

- `indicators/__init__.py`：实现 MA、BOLL、VOL、MACD、CCI 五个技术指标的计算函数。
- `signals/__init__.py`：根据指标条件生成做多/做空信号。
- `risk/__init__.py`：实现固定15点止损逻辑，区分昨日对冲单与当日开单。
- `broker/__init__.py`：提供 BrokerAdapter 抽象接口与 SimBroker 模拟实现，负责下单、撤单、持仓查询。
- `main.py`：主程序入口，编排初始化与主循环（需配合 config.yaml 运行）。
- `conftest.py`：pytest 全局配置（定义共享 fixture）。
- `tests/test_indicators.py`：测试 indicators 模块各指标计算正确性。
- `tests/test_signals.py`：测试 signals 模块信号生成逻辑。
- `tests/test_risk.py`：测试 risk 模块止损判断。
- `tests/test_broker.py`：测试 broker 模块下单与查询功能。
- `tests/test_main.py`：测试 main 模块初始化与循环结构。

## 怎么运行

1. 安装 Python（3.8+）及依赖库：
   ```bash
   pip install pandas pytest
   ```

2. 进入项目根目录（包含所有上述文件的目录）：
   ```bash
   cd 项目目录
   ```

3. 运行所有测试：
   ```bash
   pytest tests/
   ```

   （注意：本交付不含 config.yaml 文件，因此直接运行 `python main.py` 会报错；请通过测试验证模块功能。）

## 验收清单（请逐项确认）

- [ ] 执行 `pytest tests/` 后，终端显示全部测试通过（无 FAILED）。
- [ ] 查看测试输出，能看到 indicators/signals/risk/broker 各模块的具体测试用例运行结果（如 “PASSED”）。
- [ ] 手动导入模块测试：在 Python 中执行 `from indicators import compute_ma` 等导入不报错。
- [ ] 运行 `pytest -v` 可看到每个测试用例的名称及状态，确认覆盖了核心功能（如 test_long_signal、test_stop_loss等）。
- [ ] 尝试修改 `indicators/__init__.py` 中的周期参数，重新运行测试可观察到某些测试失败（表明配置与代码绑定方式正确）。

## 一键自检

在项目根目录执行以下命令，确认所有测试通过：
```bash
pytest -v tests/
```
预期结果：所有测试用例显示绿色“PASSED”，无失败。

## 已知限制与未做

- **缺少配置文件**：`config.yaml` 未纳入本交付，主程序 `main.py` 无法直接运行。需要使用方自行创建配置文件以启动完整循环。
- **无实盘接入**：当前仅提供 `SimBroker` 模拟券商，不能连接真实期货交易接口。
- **行情数据源缺失**：未附带 CSV 或 mock 数据文件，测试中使用了内置 mock 随机生成行情，但主循环无法从外部获取行情。
- **部分边界情况未处理**：
  - 当指标计算窗口不足时返回 NaN，而非报错（决策记录已说明）。
  - 多空信号同时触发时，由上层（未实现）决定优先级。
  - 止损逻辑未考虑隔夜跳空对昨日对冲单的特殊处理。
  - 主循环异常处理仅跳过本轮，不重试。
- **用户需确认的前提**：假设日均交易次数 <100 次，行情数据时间戳严格有序，且各模块接口签名匹配。如果实际运行环境不满足这些假设，需调整设计。