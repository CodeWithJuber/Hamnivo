import { z } from 'zod';
import {
  EraseCustomerRequest,
  ExportCustomerRequest,
  PrivacyCustomerList,
  PrivacyCustomerSummary,
  PrivacyCustomersQuery,
  PrivacyRequest,
  PrivacyRequestList,
} from './customer-privacy.js';
import {
  RetentionPolicy,
  RetentionPreview,
  RetentionPreviewQuery,
  SetRetentionRequest,
} from './privacy.js';
import type { RouteDef } from './routes.js';

const customerParams = z.object({
  customerId: z.string().meta({ description: 'Customer ID (cus_…)' }),
});
const requestParams = z.object({
  requestId: z.string().meta({ description: 'Request ID (prq_…)' }),
});

/** How long the workspace keeps conversations, and one customer's data on request (A10). */
export const privacyRoutes = {
  getRetentionPolicy: {
    method: 'get',
    path: '/v1/admin/privacy/retention',
    operationId: 'getRetentionPolicy',
    summary:
      'How long the workspace keeps resolved conversations, a change waiting to take effect, and what was deleted so far (privacy.manage)',
    tags: ['Administration'],
    auth: 'staff_session',
    success: { status: 200, description: 'Retention', schema: RetentionPolicy },
  },
  setRetentionPolicy: {
    method: 'put',
    path: '/v1/admin/privacy/retention',
    operationId: 'setRetentionPolicy',
    summary:
      'Keep resolved conversations for a period, or forever. Turning retention on or shortening it takes effect after the grace period; saving the period in force again undoes it (privacy.manage; recent sign-in and two-step verification)',
    tags: ['Administration'],
    auth: 'staff_session',
    body: SetRetentionRequest,
    success: { status: 200, description: 'Retention', schema: RetentionPolicy },
  },
  previewRetention: {
    method: 'get',
    path: '/v1/admin/privacy/retention/preview',
    operationId: 'previewRetention',
    summary: 'How many resolved conversations a period would delete today (privacy.manage)',
    tags: ['Administration'],
    auth: 'staff_session',
    query: RetentionPreviewQuery,
    success: { status: 200, description: 'What would be deleted', schema: RetentionPreview },
  },
  findPrivacyCustomers: {
    method: 'get',
    path: '/v1/admin/privacy/customers',
    operationId: 'findPrivacyCustomers',
    summary:
      'Find a customer by name, email, their ID in your systems, or a phone number or handle, in the brands where you may export or erase customers (customers.export or customers.erase)',
    tags: ['Administration'],
    auth: 'staff_session',
    query: PrivacyCustomersQuery,
    success: { status: 200, description: 'Customers', schema: PrivacyCustomerList },
  },
  getPrivacyCustomer: {
    method: 'get',
    path: '/v1/admin/privacy/customers/{customerId}',
    operationId: 'getPrivacyCustomer',
    summary:
      'What exporting or erasing a customer covers: their conversations, orders and memory, and earlier requests (customers.export or customers.erase)',
    tags: ['Administration'],
    auth: 'staff_session',
    params: customerParams,
    success: { status: 200, description: 'The customer', schema: PrivacyCustomerSummary },
  },
  exportPrivacyCustomer: {
    method: 'post',
    path: '/v1/admin/privacy/customers/{customerId}/export',
    operationId: 'exportPrivacyCustomer',
    summary:
      'Prepare a file with everything about the customer: profile, conversations as they saw them, files, consents, memory and orders. It can be downloaded for 24 hours (customers.export; recent sign-in)',
    tags: ['Administration'],
    auth: 'staff_session',
    idempotent: true,
    params: customerParams,
    body: ExportCustomerRequest,
    success: { status: 202, description: 'Request', schema: PrivacyRequest },
  },
  erasePrivacyCustomer: {
    method: 'post',
    path: '/v1/admin/privacy/customers/{customerId}/erase',
    operationId: 'erasePrivacyCustomer',
    summary:
      'Erase the customer everywhere: their conversations in Chatwoot and Hamnivo, their contact, memory and records. Orders stay as accounting records with an anonymous customer. Cannot be undone (customers.erase; recent sign-in and two-step verification)',
    tags: ['Administration'],
    auth: 'staff_session',
    idempotent: true,
    params: customerParams,
    body: EraseCustomerRequest,
    success: { status: 202, description: 'Request', schema: PrivacyRequest },
  },
  listPrivacyRequests: {
    method: 'get',
    path: '/v1/admin/privacy/requests',
    operationId: 'listPrivacyRequests',
    summary:
      'Exports and erasures asked for, newest first, in the brands you may see them (customers.export or customers.erase)',
    tags: ['Administration'],
    auth: 'staff_session',
    success: { status: 200, description: 'Requests', schema: PrivacyRequestList },
  },
  getPrivacyRequest: {
    method: 'get',
    path: '/v1/admin/privacy/requests/{requestId}',
    operationId: 'getPrivacyRequest',
    summary: 'One export or erasure and what it did (customers.export or customers.erase)',
    tags: ['Administration'],
    auth: 'staff_session',
    params: requestParams,
    success: { status: 200, description: 'Request', schema: PrivacyRequest },
  },
  downloadPrivacyExport: {
    method: 'get',
    path: '/v1/admin/privacy/requests/{requestId}/file',
    operationId: 'downloadPrivacyExport',
    summary:
      'Download an export as a ZIP file of JSON documents and files, within 24 hours (customers.export; recent sign-in)',
    tags: ['Administration'],
    auth: 'staff_session',
    params: requestParams,
    success: { status: 200, description: 'The ZIP file', contentType: 'application/zip' },
  },
} as const satisfies Record<string, RouteDef>;
