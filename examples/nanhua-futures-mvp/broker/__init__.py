"""
broker/__init__.py

Exports: BrokerAdapter (abstract base), SimBroker (simulated implementation).

Implements the broker decision record for stage_impl_broker.
"""

import abc
import datetime
import uuid
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd


# ── internal data classes (not exported) ──────────────────────────────────────

class _Quote:
    __slots__ = ('bid', 'ask', 'last')
    def __init__(self, bid: float, ask: float, last: float):
        self.bid = bid
        self.ask = ask
        self.last = last

class _Account:
    __slots__ = ('balance', 'equity', 'margin_used')
    def __init__(self, balance: float, equity: float, margin_used: float):
        self.balance = balance
        self.equity = equity
        self.margin_used = margin_used

class _Position:
    __slots__ = ('symbol', 'side', 'qty')
    def __init__(self, symbol: str, side: str, qty: int):
        self.symbol = symbol
        self.side = side
        self.qty = qty

class _Order:
    __slots__ = ('order_id', 'symbol', 'side', 'qty', 'type', 'status')
    def __init__(self, order_id: str, symbol: str, side: str, qty: int, order_type: str, status: str = 'pending'):
        self.order_id = order_id
        self.symbol = symbol
        self.side = side
        self.qty = qty
        self.type = order_type
        self.status = status

class _InsufficientFundsError(Exception):
    """Raised when account has insufficient cash for a trade."""
    pass

class _InvalidSymbolError(Exception):
    """Raised when an unknown symbol is used."""
    pass


# ── Abstract Base Class ──────────────────────────────────────────────────────

class BrokerAdapter(abc.ABC):
    """Abstract broker adapter defining the mandatory interface."""

    @abc.abstractmethod
    def place_order(self, symbol: str, side: str, qty: int, type: str) -> str:
        ...

    @abc.abstractmethod
    def cancel_order(self, order_id: str) -> bool:
        ...

    @abc.abstractmethod
    def get_positions(self) -> List[_Position]:
        ...

    @abc.abstractmethod
    def get_quote(self, symbol: str) -> _Quote:
        ...

    @abc.abstractmethod
    def get_account(self) -> _Account:
        ...

    @abc.abstractmethod
    def get_history(self, symbol: str, period: str) -> pd.DataFrame:
        ...


# ── Simulated Implementation ─────────────────────────────────────────────────

class SimBroker(BrokerAdapter):
    """
    Simulated broker for offline testing.

    Maintains internal state: orders, positions, account cash.
    Market data is generated randomly (mock mode).
    """

    _VALID_SYMBOLS = {'rb888', 'MA888'}  # extend as needed
    _CONTRACT_MULTIPLIER = 1.0           # assume 1 unit per contract
    _MARGIN_RATE = 0.1                   # 10% margin
    _HISTORY_ROWS = 200                  # number of rows for get_history

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        if config is None:
            config = {}
        broker_cfg = config.get('broker', {})
        self._initial_cash = float(broker_cfg.get('initial_cash', 1_000_000.0))
        self._account_id = broker_cfg.get('account_id', 'sim001')

        # internal state
        self._cash = self._initial_cash
        self._orders: Dict[str, _Order] = {}          # order_id -> _Order
        self._positions: Dict[tuple, int] = {}         # (symbol, side) -> qty
        self._order_counter = 0

        # seed random for reproducibility (optional)
        np.random.seed(hash(self._account_id) % (2**31))

    # ── order management ────────────────────────────────────────────────────

    def place_order(self, symbol: str, side: str, qty: int, type: str) -> str:
        if symbol not in self._VALID_SYMBOLS:
            raise _InvalidSymbolError(f"Unknown symbol: {symbol}")

        # simulate cost for immediate fill (MARKET) or leave pending (LIMIT)
        required_margin = 0.0
        if type == 'MARKET':
            # use current mock price to compute margin
            quote = self._generate_quote()
            price = quote.last
            required_margin = qty * self._CONTRACT_MULTIPLIER * price * self._MARGIN_RATE
            if required_margin > self._cash:
                raise _InsufficientFundsError(
                    f"Insufficient funds: needed {required_margin:.2f}, available {self._cash:.2f}"
                )

        order_id = f"{self._account_id}_{self._order_counter:06d}"
        self._order_counter += 1

        if type == 'MARKET':
            # deduct cash, update positions, mark filled
            self._cash -= required_margin
            key = (symbol, side)
            self._positions[key] = self._positions.get(key, 0) + qty
            order_status = 'filled'
        else:
            # LIMIT order remains pending
            order_status = 'pending'

        order = _Order(order_id, symbol, side, qty, type, order_status)
        self._orders[order_id] = order
        return order_id

    def cancel_order(self, order_id: str) -> bool:
        order = self._orders.get(order_id)
        if order is None or order.status != 'pending':
            return False
        order.status = 'cancelled'
        return True

    # ── position query ──────────────────────────────────────────────────────

    def get_positions(self) -> List[_Position]:
        result = []
        for (symbol, side), qty in self._positions.items():
            if qty > 0:
                result.append(_Position(symbol, side, qty))
        return result

    # ── market data ──────────────────────────────────────────────────────────

    def get_quote(self, symbol: str) -> _Quote:
        return self._generate_quote()

    def get_history(self, symbol: str, period: str) -> pd.DataFrame:
        # generate random OHLCV data
        n = self._HISTORY_ROWS
        dates = pd.date_range(
            start=datetime.datetime.now() - datetime.timedelta(days=n),
            periods=n,
            freq='5min'
        )
        base = np.random.uniform(3000, 5000)
        changes = np.random.normal(0, 0.005, n).cumsum()
        close = base * (1 + changes)
        high = close * (1 + np.abs(np.random.normal(0, 0.003, n)))
        low = close * (1 - np.abs(np.random.normal(0, 0.003, n)))
        open_ = low + np.random.uniform(0, 1, n) * (high - low)
        volume = np.random.randint(1000, 10000, n).astype(float)

        df = pd.DataFrame({
            'timestamp': dates,
            'open': open_,
            'high': high,
            'low': low,
            'close': close,
            'volume': volume,
        })
        df.set_index('timestamp', inplace=True)
        return df

    # ── account info ─────────────────────────────────────────────────────────

    def get_account(self) -> _Account:
        # compute margin used from current positions
        margin_used = 0.0
        for (symbol, side), qty in self._positions.items():
            if qty == 0:
                continue
            # approximate last price from quote
            quote = self._generate_quote()
            margin_used += qty * self._CONTRACT_MULTIPLIER * quote.last * self._MARGIN_RATE

        equity = self._cash + margin_used  # simplified: no floating PnL
        return _Account(balance=self._cash, equity=equity, margin_used=margin_used)

    # ── internal helpers ────────────────────────────────────────────────────

    def _generate_quote(self) -> _Quote:
        last = np.random.uniform(3500, 5500)
        spread = np.random.uniform(0.5, 5.0)
        bid = last - spread
        ask = last + spread
        return _Quote(bid=bid, ask=ask, last=last)