from .models import StockLevel
from .pricing import compute_restock_cost

REORDER_FLOOR = 20


def restock_budget(levels: "list[StockLevel]") -> int:
    """Total cents to bring every low stock level back to the floor."""
    total = 0
    for level in levels:
        shortfall = REORDER_FLOOR - level.available
        total += compute_restock_cost(level.item, shortfall)
    return total
