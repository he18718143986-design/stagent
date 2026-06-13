import pandas as pd
import numpy as np

__all__ = ["check_long_signal", "check_short_signal"]

def _has_at_least_n_rows(data_dict, key, n=2):
    df = data_dict.get(key)
    if df is None or (isinstance(df, pd.DataFrame) and df.shape[0] < n):
        return False
    if isinstance(df, pd.Series) and len(df) < n:
        return False
    return True

def check_long_signal(data: dict):
    # 数据足量检查
    if not _has_at_least_n_rows(data, 'ma', 2):
        return None
    if not _has_at_least_n_rows(data, 'boll', 2):
        return None
    if not _has_at_least_n_rows(data, 'vol', 2):
        return None
    if not _has_at_least_n_rows(data, 'macd', 2):
        return None
    cci = data.get('cci', pd.Series(dtype=float))
    if len(cci) < 10:
        return None
    if not _has_at_least_n_rows(data, 'kline_1min', 1):
        return None
    if not _has_at_least_n_rows(data, 'kline_3min', 2):
        return None
    if not _has_at_least_n_rows(data, 'index', 1):
        return None

    ma = data['ma']
    prev_ma = ma.iloc[-2]
    latest_ma = ma.iloc[-1]

    # 前五线（排除20日线）
    cols = [c for c in ma.columns if c != 20]
    # 条件1：前一行全部前五线 < MA20，最新行全部 >= MA20
    if not (all(prev_ma[col] < prev_ma[20] for col in cols) and
            all(latest_ma[col] >= latest_ma[20] for col in cols)):
        return None
    # 条件1续：前五线最大差值 < 2
    if max(latest_ma[cols]) - min(latest_ma[cols]) >= 2:
        return None

    # 条件2：布林带非横盘（带宽 > 2）
    boll = data['boll']
    latest_boll = boll.iloc[-1]
    if latest_boll['upper'] - latest_boll['lower'] <= 2:
        return None

    # 条件3：成交量白线升 + 红柱倍量
    vol = data['vol']
    prev_vol = vol.iloc[-2]
    latest_vol = vol.iloc[-1]
    if not (latest_vol['volume'] >= 2 * prev_vol['volume']):
        return None
    if latest_vol['close'] <= latest_vol['open']:   # 必须阳线
        return None
    if latest_vol['vol_ma'] <= prev_vol['vol_ma']:
        return None

    # 条件4：MACD 零轴上近零轴红柱加长
    macd = data['macd']
    prev_macd = macd.iloc[-2]
    latest_macd = macd.iloc[-1]
    if not (latest_macd['DIF'] > latest_macd['DEA'] > 0):
        return None
    if not (latest_macd['MACD'] > 0 and latest_macd['MACD'] > prev_macd['MACD']):
        return None

    # 条件5：CCI 半小时内两次上穿0轴
    cci_window = cci.iloc[-10:]  # 最后10根（半小时）
    cross_count = 0
    for i in range(1, len(cci_window)):
        if cci_window.iloc[i-1] < 0 and cci_window.iloc[i] >= 0:
            cross_count += 1
    if cross_count < 2:
        return None

    # 条件6：1分钟K线上穿20日线且为白点（阳线）
    k1 = data['kline_1min']
    latest_k1 = k1.iloc[-1]
    if not (latest_k1['close'] > latest_k1['open'] and
            latest_k1['close'] > latest_ma[20]):
        return None

    # 条件7：上证深证均在20日线上
    idx = data['index']
    latest_idx = idx.iloc[-1] if idx.shape[0] >= 1 else None
    if latest_idx is None:
        return None
    if not (latest_idx['sh_close'] > latest_idx['sh_ma20'] and
            latest_idx['sz_close'] > latest_idx['sz_ma20']):
        return None

    return "LONG"


def check_short_signal(data: dict):
    # 数据足量检查（与多头相同）
    if not _has_at_least_n_rows(data, 'ma', 2):
        return None
    if not _has_at_least_n_rows(data, 'boll', 2):
        return None
    if not _has_at_least_n_rows(data, 'vol', 2):
        return None
    if not _has_at_least_n_rows(data, 'macd', 2):
        return None
    cci = data.get('cci', pd.Series(dtype=float))
    if len(cci) < 10:
        return None
    if not _has_at_least_n_rows(data, 'kline_1min', 1):
        return None
    if not _has_at_least_n_rows(data, 'kline_3min', 2):
        return None
    if not _has_at_least_n_rows(data, 'index', 1):
        return None

    ma = data['ma']
    prev_ma = ma.iloc[-2]
    latest_ma = ma.iloc[-1]
    cols = [c for c in ma.columns if c != 20]

    # 条件1：前一行全部前五线 > MA20，最新行全部 <= MA20
    if not (all(prev_ma[col] > prev_ma[20] for col in cols) and
            all(latest_ma[col] <= latest_ma[20] for col in cols)):
        return None
    if max(latest_ma[cols]) - min(latest_ma[cols]) >= 2:
        return None

    # 条件2：布林带非横盘
    boll = data['boll']
    latest_boll = boll.iloc[-1]
    if latest_boll['upper'] - latest_boll['lower'] <= 2:
        return None

    # 条件3：成交量白线升 + 绿柱倍量
    vol = data['vol']
    prev_vol = vol.iloc[-2]
    latest_vol = vol.iloc[-1]
    if not (latest_vol['volume'] >= 2 * prev_vol['volume']):
        return None
    if latest_vol['close'] >= latest_vol['open']:   # 必须阴线
        return None
    if latest_vol['vol_ma'] <= prev_vol['vol_ma']:
        return None

    # 条件4：MACD 零轴下近零轴绿柱加长
    macd = data['macd']
    prev_macd = macd.iloc[-2]
    latest_macd = macd.iloc[-1]
    if not (latest_macd['DIF'] < latest_macd['DEA'] < 0):
        return None
    if not (latest_macd['MACD'] < 0 and latest_macd['MACD'] < prev_macd['MACD']):
        return None

    # 条件5：CCI 半小时内两次下穿0轴
    cci_window = cci.iloc[-10:]
    cross_count = 0
    for i in range(1, len(cci_window)):
        if cci_window.iloc[i-1] >= 0 and cci_window.iloc[i] < 0:
            cross_count += 1
    if cross_count < 2:
        return None

    # 条件6：1分钟K线下穿20日线且为绿柱（阴线）
    k1 = data['kline_1min']
    latest_k1 = k1.iloc[-1]
    if not (latest_k1['close'] < latest_k1['open'] and
            latest_k1['close'] < latest_ma[20]):
        return None

    # 条件7：上证深证均在20日线下
    idx = data['index']
    latest_idx = idx.iloc[-1] if idx.shape[0] >= 1 else None
    if latest_idx is None:
        return None
    if not (latest_idx['sh_close'] < latest_idx['sh_ma20'] and
            latest_idx['sz_close'] < latest_idx['sz_ma20']):
        return None

    return "SHORT"