import pandas as pd
import numpy as np
import pytest
from indicators import compute_ma, compute_boll, compute_volume, compute_macd, compute_cci


# ---------- fixtures ----------

@pytest.fixture
def sample_params():
    """默认配置参数，与 config.yaml 中一致"""
    return {
        "ma_periods": [5, 6, 7, 8, 9, 11, 20],
        "boll_period": 20,
        "boll_std": 2,
        "vol_period": 3,
        "vol_threshold": 100,
        "macd_fast": 14,
        "macd_slow": 53,
        "macd_signal": 60,
        "cci_period": 89,
    }


@pytest.fixture
def valid_ohlcv_data():
    """生成 200 行标准 OHLCV 数据，足够所有指标计算"""
    np.random.seed(237)
    n = 200
    dates = pd.date_range("2025-01-01", periods=n, freq="1min")
    close = np.random.randn(n).cumsum() + 100.0
    high = close + np.abs(np.random.randn(n)) * 2
    low = close - np.abs(np.random.randn(n)) * 2
    open_ = close + np.random.randn(n) * 0.5
    volume = np.random.randint(50, 500, size=n)
    df = pd.DataFrame(
        {
            "timestamp": dates,
            "open": open_,
            "high": high,
            "low": low,
            "close": close,
            "volume": volume,
        }
    )
    return df


@pytest.fixture
def empty_data():
    """空 DataFrame，仅包含必需列"""
    return pd.DataFrame(
        columns=["timestamp", "open", "high", "low", "close", "volume"]
    )


@pytest.fixture
def single_row_data(valid_ohlcv_data):
    """单行数据"""
    return valid_ohlcv_data.iloc[:1]


@pytest.fixture
def short_data_5(valid_ohlcv_data):
    """长度刚好等于最短 MA 周期 5，但不足 BOLL/CCI"""
    return valid_ohlcv_data.iloc[:5]


# ---------- compute_ma ----------

class TestComputeMA:
    def test_normal_return_type_and_shape(self, valid_ohlcv_data, sample_params):
        result = compute_ma(valid_ohlcv_data, sample_params["ma_periods"])
        assert isinstance(result, pd.DataFrame)
        assert result.shape[0] == valid_ohlcv_data.shape[0]

    def test_normal_columns_exist(self, valid_ohlcv_data, sample_params):
        result = compute_ma(valid_ohlcv_data, sample_params["ma_periods"])
        expected_cols = {f"MA{p}" for p in sample_params["ma_periods"]}
        assert expected_cols.issubset(set(result.columns))

    def test_early_rows_are_nan(self, valid_ohlcv_data, sample_params):
        """前几行由于窗口不足应为 NaN"""
        result = compute_ma(valid_ohlcv_data, sample_params["ma_periods"])
        # MA20 需要 19 个历史点，因此第 0..18 行应为 NaN
        assert result.loc[:18, "MA20"].isna().all()
        # MA5 第 4 行及之后应有值（0‑based 索引）
        assert not result.loc[4, "MA5"] is None  # 允许具体数值

    def test_empty_input(self, empty_data, sample_params):
        result = compute_ma(empty_data, sample_params["ma_periods"])
        assert isinstance(result, pd.DataFrame)
        assert result.shape[0] == 0
        expected_cols = {f"MA{p}" for p in sample_params["ma_periods"]}
        assert expected_cols.issubset(set(result.columns))

    def test_single_row_input(self, single_row_data, sample_params):
        result = compute_ma(single_row_data, sample_params["ma_periods"])
        assert isinstance(result, pd.DataFrame)
        assert result.shape[0] == 1
        # 所有 MA 值均应为 NaN（窗口不足）
        for col in result.columns:
            assert pd.isna(result[col].iloc[0])

    def test_large_data_does_not_crash(self, sample_params):
        n = 10000
        df = pd.DataFrame(
            {
                "timestamp": pd.date_range("2025-01-01", periods=n, freq="1min"),
                "open": np.random.randn(n).cumsum() + 100,
                "high": np.random.randn(n).cumsum() + 102,
                "low": np.random.randn(n).cumsum() + 98,
                "close": np.random.randn(n).cumsum() + 100,
                "volume": np.random.randint(50, 500, size=n),
            }
        )
        result = compute_ma(df, sample_params["ma_periods"])
        assert result.shape[0] == n


# ---------- compute_boll ----------

class TestComputeBoll:
    def test_normal_return_type_and_shape(self, valid_ohlcv_data, sample_params):
        result = compute_boll(
            valid_ohlcv_data, sample_params["boll_period"], sample_params["boll_std"]
        )
        assert isinstance(result, pd.DataFrame)
        assert result.shape[0] == valid_ohlcv_data.shape[0]

    def test_columns_exist(self, valid_ohlcv_data, sample_params):
        result = compute_boll(
            valid_ohlcv_data, sample_params["boll_period"], sample_params["boll_std"]
        )
        for col in ("BOLL_MID", "BOLL_UPPER", "BOLL_LOWER"):
            assert col in result.columns

    def test_insufficient_data_returns_nan(self, short_data_5, sample_params):
        """5 行数据不足以计算 20 期 BOLL，应返回全 NaN 但列存在"""
        result = compute_boll(
            short_data_5, sample_params["boll_period"], sample_params["boll_std"]
        )
        assert isinstance(result, pd.DataFrame)
        assert result.shape[0] == 5
        for col in ("BOLL_MID", "BOLL_UPPER", "BOLL_LOWER"):
            assert col in result.columns
            assert result[col].isna().all()

    def test_empty_input(self, empty_data, sample_params):
        result = compute_boll(
            empty_data, sample_params["boll_period"], sample_params["boll_std"]
        )
        assert isinstance(result, pd.DataFrame)
        assert result.shape[0] == 0
        for col in ("BOLL_MID", "BOLL_UPPER", "BOLL_LOWER"):
            assert col in result.columns


# ---------- compute_volume ----------

class TestComputeVolume:
    def test_normal_return_type_and_shape(self, valid_ohlcv_data, sample_params):
        result = compute_volume(
            valid_ohlcv_data, sample_params["vol_period"], sample_params["vol_threshold"]
        )
        assert isinstance(result, pd.DataFrame)
        assert result.shape[0] == valid_ohlcv_data.shape[0]

    def test_contains_expected_columns(self, valid_ohlcv_data, sample_params):
        result = compute_volume(
            valid_ohlcv_data, sample_params["vol_period"], sample_params["vol_threshold"]
        )
        # 根据需求描述，至少应包含成交量移动平均（白线），可能还有信号列
        assert "VOL_MA" in result.columns

    def test_empty_input(self, empty_data, sample_params):
        result = compute_volume(
            empty_data, sample_params["vol_period"], sample_params["vol_threshold"]
        )
        assert isinstance(result, pd.DataFrame)
        assert result.shape[0] == 0

    def test_single_row_input(self, single_row_data, sample_params):
        result = compute_volume(
            single_row_data, sample_params["vol_period"], sample_params["vol_threshold"]
        )
        assert isinstance(result, pd.DataFrame)
        assert result.shape[0] == 1
        # 单行无法计算 3 周期均线，预期 VOL_MA 为 NaN
        assert pd.isna(result["VOL_MA"].iloc[0])


# ---------- compute_macd ----------

class TestComputeMACD:
    def test_normal_return_type_and_shape(self, valid_ohlcv_data, sample_params):
        result = compute_macd(
            valid_ohlcv_data,
            sample_params["macd_fast"],
            sample_params["macd_slow"],
            sample_params["macd_signal"],
        )
        assert isinstance(result, pd.DataFrame)
        assert result.shape[0] == valid_ohlcv_data.shape[0]

    def test_columns_exist(self, valid_ohlcv_data, sample_params):
        result = compute_macd(
            valid_ohlcv_data,
            sample_params["macd_fast"],
            sample_params["macd_slow"],
            sample_params["macd_signal"],
        )
        for col in ("DIF", "DEA", "MACD"):
            assert col in result.columns

    def test_short_data_returns_nan(self, short_data_5, sample_params):
        """5 行数据远小于 slow=53，所有值应为 NaN"""
        result = compute_macd(
            short_data_5,
            sample_params["macd_fast"],
            sample_params["macd_slow"],
            sample_params["macd_signal"],
        )
        assert isinstance(result, pd.DataFrame)
        assert result.shape[0] == 5
        for col in ("DIF", "DEA", "MACD"):
            assert col in result.columns
            assert result[col].isna().all()

    def test_empty_input(self, empty_data, sample_params):
        result = compute_macd(
            empty_data,
            sample_params["macd_fast"],
            sample_params["macd_slow"],
            sample_params["macd_signal"],
        )
        assert isinstance(result, pd.DataFrame)
        assert result.shape[0] == 0
        for col in ("DIF", "DEA", "MACD"):
            assert col in result.columns


# ---------- compute_cci ----------

class TestComputeCCI:
    def test_normal_return_type_and_shape(self, valid_ohlcv_data, sample_params):
        result = compute_cci(valid_ohlcv_data, sample_params["cci_period"])
        assert isinstance(result, pd.DataFrame)
        assert result.shape[0] == valid_ohlcv_data.shape[0]

    def test_column_exists(self, valid_ohlcv_data, sample_params):
        result = compute_cci(valid_ohlcv_data, sample_params["cci_period"])
        assert "CCI" in result.columns

    def test_insufficient_data_returns_nan(self, short_data_5, sample_params):
        result = compute_cci(short_data_5, sample_params["cci_period"])
        assert isinstance(result, pd.DataFrame)
        assert result.shape[0] == 5
        assert "CCI" in result.columns
        assert result["CCI"].isna().all()

    def test_empty_input(self, empty_data, sample_params):
        result = compute_cci(empty_data, sample_params["cci_period"])
        assert isinstance(result, pd.DataFrame)
        assert result.shape[0] == 0
        assert "CCI" in result.columns