import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from inventory.models import Item, StockLevel
from inventory.warehouse import restock_budget


class TestWarehouse(unittest.TestCase):
    def test_budget_covers_every_low_level(self) -> None:
        washer = Item(sku="WASH-6", name="6mm washer", unit_cost_cents=3, pack_size=100)
        strap = Item(sku="STRAP-2", name="cargo strap", unit_cost_cents=450, pack_size=4)
        levels = [
            StockLevel(item=washer, on_hand=5, reserved=0),   # 15 short -> 1 pack
            StockLevel(item=strap, on_hand=22, reserved=4),   # 2 short -> 1 pack
        ]
        self.assertEqual(restock_budget(levels), 100 * 3 + 4 * 450)

    def test_healthy_stock_costs_nothing(self) -> None:
        bolt = Item(sku="BOLT-8", name="8mm bolt", unit_cost_cents=12, pack_size=50)
        levels = [StockLevel(item=bolt, on_hand=40, reserved=5)]
        self.assertEqual(restock_budget(levels), 0)


if __name__ == "__main__":
    unittest.main()
