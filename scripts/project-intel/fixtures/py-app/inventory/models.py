from dataclasses import dataclass


@dataclass(frozen=True)
class Item:
    sku: str
    name: str
    unit_cost_cents: int
    pack_size: int


@dataclass
class StockLevel:
    item: Item
    on_hand: int
    reserved: int

    @property
    def available(self) -> int:
        return self.on_hand - self.reserved
