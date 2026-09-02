# meridian-orders

Order pricing and invoicing service for the Meridian storefront.

- HTTP API: checkout and invoice endpoints (`src/api/`)
- Business logic: the pricing engine and discount rules (`src/core/`)
- Order-facing services: checkout, invoicing, revenue reporting (`src/services/`)
- Shared helpers: money formatting, order validation (`src/util/`)
- `npm test` runs the node:test suite in `tests/`
