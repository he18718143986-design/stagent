import datetime
import sys

# Make datetime.date.today writable for test monkeypatching
class _PatchedDate(datetime.date):
    pass
sys.modules['datetime'].date = _PatchedDate
datetime.date = _PatchedDate

def calculate_stop_loss(direction: str, cost_price: float) -> float:
    if direction == "long":
        stop = cost_price - 15.0
        return max(0.0, stop)
    elif direction == "short":
        return cost_price + 15.0
    else:
        raise ValueError(f"Unknown direction: {direction}")

def classify_order(order) -> str:
    today = datetime.date.today()
    open_date = order.open_date
    if isinstance(open_date, datetime.datetime):
        open_date = open_date.date()
    diff = (today - open_date).days
    if diff == 0:
        return "today_order"
    else:
        return "yesterday_hedge"

def should_stop_loss(position, current_price: float, order_type: str) -> bool:
    stop_price = calculate_stop_loss(position.direction, position.cost_price)
    if position.direction == "long":
        return current_price <= stop_price
    else:
        return current_price >= stop_price