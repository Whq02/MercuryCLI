# harborline-inventory

Restock planning for the Harborline depot.

- `inventory/` — the package: stock models, restock cost math, warehouse
  planning, purchase-order rendering, a small CLI
- `tests/` — the unittest suite (`python3 -m unittest discover -s tests`)

All money is integer cents; restocks are bought in whole packs.
