/** API shapes, inferred from the contracts at type level only (no zod in the bundle). */
import type * as C from '@hamnivo/contracts';
import type { z } from 'zod';

export type Me = z.infer<typeof C.Me>;
export type Membership = z.infer<typeof C.Membership>;
export type TenantSummary = z.infer<typeof C.TenantSummary>;
export type WorkspaceSummary = z.infer<typeof C.WorkspaceSummary>;
export type Member = z.infer<typeof C.Member>;

export type Brand = C.Brand;
export type AuthorityConnection = C.AuthorityConnection;
export type CreateBrandRequest = z.input<typeof C.CreateBrandRequest>;

export type Agent = C.Agent;
export type AgentDetail = C.AgentDetail;
export type AgentVersion = C.AgentVersion;
export type AgentConfig = C.AgentConfig;
export type ModelChoice = C.ModelChoice;
export type ModelProviderKind = C.ModelProviderKind;
export type CreateAgentRequest = z.input<typeof C.CreateAgentRequest>;

export type ModelConnection = C.ModelConnection;
export type CreateModelConnectionRequest = z.input<typeof C.CreateModelConnectionRequest>;

export type KillSwitch = C.KillSwitch;
export type KillSwitchScope = z.infer<typeof C.KillSwitchScope>;

export type Run = C.Run;
export type RunStep = NonNullable<Run['steps']>[number];
export type RunPage = { items: Run[]; nextCursor: string | null };

export type KnowledgeSource = C.KnowledgeSource;
export type KnowledgeDocument = C.KnowledgeDocument;
export type DocumentVersion = NonNullable<KnowledgeDocument['current']>;
export type KnowledgePassage = C.KnowledgePassage;
export type KnowledgeMediaType = z.infer<typeof C.KnowledgeMediaType>;
export type AddDocumentRequest = z.input<typeof C.AddDocumentRequest>;
export type DocumentContent = AddDocumentRequest['content'];
export type KnowledgeVisibility = z.infer<typeof C.KnowledgeVisibility>;

export type MemoryItem = C.MemoryItem;
export type MemoryDeletionReceipt = C.MemoryDeletionReceipt;
export type MemoryChange = C.MemoryChange;
export type MemoryCustomerSummary = C.MemoryCustomerSummary;
export type MemoryCustomerDetail = C.MemoryCustomerDetail;
export type MemoryExport = C.MemoryExport;

export type Problem = C.Problem;
export type ErrorCode = C.ErrorCode;

export type Items<T> = { items: T[] };

// Team and access (A02, A09, A12), enterprise sign-in and support access (A13, A18).
export type Role = z.infer<typeof C.Role>;
export type RoleRef = z.infer<typeof C.RoleRef>;
export type GrantView = z.infer<typeof C.GrantView>;
export type GrantScope = z.infer<typeof C.GrantScope>;
export type Invitation = z.infer<typeof C.Invitation>;
export type CreatedInvitation = z.infer<typeof C.CreatedInvitation>;
export type PermissionInfo = z.infer<typeof C.PermissionInfo>;
export type RolePreview = z.infer<typeof C.RolePreview>;
export type MemberOffboarding = z.infer<typeof C.MemberOffboarding>;
export type AuditEvent = z.infer<typeof C.AuditEventView>;
export type AuditPage = z.infer<typeof C.AuditPage>;
export type AuditVerification = z.infer<typeof C.AuditVerification>;
export type Team = C.Team;
export type BulkResult = C.BulkResult;
export type SsoSettings = C.SsoSettings;
export type SsoDomain = C.SsoDomain;
export type SsoConnection = C.SsoConnection;
export type SupportGrant = C.SupportGrant;
export type SupportScope = C.SupportScope;
export type WorkspaceNotices = C.WorkspaceNotices;
export type IncidentNotice = C.IncidentNotice;

// Platform operations console (A17).
export type PlatformOperator = C.PlatformOperator;
export type PlatformTenant = C.PlatformTenant;
export type PlatformTenantDetail = C.PlatformTenantDetail;
export type PlatformHealth = C.PlatformHealth;
export type PlatformOverview = C.PlatformOverview;
export type Incident = C.Incident;
export type PlatformAuditPage = C.PlatformAuditPage;
export type PlatformAuditEvent = C.PlatformAuditEvent;
export type SupportConfiguration = C.SupportConfiguration;
export type SupportConversations = C.SupportConversations;
export type SupportAudit = C.SupportAudit;
