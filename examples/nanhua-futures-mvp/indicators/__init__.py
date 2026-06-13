import pandas as pd
import numpy as np

def compute_ma(data, periods):
    result = pd.DataFrame(index=data.index)
    for p in periods:
        result[f'MA{p}'] = data['close'].rolling(window=p, min_periods=p).mean()
    return result

def compute_boll(data, period, std):
    result = pd.DataFrame(index=data.index)
    mid = data['close'].rolling(window=period, min_periods=period).mean()
    std_dev = data['close'].rolling(window=period, min_periods=period).std(ddof=0)
    result['BOLL_MID'] = mid
    result['BOLL_UPPER'] = mid + std * std_dev
    result['BOLL_LOWER'] = mid - std * std_dev
    return result

def compute_volume(data, period, threshold):
    result = pd.DataFrame(index=data.index)
    result['VOL_MA'] = data['volume'].rolling(window=period, min_periods=period).mean()
    return result

def compute_macd(data, fast, slow, signal):
    result = pd.DataFrame(index=data.index)
    ema_fast = data['close'].ewm(span=fast, adjust=False, min_periods=fast).mean()
    ema_slow = data['close'].ewm(span=slow, adjust=False, min_periods=slow).mean()
    dif = ema_fast - ema_slow
    dea = dif.ewm(span=signal, adjust=False, min_periods=signal).mean()
    macd = 2 * (dif - dea)
    result['DIF'] = dif
    result['DEA'] = dea
    result['MACD'] = macd
    return result

def compute_cci(data, period):
    result = pd.DataFrame(index=data.index)
    tp = (data['high'] + data['low'] + data['close']) / 3.0
    sma = tp.rolling(window=period, min_periods=period).mean()
    mad = tp.rolling(window=period, min_periods=period).apply(
        lambda x: np.mean(np.abs(x - x.mean())), raw=True
    )
    result['CCI'] = (tp - sma) / (0.015 * mad)
    return result