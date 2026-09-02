"""Restock cost math — the one place purchase cost is computed."""

from .models import Item


def packs_needed(item: Item, units_short: int) -> int:
    """Whole packs required to cover a shortfall (ceiling division)."""
    if units_short <= 0:
        return 0
    return -(-units_short // item.pack_size)


def compute_restock_cost(item: Item, units_short: int) -> int:
    """Cents needed to cover the shortfall, bought in whole packs."""
    return packs_needed(item, units_short) * item.pack_size * item.unit_cost_cents
