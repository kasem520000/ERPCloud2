import { sql } from 'drizzle-orm';
import { date, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { branches } from './organization.js';
import { tenants, users } from './platform.js';
import { employees } from './hrm.js';
import { memberships } from './tenancy.js';

const geo = { precision: 9, scale: 6, mode: 'string' as const };

/** Branch circle the mobile punch is measured against. Default radius is 200m. */
export const employeeGeofences = pgTable(
  'employee_geofences',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').notNull().references(() => branches.id, { onDelete: 'cascade' }),
    lat: numeric('lat', geo).notNull(),
    lng: numeric('lng', geo).notNull(),
    radiusMeters: integer('radius_meters').notNull().default(200),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    branchKey: uniqueIndex('employee_geofences_branch_key').on(table.tenantId, table.branchId),
  }),
);

/** GPS punch. Distinct from fingerprint `attendance_logs`. */
export const employeeAttendance = pgTable(
  'employee_attendance',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'set null' }),
    type: text('type').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(),
    lat: numeric('lat', geo).notNull(),
    lng: numeric('lng', geo).notNull(),
    selfieFileId: uuid('selfie_file_id'),
    status: text('status').notNull(),
    distanceMeters: integer('distance_meters'),
    clientId: text('client_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    clientKey: uniqueIndex('employee_attendance_client_key')
      .on(table.tenantId, table.employeeId, table.clientId)
      .where(sql`client_id IS NOT NULL`),
    dayIdx: index('employee_attendance_day_idx').on(table.tenantId, table.employeeId, table.at),
  }),
);

export const employeeRequests = pgTable(
  'employee_requests',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    status: text('status').notNull().default('pending'),
    startsOn: date('starts_on'),
    endsOn: date('ends_on'),
    reason: text('reason').notNull().default(''),
    fileId: uuid('file_id'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    approverMembershipId: uuid('approver_membership_id').references(() => memberships.id, { onDelete: 'set null' }),
    decisionNote: text('decision_note'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    statusIdx: index('employee_requests_status_idx').on(table.tenantId, table.status, table.createdAt),
    employeeIdx: index('employee_requests_employee_idx').on(table.tenantId, table.employeeId, table.createdAt),
  }),
);

export const employeePushSubscriptions = pgTable(
  'employee_push_subscriptions',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    authSecret: text('auth_secret').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    endpointKey: uniqueIndex('employee_push_subscriptions_endpoint_key').on(table.tenantId, table.endpoint),
  }),
);

export const employeePushOutbox = pgTable(
  'employee_push_outbox',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    membershipId: uuid('membership_id').references(() => memberships.id, { onDelete: 'set null' }),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').notNull().default('queued'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdx: index('employee_push_outbox_user_idx').on(table.tenantId, table.userId, table.createdAt),
  }),
);
