import datetime
from unittest.mock import patch
import pytest
from risk import calculate_stop_loss, should_stop_loss, classify_order


def make_position(direction, cost_price):
    """创建简单持仓替身对象，包含 direction 和 cost_price 属性"""
    return type("Position", (), {"direction": direction, "cost_price": cost_price})()


# ---------- calculate_stop_loss ----------
def test_calculate_stop_loss_long_basic():
    """多头止损价 = 成本价 - 15"""
    assert calculate_stop_loss("long", 1000.0) == 985.0


def test_calculate_stop_loss_short_basic():
    """空头止损价 = 成本价 + 15"""
    assert calculate_stop_loss("short", 1000.0) == 1015.0


def test_calculate_stop_loss_long_float():
    assert calculate_stop_loss("long", 1000.5) == pytest.approx(985.5)


def test_calculate_stop_loss_short_float():
    assert calculate_stop_loss("short", 1000.5) == pytest.approx(1015.5)


def test_calculate_stop_loss_long_low_price():
    """低价格多头止损"""
    assert calculate_stop_loss("long", 15.0) == pytest.approx(0.0)


def test_calculate_stop_loss_short_high_price():
    """高价格空头止损"""
    assert calculate_stop_loss("short", 50000.0) == 50015.0


# ---------- classify_order ----------
def test_classify_order_today(monkeypatch):
    today = datetime.date(2025, 3, 24)
    monkeypatch.setattr("datetime.date.today", lambda: today)
    order = type("Order", (), {"open_date": today})()
    assert classify_order(order) == "today_order"


def test_classify_order_yesterday(monkeypatch):
    today = datetime.date(2025, 3, 24)
    yesterday = datetime.date(2025, 3, 23)
    monkeypatch.setattr("datetime.date.today", lambda: today)
    order = type("Order", (), {"open_date": yesterday})()
    assert classify_order(order) == "yesterday_hedge"


def test_classify_order_before_yesterday_is_hedge(monkeypatch):
    today = datetime.date(2025, 3, 24)
    two_days_ago = datetime.date(2025, 3, 22)
    monkeypatch.setattr("datetime.date.today", lambda: today)
    order = type("Order", (), {"open_date": two_days_ago})()
    # 早于昨天的单也应归类为昨日对冲单
    assert classify_order(order) == "yesterday_hedge"


def test_classify_order_with_datetime(monkeypatch):
    """open_date 为 datetime 对象时仍能正确比较日期部分"""
    today = datetime.date(2025, 3, 24)
    monkeypatch.setattr("datetime.date.today", lambda: today)
    open_dt = datetime.datetime(2025, 3, 24, 10, 30, 0)
    order = type("Order", (), {"open_date": open_dt})()
    assert classify_order(order) == "today_order"


def test_classify_order_datetime_yesterday(monkeypatch):
    today = datetime.date(2025, 3, 24)
    monkeypatch.setattr("datetime.date.today", lambda: today)
    open_dt = datetime.datetime(2025, 3, 23, 23, 59, 59)
    order = type("Order", (), {"open_date": open_dt})()
    assert classify_order(order) == "yesterday_hedge"


# ---------- should_stop_loss ----------
def test_should_stop_loss_long_triggered():
    pos = make_position("long", 1000.0)
    # 止损价 985，当前价 984 < 985，触发止损
    assert should_stop_loss(pos, 984.0, "today_order") is True


def test_should_stop_loss_long_not_triggered():
    pos = make_position("long", 1000.0)
    assert should_stop_loss(pos, 986.0, "today_order") is False


def test_should_stop_loss_long_exact_stop():
    """当前价等于止损价时触发"""
    pos = make_position("long", 1000.0)
    assert should_stop_loss(pos, 985.0, "today_order") is True


def test_should_stop_loss_short_triggered():
    pos = make_position("short", 1000.0)
    # 止损价 1015，当前价 1016 > 1015
    assert should_stop_loss(pos, 1016.0, "today_order") is True


def test_should_stop_loss_short_not_triggered():
    pos = make_position("short", 1000.0)
    assert should_stop_loss(pos, 1014.0, "today_order") is False


def test_should_stop_loss_short_exact_stop():
    pos = make_position("short", 1000.0)
    assert should_stop_loss(pos, 1015.0, "today_order") is True


def test_should_stop_loss_yesterday_hedge_long():
    """昨日对冲单多头触发止损行为与当日一致"""
    pos = make_position("long", 1000.0)
    assert should_stop_loss(pos, 984.0, "yesterday_hedge") is True
    assert should_stop_loss(pos, 986.0, "yesterday_hedge") is False


def test_should_stop_loss_yesterday_hedge_short():
    pos = make_position("short", 1000.0)
    assert should_stop_loss(pos, 1016.0, "yesterday_hedge") is True
    assert should_stop_loss(pos, 1014.0, "yesterday_hedge") is False


def test_should_stop_loss_gap_beyond_stop():
    """昨日对冲单隔夜跳空远超出止损价依然触发"""
    pos = make_position("long", 5000.0)   # 止损价 4985
    # 开盘价直接 4950 < 4985
    assert should_stop_loss(pos, 4950.0, "yesterday_hedge") is True


def test_should_stop_loss_today_long_with_higher_price():
    """今日多单，当前价远高于成本价不触发"""
    pos = make_position("long", 5000.0)
    assert should_stop_loss(pos, 5200.0, "today_order") is False


def test_should_stop_loss_today_short_with_lower_price():
    """今日空单，当前价远低于成本价不触发"""
    pos = make_position("short", 5000.0)
    assert should_stop_loss(pos, 4980.0, "today_order") is False