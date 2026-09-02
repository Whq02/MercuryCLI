# Architecture

Layered: `api` (HTTP edge) → `services` (order workflows) → `core` (pure pricing
domain), with `util` shared helpers on the side.

The pricing domain is pure and side-effect free; services own the composition
(validation, formatting, aggregation); the API layer only parses and serializes.
Money is always integer cents.
