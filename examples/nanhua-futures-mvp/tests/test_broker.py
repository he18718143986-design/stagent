import pytest
import pandas as pd
import numpy as np
import datetime
from broker import SimBroker, BrokerAdapter


class TestBrokerAdapter:
    def test_cannot_instantiate_abstract_class(self):
        """BrokerAdapter 为抽象类，直接实例化应抛出 TypeError"""
        with pytest.raises(TypeError):
            BrokerAdapter()

    def test_abstract_methods_declared(self):
        """验证 BrokerAdapter 声明了必需的抽象方法"""
        expected_methods = [
            "place_order",
            "cancel_order",
            "get_positions",
            "get_quote",
            "get_account",
            "get_history",
        ]
        for method in expected_methods:
            assert hasattr(BrokerAdapter, method)
            # 进一步检查是否为抽象方法
            assert getattr(BrokerAdapter, method).__isabstractmethod__


class TestSimBrokerInstantiation:
    def test_can_instantiate_sim_broker(self):
        """SimBroker 可正常实例化，无参数或使用空配置"""
        broker = SimBroker()
        assert isinstance(broker, SimBroker)

    def test_instantiation_with_config(self):
        """支持通过配置字典构造 SimBroker"""
        config = {
            "broker": {
                "simulated": True,
                "account_id": "test001",
                "initial_cash": 1000000,
            }
        }
        broker = SimBroker(config)
        assert broker is not None


class TestSimBrokerOrders:
    @pytest.fixture
    def broker(self):
        """返回一个全新的 SimBroker 实例，资金充足"""
        return SimBroker({"broker": {"simulated": True, "initial_cash": 1e6}})

    def test_place_order_returns_order_id(self, broker):
        """下单应返回字符串类型的订单 ID"""
        order_id = broker.place_order(symbol="rb888", side="LONG", qty=1, type="LIMIT")
        assert isinstance(order_id, str)
        assert len(order_id) > 0

    def test_place_order_with_different_sides(self, broker):
        """支持多／空方向下单"""
        long_id = broker.place_order(symbol="rb888", side="LONG", qty=2, type="MARKET")
        short_id = broker.place_order(symbol="rb888", side="SHORT", qty=3, type="LIMIT")
        assert isinstance(long_id, str)
        assert isinstance(short_id, str)
        assert long_id != short_id

    def test_cancel_existing_order_returns_true(self, broker):
        """撤销一个尚未成交的订单应返回 True"""
        order_id = broker.place_order(symbol="rb888", side="LONG", qty=1, type="LIMIT")
        result = broker.cancel_order(order_id)
        assert result is True

    def test_cancel_nonexistent_order_returns_false(self, broker):
        """撤销一个不存在的订单应返回 False"""
        result = broker.cancel_order("non-existent-id")
        assert result is False

    def test_cancel_order_idempotency(self, broker):
        """同一订单重复撤销不应引发异常，返回 False"""
        order_id = broker.place_order(symbol="rb888", side="LONG", qty=1, type="LIMIT")
        broker.cancel_order(order_id)
        second_result = broker.cancel_order(order_id)
        assert second_result is False


class TestSimBrokerPositions:
    @pytest.fixture
    def broker(self):
        return SimBroker({"broker": {"simulated": True, "initial_cash": 1e6}})

    def test_initial_positions_empty(self, broker):
        """初始状态下持仓列表应为空"""
        positions = broker.get_positions()
        assert isinstance(positions, list)
        assert len(positions) == 0

    def test_positions_after_order_fill(self, broker):
        """下单后（假设市价单立即成交）持仓列表应包含对应条目"""
        broker.place_order(symbol="rb888", side="LONG", qty=2, type="MARKET")
        positions = broker.get_positions()
        assert isinstance(positions, list)
        assert len(positions) > 0
        pos = positions[0]
        assert hasattr(pos, "symbol")
        assert hasattr(pos, "qty")
        assert pos.symbol == "rb888"

    def test_positions_aggregated_by_symbol(self, broker):
        """同一合约的多笔同向开仓应合并为一笔持仓"""
        broker.place_order(symbol="rb888", side="LONG", qty=1, type="MARKET")
        broker.place_order(symbol="rb888", side="LONG", qty=2, type="MARKET")
        positions = broker.get_positions()
        matching = [p for p in positions if p.symbol == "rb888" and p.side == "LONG"]
        assert len(matching) == 1
        assert matching[0].qty == 3


class TestSimBrokerMarketData:
    @pytest.fixture
    def broker(self):
        return SimBroker({"broker": {"simulated": True}})

    def test_get_quote_returns_valid_object(self, broker):
        """查询行情应返回包含基本字段的对象"""
        quote = broker.get_quote(symbol="rb888")
        # 假设 Quote 对象具有 bid, ask, last 属性
        assert hasattr(quote, "bid")
        assert hasattr(quote, "ask")
        assert hasattr(quote, "last")
        # 价格应为正数
        assert quote.bid > 0
        assert quote.ask > 0
        assert quote.last > 0

    def test_get_history_returns_dataframe(self, broker):
        """获取历史数据应返回 pandas DataFrame"""
        df = broker.get_history(symbol="rb888", period="3min")
        assert isinstance(df, pd.DataFrame)
        # 预期列名（可配置，此处按 OHLCV 基本字段）
        expected_columns = {"open", "high", "low", "close", "volume"}
        assert expected_columns.issubset(set(df.columns))

    def test_get_history_non_empty(self, broker):
        """默认 mock 数据源应返回非空的历史数据"""
        df = broker.get_history(symbol="rb888", period="1day")
        assert isinstance(df, pd.DataFrame)
        assert len(df) > 0


class TestSimBrokerAccount:
    @pytest.fixture
    def broker(self):
        return SimBroker({"broker": {"simulated": True, "initial_cash": 500000.0}})

    def test_get_account_returns_valid_object(self, broker):
        """查询账户应返回包含基本信息字段的对象"""
        account = broker.get_account()
        assert hasattr(account, "balance")
        assert hasattr(account, "equity")
        assert hasattr(account, "margin_used")
        # 初始余额应等于配置值
        assert account.balance == 500000.0

    def test_account_balance_after_order(self, broker):
        """下单后账户资金应相应减少（假设立即成交）"""
        broker.place_order(symbol="rb888", side="LONG", qty=1, type="MARKET")
        account = broker.get_account()
        # 仅验证余额小于初始值
        assert account.balance < 500000.0


class TestSimBrokerErrorHandling:
    @pytest.fixture
    def small_cash_broker(self):
        """资金极少的 SimBroker，用于测试资金不足"""
        return SimBroker({"broker": {"simulated": True, "initial_cash": 100.0}})

    def test_place_order_insufficient_funds_raises(self, small_cash_broker):
        """资金不足时，place_order 应抛出 InsufficientFundsError 或类似异常"""
        # 根据决策，可能抛出异常或返回 None；此处测试异常路径
        with pytest.raises(Exception):
            small_cash_broker.place_order(symbol="rb888", side="LONG", qty=1000, type="MARKET")

    def test_place_order_invalid_symbol(self, small_cash_broker):
        """传入不存在的合约代码应返回错误或抛出异常"""
        # 具体行为未定，但应出现某种错误信号
        with pytest.raises(Exception):
            small_cash_broker.place_order(symbol="INVALID", side="LONG", qty=1, type="MARKET")