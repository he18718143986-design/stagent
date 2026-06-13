import pytest
from unittest.mock import patch, MagicMock
import yaml
import pandas as pd
from main import run, load_config


def test_load_config(tmp_path, monkeypatch):
    """load_config should parse config.yaml and return a dictionary matching the file contents."""
    config_content = """\
# 全局配置
bootstrap:
  data_source: mock_csv
  initial_cash: 1000000
  commission: 0.0001

indicators:
  ma_periods: [5,6,7,8,9,11,20]
  boll_period: 20
  boll_std: 2
  vol_ma: 3
  vol_threshold: 100
  macd_fast: 14
  macd_slow: 53
  macd_signal: 60
  cci_period: 89

signals:
  convergence_max_pt: 2.0
  min_window_minutes: 3
  index_refs: ["000001.SH","399001.SZ"]

risk:
  stop_loss_pts: 15.0
  hedge_separation: true

broker:
  simulated: true
  account_id: "sim001"
"""
    config_file = tmp_path / "config.yaml"
    config_file.write_text(config_content)
    monkeypatch.chdir(tmp_path)

    result = load_config()
    expected = yaml.safe_load(config_content)

    assert result == expected


@patch("time.sleep")
@patch("risk.should_stop_loss")
@patch("risk.calculate_stop_loss")
@patch("risk.classify_order")
@patch("signals.check_short_signal")
@patch("signals.check_long_signal")
@patch("indicators.compute_volume")
@patch("indicators.compute_macd")
@patch("indicators.compute_cci")
@patch("indicators.compute_boll")
@patch("indicators.compute_ma")
@patch("broker.SimBroker")
@patch("main.load_config")
def test_run(
    mock_load_config,
    mock_sim_broker,
    mock_compute_ma,
    mock_compute_boll,
    mock_compute_cci,
    mock_compute_macd,
    mock_compute_volume,
    mock_check_long,
    mock_check_short,
    mock_classify,
    mock_calc_stop,
    mock_should_stop,
    mock_sleep,
):
    """run should orchestrate the pipeline: load config, instantiate broker, call indicators,
    signals, risk, and execute orders via the broker."""
    # Supply a minimal valid configuration so that run can proceed.
    mock_load_config.return_value = {
        "bootstrap": {"data_source": "mock_csv", "initial_cash": 1000000, "commission": 0.0001},
        "indicators": {"ma_periods": [5,6,7,8,9,11,20], "boll_period": 20, "boll_std": 2,
                       "vol_ma": 3, "vol_threshold": 100, "macd_fast": 14, "macd_slow": 53,
                       "macd_signal": 60, "cci_period": 89},
        "signals": {"convergence_max_pt": 2.0, "min_window_minutes": 3,
                    "index_refs": ["000001.SH", "399001.SZ"]},
        "risk": {"stop_loss_pts": 15.0, "hedge_separation": True},
        "broker": {"simulated": True, "account_id": "sim001"},
    }

    # Simulated broker instance.
    broker_instance = mock_sim_broker.return_value
    broker_instance.get_history.return_value = pd.DataFrame({
        "close": [100.0] * 30,
        "high": [101.0] * 30,
        "low": [99.0] * 30,
        "open": [100.0] * 30,
        "volume": [1000] * 30,
    })
    broker_instance.get_quote.return_value = MagicMock()
    broker_instance.get_account.return_value = MagicMock()
    broker_instance.get_positions.return_value = []
    broker_instance.place_order.return_value = "order-1"

    # Indicator mocks return simple valid structures.
    mock_compute_ma.return_value = pd.Series([100.0] * 10)
    mock_compute_boll.return_value = pd.DataFrame({"upper": [101.0]*10, "middle": [100.0]*10, "lower": [99.0]*10})
    mock_compute_cci.return_value = pd.Series([50.0] * 10)
    mock_compute_macd.return_value = pd.DataFrame({"macd": [0.0]*10, "signal": [0.0]*10, "hist": [0.0]*10})
    mock_compute_volume.return_value = pd.Series([1000.0] * 10)

    mock_check_long.return_value = None
    mock_check_short.return_value = "SHORT"

    mock_calc_stop.return_value = 98.5
    mock_classify.return_value = "today_order"
    mock_should_stop.return_value = True

    # Force the main loop to exit after one iteration.
    mock_sleep.side_effect = SystemExit(0)

    with pytest.raises(SystemExit):
        run()

    # Verify configuration was loaded.
    mock_load_config.assert_called_once()

    # Broker must be instantiated (SimBroker) and history fetched.
    mock_sim_broker.assert_called_once()
    broker_instance.get_history.assert_called()

    # All indicator computers should have been invoked.
    mock_compute_ma.assert_called()
    mock_compute_boll.assert_called()
    mock_compute_cci.assert_called()
    mock_compute_macd.assert_called()
    mock_compute_volume.assert_called()

    # Signal functions must be called.
    mock_check_long.assert_called()
    mock_check_short.assert_called()

    # Risk functions must be called.
    mock_calc_stop.assert_called()
    mock_classify.assert_called()
    mock_should_stop.assert_called()

    # The broker should have attempted to place an order.
    broker_instance.place_order.assert_called()