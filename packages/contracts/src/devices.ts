import { z } from 'zod';

import { uuidSchema } from './ids.js';

/**
 * Canonical tenant device registry DTOs (2026-09 architecture/RBAC reorganisation).
 *
 * A device is an enrolled hardware/endpoint identity — not a user, not a role.
 * The credential secret is generated server-side and returned exactly once at
 * enrolment/rotation; only its SHA-256 hash is stored.
 */
export const deviceTypeSchema = z.enum([
  'pos_terminal',
  'handheld',
  'kiosk',
  'printer_agent',
  'api_client',
  'compat',
  'other',
]);

export type DeviceType = z.infer<typeof deviceTypeSchema>;

export const deviceStatusSchema = z.enum(['pending', 'active', 'suspended', 'revoked']);

export type DeviceStatus = z.infer<typeof deviceStatusSchema>;

export const deviceCreateSchema = z
  .object({
    branchId: uuidSchema,
    deviceType: deviceTypeSchema,
    deviceName: z.string().trim().min(1).max(200),
    capabilities: z.record(z.unknown()).optional(),
  })
  .strict();

export type DeviceCreate = z.infer<typeof deviceCreateSchema>;

export const deviceUpdateSchema = z
  .object({
    deviceName: z.string().trim().min(1).max(200).optional(),
    branchId: uuidSchema.optional(),
    deviceType: deviceTypeSchema.optional(),
    capabilities: z.record(z.unknown()).optional(),
  })
  .strict();

export type DeviceUpdate = z.infer<typeof deviceUpdateSchema>;

export const deviceDtoSchema = z.object({
  id: uuidSchema,
  branchId: uuidSchema,
  deviceType: z.string(),
  deviceName: z.string(),
  activationStatus: deviceStatusSchema,
  hasCredential: z.boolean(),
  lastSeenAt: z.string().nullable(),
  capabilities: z.record(z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
});

export type DeviceDto = z.infer<typeof deviceDtoSchema>;
