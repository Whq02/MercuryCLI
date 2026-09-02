from .models import Item
from .pricing import compute_restock_cost, packs_needed


def purchase_order_line(item: Item, units_short: int) -> str:
    """One purchase-order line: packs to buy and what they cost."""
    packs = packs_needed(item, units_short)
    cost = compute_restock_cost(item, units_short)
    return f"{item.sku}: {packs} packs ({cost} cents)"
