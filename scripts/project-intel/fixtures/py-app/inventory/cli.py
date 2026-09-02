import sys

from .models import Item
from .orders import purchase_order_line


def main(argv: "list[str]") -> int:
    if len(argv) != 4:
        print("usage: cli.py SKU PACK_SIZE UNITS_SHORT", file=sys.stderr)
        return 2
    item = Item(sku=argv[1], name=argv[1], unit_cost_cents=100, pack_size=int(argv[2]))
    print(purchase_order_line(item, int(argv[3])))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
