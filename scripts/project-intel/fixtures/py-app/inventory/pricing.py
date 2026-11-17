from .models import Item


def packs_needed(item: Item, units_short: int) -> int:
    if units_short <= 0:
        return 0
    return -(-units_short // item.pack_size)


def compute_restock_cost(item: Item, units_short: int) -> int:
    return packs_needed(item, units_short) * item.pack_size * item.unit_cost_cents
