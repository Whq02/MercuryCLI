import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from inventory.models import Item
from inventory.pricing import compute_restock_cost, packs_needed


class TestPricing(unittest.TestCase):
    def setUp(self) -> None:
        self.bolt = Item(sku="BOLT-8", name="8mm bolt", unit_cost_cents=12, pack_size=50)

    def test_no_shortfall_costs_nothing(self) -> None:
        self.assertEqual(compute_restock_cost(self.bolt, 0), 0)

    def test_partial_pack_rounds_up(self) -> None:
        self.assertEqual(packs_needed(self.bolt, 51), 2)
        self.assertEqual(compute_restock_cost(self.bolt, 51), 2 * 50 * 12)

    def test_exact_packs(self) -> None:
        self.assertEqual(compute_restock_cost(self.bolt, 100), 2 * 50 * 12)


if __name__ == "__main__":
    unittest.main()
