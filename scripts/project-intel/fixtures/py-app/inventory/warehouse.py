from .models import StockLevel
from .pricing import compute_restock_cost

REORDER_FLOOR = 20


def restock_budget(levels: "list[StockLevel]") -> int:
    total = 0
    for level in levels:
        shortfall = REORDER_FLOOR - level.available
        total += compute_restock_cost(level.item, shortfall)
    return total
