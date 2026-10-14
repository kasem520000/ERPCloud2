import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { tenants, users } from './platform.js';

/**
 * لوحات المؤشرات شخصية: كل صف لمستخدم واحد داخل مستأجره.
 * `widget_key` مفتاح من الكتالوج الثابت، وليس جملة SQL.
 */
export const dashboards = pgTable(
  'dashboards',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ownerIdx: index('dashboards_owner_idx').on(table.tenantId, table.ownerUserId),
    oneDefault: uniqueIndex('dashboards_one_default_per_user')
      .on(table.tenantId, table.ownerUserId)
      .where(sql`is_default`),
  }),
);

export const dashboardWidgets = pgTable(
  'dashboard_widgets',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    dashboardId: uuid('dashboard_id')
      .notNull()
      .references(() => dashboards.id, { onDelete: 'cascade' }),
    widgetKey: text('widget_key').notNull(),
    titleAr: text('title_ar').notNull(),
    kind: text('kind').notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    positionX: integer('position_x').notNull().default(0),
    positionY: integer('position_y').notNull().default(0),
    width: integer('width').notNull().default(4),
    height: integer('height').notNull().default(3),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    boardIdx: index('dashboard_widgets_board_idx').on(table.tenantId, table.dashboardId),
  }),
);
