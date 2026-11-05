import { z } from 'zod';
import { Timestamp } from './common.js';
import { typeId } from './ids.js';
import type { RouteDef } from './routes.js';

export const ConnectorCapability = z.enum([
  'invoices.read',
  'services.read',
  'domains.read',
  'tickets.read',
  'tickets.create',
  'tickets.reply',
  'invoice.payment_url',
  'upgrade.quote',
  'upgrade.request',
  'cancellation.request',
  'refund.handoff',
]);
export type ConnectorCapability = z.infer<typeof ConnectorCapability>;
export const ConnectorCatalogItem = z.object({
  key: ConnectorCapability,
  title: z.string(),
  description: z.string(),
  risk: z.enum(['read', 'write', 'money', 'irreversible']),
  approver: z.enum(['customer', 'staff']),
});
export const ConnectorConnection = z.object({
  id: typeId('connection'),
  brandId: typeId('brand'),
  kind: z.literal('whmcs'),
  label: z.string(),
  baseUrl: z.url(),
  status: z.enum(['active', 'disabled']),
  capabilities: z.array(ConnectorCapability),
  grantVersion: z.int().positive(),
  lastTestedAt: Timestamp.nullable(),
  lastError: z.string().nullable(),
  identityKeyId: z.string().min(1).max(128),
});
export const CreateConnectorRequest = z.object({
  brandId: typeId('brand'),
  kind: z.literal('whmcs'),
  label: z.string().trim().min(1).max(120),
  baseUrl: z.url(),
  identifier: z.string().min(1).max(512),
  secret: z.string().min(1).max(2048),
  identityKeyId: z.string().min(1).max(128),
  capabilities: z.array(ConnectorCapability).min(1),
});
export const ReconnectConnectorRequest = z.object({
  identifier: z.string().min(1).max(512),
  secret: z.string().min(1).max(2048),
});
export const UpdateConnectorGrantsRequest = z.object({
  capabilities: z.array(ConnectorCapability),
  expectedVersion: z.int().positive(),
});
export const ConnectorTestResult = z.object({
  ok: z.boolean(),
  checkedAt: Timestamp,
  message: z.string(),
});

export const TestConnectorPermissionsRequest = z.object({
  userId: z.int().positive().max(2147483647),
  clientId: z.int().positive().max(2147483647),
});
export const ConnectorPermissionsTestResult = z.object({
  ok: z.boolean(),
  checkedAt: Timestamp,
  userId: z.int().positive(),
  clientId: z.int().positive(),
  items: z.array(
    z.object({
      capability: ConnectorCapability,
      configured: z.boolean(),
      requiredPermission: z.string(),
      allowed: z.boolean(),
      reason: z.enum([
        'allowed',
        'grant_disabled',
        'connection_disabled',
        'permission_denied',
        'permission_unverified',
      ]),
    }),
  ),
});

const id = z.object({ connectionId: typeId('connection') });
export const connectorRoutes = {
  catalog: {
    method: 'get',
    path: '/v1/admin/connectors/catalog',
    operationId: 'connectorCatalog',
    summary: 'Native connector capability catalog',
    tags: ['Connectors'],
    auth: 'staff_session',
    success: {
      status: 200,
      description: 'Catalog',
      schema: z.object({ items: z.array(ConnectorCatalogItem) }),
    },
  },
  list: {
    method: 'get',
    path: '/v1/admin/connectors',
    operationId: 'listConnectors',
    summary: 'List brand connectors',
    tags: ['Connectors'],
    auth: 'staff_session',
    query: z.object({ brandId: typeId('brand').optional() }),
    success: {
      status: 200,
      description: 'Connections',
      schema: z.object({ items: z.array(ConnectorConnection) }),
    },
  },
  create: {
    method: 'post',
    path: '/v1/admin/connectors',
    operationId: 'createConnector',
    summary: 'Create WHMCS connection and capability grants',
    tags: ['Connectors'],
    auth: 'staff_session',
    body: CreateConnectorRequest,
    idempotent: true,
    success: { status: 201, description: 'Connection', schema: ConnectorConnection },
  },
  test: {
    method: 'post',
    path: '/v1/admin/connectors/{connectionId}/test',
    operationId: 'testConnector',
    summary: 'Test WHMCS API credential',
    tags: ['Connectors'],
    auth: 'staff_session',
    params: id,
    success: { status: 200, description: 'Test result', schema: ConnectorTestResult },
  },
  testPermissions: {
    method: 'post',
    path: '/v1/admin/connectors/{connectionId}/permissions/test',
    operationId: 'testConnectorPermissions',
    summary: 'Preview live WHMCS user/client permissions against configured grants',
    tags: ['Connectors'],
    auth: 'staff_session',
    params: id,
    body: TestConnectorPermissionsRequest,
    success: {
      status: 200,
      description: 'Live permission preview',
      schema: ConnectorPermissionsTestResult,
    },
  },
  reconnect: {
    method: 'post',
    path: '/v1/admin/connectors/{connectionId}/reconnect',
    operationId: 'reconnectConnector',
    summary: 'Rotate WHMCS credential and test it',
    tags: ['Connectors'],
    auth: 'staff_session',
    params: id,
    body: ReconnectConnectorRequest,
    success: { status: 200, description: 'Connection', schema: ConnectorConnection },
  },
  disable: {
    method: 'post',
    path: '/v1/admin/connectors/{connectionId}/disable',
    operationId: 'disableConnector',
    summary: 'Disable connection and tools',
    tags: ['Connectors'],
    auth: 'staff_session',
    params: id,
    success: { status: 200, description: 'Connection', schema: ConnectorConnection },
  },
  grants: {
    method: 'put',
    path: '/v1/admin/connectors/{connectionId}/grants',
    operationId: 'updateConnectorGrants',
    summary: 'Replace reviewed capability grants',
    tags: ['Connectors'],
    auth: 'staff_session',
    params: id,
    body: UpdateConnectorGrantsRequest,
    success: { status: 200, description: 'Connection', schema: ConnectorConnection },
  },
} satisfies Record<string, RouteDef>;

export type ConnectorConnection = z.infer<typeof ConnectorConnection>;

export type CreateConnectorRequest = z.infer<typeof CreateConnectorRequest>;

export type ReconnectConnectorRequest = z.infer<typeof ReconnectConnectorRequest>;

export type UpdateConnectorGrantsRequest = z.infer<typeof UpdateConnectorGrantsRequest>;

export type TestConnectorPermissionsRequest = z.infer<typeof TestConnectorPermissionsRequest>;
export type ConnectorPermissionsTestResult = z.infer<typeof ConnectorPermissionsTestResult>;
