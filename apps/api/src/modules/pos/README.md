# Restaurant POS Pack

Phase 19 is gated by tenant setting `pack.pos`. When explicitly false, `/pos/*` returns
404 to non-POS tenants. The event model stores immutable `order_events` for table opens,
item additions, kitchen firing, voids with reasons, merge/split, send-to-invoice, and
close. `send-to-invoice` composes a normal sales invoice through `SalesService`; posting,
stock, accounting, and payments stay owned by core modules.

Daily order numbers use the shared sequence service with doc type `pos_order:YYYY-MM-DD`
scoped per branch.
