# Personal BI dashboards

Future enhancement 12. Each user has their own boards inside their tenant. Boards are not shared across tenants, and the screen never sends SQL.

Migration `0108_bi_dashboards.sql`. Schema `packages/database/src/schema/bi-dashboards.ts`. Both tables use `ENABLE` and `FORCE` row-level security. A partial unique index keeps one default board per user.

| Table | Role |
| --- | --- |
| `dashboards` | Name, owner, and the default flag |
| `dashboard_widgets` | Catalog key, Arabic title, kind, and a 12-column cell |

The catalog has 20 widgets (sales, receivables, cash, attendance, low stock, near expiry, and the rest). `widget_key` is chosen from that list. `config` may only carry `period` or `limit`.

## Routes

`dashboards.view` reads. `dashboards.manage` creates, arranges, and deletes.

- `GET /dashboards` creates «لوحتي» with three starter widgets when the user has none.
- `GET /dashboards/widgets/catalog`
- `POST /dashboards/:id/widgets`
- `PUT /dashboards/:id/layout` persists a drag. Overlap is rejected.
- `GET /dashboards/:id/data` returns tenant-scoped figures and, for comparable KPIs, the previous period.
- `GET /dashboards/:id/pdf` downloads the figures. The embedded font cannot draw Arabic, so the file titles are English.

Figures are cached for five minutes at `dashboard:widget:{id}:data`. If Redis is missing or down, the same key and TTL stay in process memory and the board still answers.

## Screens

`/dashboards` lists boards. `/dashboards/[id]` is the builder. `/` shows the caller's default board above the existing home summary.

Rules and the eight acceptance cases live in `bi-dashboard.ts` and `bi-dashboard.spec.ts`. Widget SQL is fixed in `widget-queries.ts` and is never built from request text.
