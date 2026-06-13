import yaml
import time
import indicators
import signals
import risk
import broker


def load_config():
    with open("config.yaml") as f:
        return yaml.safe_load(f)


def run():
    config = load_config()
    sim = broker.SimBroker(config.get("broker"))
    data = sim.get_history("symbol", "period")

    ind = config["indicators"]
    compute_ma = indicators.compute_ma
    compute_boll = indicators.compute_boll
    compute_cci = indicators.compute_cci
    compute_macd = indicators.compute_macd
    compute_volume = indicators.compute_volume

    ma = compute_ma(data, ind["ma_periods"])
    boll = compute_boll(data, ind["boll_period"], ind["boll_std"])
    cci = compute_cci(data, ind["cci_period"])
    macd = compute_macd(data, ind["macd_fast"], ind["macd_slow"], ind["macd_signal"])
    volume = compute_volume(data, ind["vol_ma"], ind["vol_threshold"])

    signal_data = {"ma": ma, "boll": boll, "cci": cci, "macd": macd, "volume": volume}
    long_signal = signals.check_long_signal(signal_data)
    short_signal = signals.check_short_signal(signal_data)
    signal = long_signal or short_signal

    if signal:
        quote = sim.get_quote("symbol")
        price = quote.last
        direction = signal.lower()

        stop_loss = risk.calculate_stop_loss(direction, price)
        order_class = risk.classify_order(None)
        positions = sim.get_positions()
        pos = positions[0] if positions else None
        should_stop = risk.should_stop_loss(pos, price, order_class)

        sim.place_order(symbol="symbol", side=direction, qty=1, type="market")

    time.sleep(1)