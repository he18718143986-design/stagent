import pytest
import pandas as pd
import numpy as np
from signals import check_long_signal, check_short_signal

# ---------------------------------------------------------------------------
# Fixtures: 构造典型的指标与K线数据，满足或违反各信号条件
# ---------------------------------------------------------------------------

@pytest.fixture
def base_long_data():
    """返回一个字典，包含满足所有多头信号条件的指标与K线数据。"""
    # 均线：前五线并拢 (<2) 后上穿20日线，需要至少两行
    dates = pd.date_range("2025-03-03 09:30", periods=12, freq="3T")
    # 多头MA：前一根各均线略低于MA20，最新一根上穿且前五线差值 <2
    ma_df = pd.DataFrame({
        5:  [98.0, 100.0],
        6:  [98.2, 100.3],
        7:  [98.1, 100.5],
        8:  [98.4, 100.2],
        9:  [98.3, 100.8],
        11: [98.5, 101.0],
        20: [99.0, 100.0],
    }, index=dates[-2:])  # 两行，索引为最近两根3分钟K线

    # 布林带：非横盘，带宽足够大
    boll_df = pd.DataFrame({
        "upper": [112.0, 113.0],
        "middle": [100.0, 101.0],
        "lower": [88.0, 89.0],
    }, index=dates[-2:])

    # 成交量：白线(vol_ma)上升 + 红柱(收盘>开盘)倍量
    vol_df = pd.DataFrame({
        "volume":   [500, 1200],   # 倍量
        "vol_ma":   [400, 450],    # 白线上升
        "close":    [99.0, 102.0],
        "open":     [98.0, 100.0],
    }, index=dates[-2:])

    # MACD：零轴上近零轴红柱加长
    macd_df = pd.DataFrame({
        "DIF":  [0.30, 0.35],
        "DEA":  [0.20, 0.22],
        "MACD": [0.10, 0.13],  # 红柱加长
    }, index=dates[-2:])

    # CCI：半小时内(10根3分钟K线)二次上穿0轴
    cci_series = pd.Series(
        [-80, -50, 20, -30, 40, -20, 15, -10, 25, 5, 30, 50],
        index=dates
    )

    # 1分钟K线：上穿20日线且带白点（阳线）
    kline_1min = pd.DataFrame({
        "open":  [99.0, 100.0],
        "high":  [102.0, 103.0],
        "low":   [98.5, 99.5],
        "close": [101.0, 102.5],
        "volume":[200, 300],
    }, index=dates[-2:])  # close > open 白点

    # 3分钟K线（主要窗口）
    kline_3min = pd.DataFrame({
        "open":  [98.0, 100.0],
        "high":  [103.0, 104.0],
        "low":   [97.0, 99.0],
        "close": [101.0, 102.0],
        "volume":[500, 1200],
    }, index=dates[-2:])

    # 上证深证指数：均在20日线上
    index_data = pd.DataFrame({
        "sh_close":  [3000, 3050],
        "sh_ma20":   [2950, 2960],
        "sz_close":  [10000, 10100],
        "sz_ma20":   [9900, 9950],
    }, index=dates[-2:])

    return {
        "ma": ma_df,
        "boll": boll_df,
        "vol": vol_df,
        "macd": macd_df,
        "cci": cci_series,
        "kline_1min": kline_1min,
        "kline_3min": kline_3min,
        "index": index_data,
    }


@pytest.fixture
def base_short_data():
    """返回一个字典，包含满足所有空头信号条件的指标与K线数据。"""
    dates = pd.date_range("2025-03-03 09:30", periods=12, freq="3T")
    # 空头MA：前五线并拢(<2)后下穿20日线
    ma_df = pd.DataFrame({
        5:  [102.0, 99.0],
        6:  [101.8, 99.3],
        7:  [101.5, 99.1],
        8:  [101.9, 99.5],
        9:  [102.1, 99.8],
        11: [101.0, 98.5],
        20: [100.5, 100.0],
    }, index=dates[-2:])

    boll_df = pd.DataFrame({
        "upper": [115.0, 114.0],
        "middle": [100.0, 99.0],
        "lower": [85.0, 84.0],
    }, index=dates[-2:])

    # VOL白线升+绿柱倍量
    vol_df = pd.DataFrame({
        "volume":   [600, 1400],
        "vol_ma":   [450, 500],
        "close":    [100.0, 98.0],
        "open":     [101.0, 100.0],
    }, index=dates[-2:])

    # MACD近零轴绿柱加长
    macd_df = pd.DataFrame({
        "DIF":  [-0.30, -0.35],
        "DEA":  [-0.20, -0.22],
        "MACD": [-0.10, -0.13],  # 绿柱加长（负值更小）
    }, index=dates[-2:])

    # CCI二次下穿0轴
    cci_series = pd.Series(
        [80, 50, -20, 30, -40, 20, -15, 10, -25, -5, -30, -50],
        index=dates
    )

    # 1分钟K线下穿20日线
    kline_1min = pd.DataFrame({
        "open":  [101.0, 100.0],
        "high":  [102.0, 101.0],
        "low":   [98.0, 97.0],
        "close": [99.0, 98.0],
        "volume":[300, 350],
    }, index=dates[-2:])

    kline_3min = pd.DataFrame({
        "open":  [101.0, 100.0],
        "high":  [103.0, 102.0],
        "low":   [98.0, 97.0],
        "close": [99.0, 98.0],
        "volume":[600, 1400],
    }, index=dates[-2:])

    # 上证深证均在20日线下
    index_data = pd.DataFrame({
        "sh_close":  [2900, 2850],
        "sh_ma20":   [2950, 2960],
        "sz_close":  [9800, 9750],
        "sz_ma20":   [9900, 9950],
    }, index=dates[-2:])

    return {
        "ma": ma_df,
        "boll": boll_df,
        "vol": vol_df,
        "macd": macd_df,
        "cci": cci_series,
        "kline_1min": kline_1min,
        "kline_3min": kline_3min,
        "index": index_data,
    }


# ---------------------------------------------------------------------------
# 全条件满足 – 应返回信号字符串
# ---------------------------------------------------------------------------

def test_long_signal_all_conditions_met(base_long_data):
    result = check_long_signal(base_long_data)
    assert result == "LONG", f"Expected 'LONG' but got {result!r}"


def test_short_signal_all_conditions_met(base_short_data):
    result = check_short_signal(base_short_data)
    assert result == "SHORT", f"Expected 'SHORT' but got {result!r}"


# ---------------------------------------------------------------------------
# 逐个缺失条件 – 应返回 None （为每个 condition id 至少一条断言）
# ---------------------------------------------------------------------------

# --- 多头条件 ---

def test_long_missing_ma_convergence(base_long_data):
    data = base_long_data.copy()
    ma = data["ma"].copy()
    ma.at[ma.index[-1], 5] = 95.0  # 破坏前五线并拢（差值大于2）
    data["ma"] = ma
    assert check_long_signal(data) is None


def test_long_missing_vol_white_red_double(base_long_data):
    data = base_long_data.copy()
    vol = data["vol"].copy()
    vol.at[vol.index[-1], "volume"] = 500  # 无倍量
    data["vol"] = vol
    assert check_long_signal(data) is None


def test_long_missing_macd_near_zero_red_growing(base_long_data):
    data = base_long_data.copy()
    macd = data["macd"].copy()
    macd.at[macd.index[-1], "MACD"] = 0.05  # 红柱未加长
    data["macd"] = macd
    assert check_long_signal(data) is None


def test_long_missing_cci_cross_up_twice(base_long_data):
    data = base_long_data.copy()
    # 修改CCI序列，使其仅有零或一次上穿
    data["cci"] = pd.Series([-50, -30, -10, -20, -40, -60, -80, -70, -90, -100, -50, -30],
                            index=data["cci"].index)
    assert check_long_signal(data) is None


def test_long_missing_one_min_up_cross_20(base_long_data):
    data = base_long_data.copy()
    k1 = data["kline_1min"].copy()
    k1.at[k1.index[-1], "close"] = 99.0  # 未上穿20日线(设定MA20值较高)
    data["kline_1min"] = k1
    # 同时需要反映在MA中，此处简化假设函数基于独立均线判断
    assert check_long_signal(data) is None


def test_long_missing_sh_sz_above_20(base_long_data):
    data = base_long_data.copy()
    idx = data["index"].copy()
    idx.at[idx.index[-1], "sh_close"] = 2900  # 低于MA20
    data["index"] = idx
    assert check_long_signal(data) is None


# --- 空头条件 ---

def test_short_missing_ma_convergence_down(base_short_data):
    data = base_short_data.copy()
    ma = data["ma"].copy()
    ma.at[ma.index[-1], 5] = 105.0  # 破坏并拢
    data["ma"] = ma
    assert check_short_signal(data) is None


def test_short_missing_vol_white_green_double(base_short_data):
    data = base_short_data.copy()
    vol = data["vol"].copy()
    vol.at[vol.index[-1], "volume"] = 600  # 无倍量
    data["vol"] = vol
    assert check_short_signal(data) is None


def test_short_missing_macd_near_zero_green_growing(base_short_data):
    data = base_short_data.copy()
    macd = data["macd"].copy()
    macd.at[macd.index[-1], "MACD"] = -0.05  # 绿柱未加长（绝对值减小）
    data["macd"] = macd
    assert check_short_signal(data) is None


def test_short_missing_cci_cross_down_twice(base_short_data):
    data = base_short_data.copy()
    data["cci"] = pd.Series([50, 30, 10, 20, 40, 60, 80, 70, 90, 100, 50, 30],
                            index=data["cci"].index)
    assert check_short_signal(data) is None


def test_short_missing_one_min_down_cross_20(base_short_data):
    data = base_short_data.copy()
    k1 = data["kline_1min"].copy()
    k1.at[k1.index[-1], "close"] = 101.0  # 未下穿
    data["kline_1min"] = k1
    assert check_short_signal(data) is None


def test_short_missing_sh_sz_below_20(base_short_data):
    data = base_short_data.copy()
    idx = data["index"].copy()
    idx.at[idx.index[-1], "sh_close"] = 3000  # 高于MA20
    data["index"] = idx
    assert check_short_signal(data) is None


# ---------------------------------------------------------------------------
# 布林带横盘 – 应返回 None
# ---------------------------------------------------------------------------

def test_long_signal_bollinger_sideways_returns_none(base_long_data):
    data = base_long_data.copy()
    boll = data["boll"].copy()
    # 使上下轨极度收窄，模拟横盘
    boll["upper"] = 101.0
    boll["lower"] = 99.0
    data["boll"] = boll
    assert check_long_signal(data) is None


def test_short_signal_bollinger_sideways_returns_none(base_short_data):
    data = base_short_data.copy()
    boll = data["boll"].copy()
    boll["upper"] = 101.0
    boll["lower"] = 99.0
    data["boll"] = boll
    assert check_short_signal(data) is None


# ---------------------------------------------------------------------------
# 数据不足 – 应返回 None
# ---------------------------------------------------------------------------

def test_long_signal_insufficient_data_returns_none():
    empty_data = {
        "ma": pd.DataFrame(),
        "boll": pd.DataFrame(),
        "vol": pd.DataFrame(),
        "macd": pd.DataFrame(),
        "cci": pd.Series(dtype=float),
        "kline_1min": pd.DataFrame(),
        "kline_3min": pd.DataFrame(),
        "index": pd.DataFrame(),
    }
    assert check_long_signal(empty_data) is None


def test_short_signal_insufficient_data_returns_none():
    empty_data = {
        "ma": pd.DataFrame(),
        "boll": pd.DataFrame(),
        "vol": pd.DataFrame(),
        "macd": pd.DataFrame(),
        "cci": pd.Series(dtype=float),
        "kline_1min": pd.DataFrame(),
        "kline_3min": pd.DataFrame(),
        "index": pd.DataFrame(),
    }
    assert check_short_signal(empty_data) is None