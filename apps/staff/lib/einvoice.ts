import { apiFetch } from './api';

/**
 * ⚙️ إعدادات الربط الضريبي - زاتكا ZATCA — the client behind
 * `Desktop_ERP/SmartAuditERP/Form_WPF/frmZatcaSetting.xaml`.
 *
 * Every function here is one button of that window; the shape of each payload is the
 * shape of the `SettingZatca` / `CSRProperties` / `ZatcaCredential` rows it wrote.
 */

export type CsrProperties = {
  commonName: string;
  serialNumber: string;
  organizationIdentifier: string;
  organizationUnitName: string;
  organizationName: string;
  countryName: string;
  invoiceType: string;
  address: string;
  industry: string;
};

export type ComplianceCheckRow = {
  key: string;
  labelEn: string;
  labelAr: string;
  invoiceTypeCode: string;
  typeName: string;
  profile: 'standard' | 'simplified';
  clearance: boolean;
  success: boolean;
  status: string;
  hash: string;
  messages: string[];
};

export type ChecklistRow = { key: string; labelAr: string; done: boolean; at: string | null };

export type ZatcaView = {
  authority: string;
  settings: { environment: 'compliance' | 'production'; simulation: boolean; active: boolean; syncManual: boolean; startDate: string; endDate: string };
  csr: CsrProperties;
  credential: {
    environment: string;
    hasCsr: boolean;
    csr: string | null;
    hasPrivateKey: boolean;
    privateKeyMasked: string | null;
    csidMasked: string | null;
    secretMasked: string | null;
    requestId: string | null;
    productionCsidMasked: string | null;
    productionSecretMasked: string | null;
    productionRequestId: string | null;
    validFrom: string | null;
    validTo: string | null;
    updatedAt: string | null;
  };
  onboarding: {
    csrGeneratedAt: string | null;
    complianceCsidAt: string | null;
    productionCsidAt: string | null;
    complianceCheckedAt: string | null;
    renewedAt: string | null;
    lastComplianceCheck: { passed: boolean; checkedAt: string; checks: ComplianceCheckRow[] } | null;
  };
  checklist: ChecklistRow[];
  link: { active: boolean; canToggle: boolean };
};

export type SettingsInput = {
  environment?: 'compliance' | 'production';
  simulation?: boolean;
  active?: boolean;
  syncManual?: boolean;
  startDate?: string;
  csr?: Partial<CsrProperties>;
};

export type GeneratedCsr = {
  csr: string;
  privateKey: string;
  publicKey: string;
  serialNumber: string;
  fingerprint: string;
  revokedCredentials: boolean;
  message: string;
};

export type CsrGrant = {
  requestId: string;
  csid: string;
  secret: string;
  gateway: 'simulation' | 'http';
  environment: string;
  renewedAt?: string;
  message: string;
};

export type ComplianceRun = {
  passed: boolean;
  checkedAt: string;
  gateway: 'simulation' | 'http';
  checks: ComplianceCheckRow[];
  message: string;
};

export const zatcaView = () => apiFetch<ZatcaView>('/einvoice/settings');

export const saveZatcaSettings = (input: SettingsInput) =>
  apiFetch<{ settings: ZatcaView['settings']; message: string }>('/einvoice/settings', { method: 'PUT', body: JSON.stringify(input) });

export const fillCsrFromCompany = () =>
  apiFetch<{ settings: ZatcaView & { csr: CsrProperties }; warnings: string[]; message: string }>('/einvoice/settings/fill-from-company', { method: 'POST', body: '{}' });

export const generateCsr = () => apiFetch<GeneratedCsr>('/einvoice/csr/generate', { method: 'POST', body: '{}' });

export const requestComplianceCsid = (otp: string) =>
  apiFetch<CsrGrant>('/einvoice/onboarding/compliance-csid', { method: 'POST', body: JSON.stringify({ otp }) });

export const requestProductionCsid = () => apiFetch<CsrGrant>('/einvoice/onboarding/production-csid', { method: 'POST', body: '{}' });

export const renewCsid = () => apiFetch<CsrGrant>('/einvoice/onboarding/renew', { method: 'POST', body: '{}' });

export const runComplianceCheck = () => apiFetch<ComplianceRun>('/einvoice/onboarding/compliance-check', { method: 'POST', body: '{}' });

export const toggleZatcaLink = () =>
  apiFetch<{ active: boolean; message: string }>('/einvoice/link/toggle', { method: 'POST', body: '{}' });

// ─────────────────────────────────────────────────────────────────────────────
// 🧾 الإرسال والتوقيع والسلسلة — `Class/ZatcaService.cs` `IntegrateInvoice` and
// `Class/InvoiceOper.cs` `SendZatca`, behind the window
// `Form_WPF/frmSentEinvoice.xaml` («🧾 الفواتير المرفوعة على موقع الضرائب»).
// ─────────────────────────────────────────────────────────────────────────────

export type QrTag = { tag: number; labelAr: string; value: string; bytes: number };

export type FilingRow = {
  id: string;
  /** The invoice behind the filing — the grid's own columns (رقم الفاتورة · العميل · …). */
  invoice?: {
    number: string | null;
    kind: string | null;
    total: string | null;
    issuedAt: string | null;
    partyName: string | null;
    branchName: string | null;
    createdByName: string | null;
  };
  invoiceId: string;
  authority: string;
  environment: string;
  status: string;
  authorityStatus: string | null;
  uuid: string | null;
  hash: string | null;
  previousHash: string | null;
  chainIndex: number | null;
  attempts: string;
  error: string | null;
  submittedAt: string | null;
  createdAt: string;
  response: {
    submitted?: boolean;
    reason?: string;
    message?: string;
    clearance?: boolean;
    profile?: string;
    gateway?: string;
    endpoint?: string | null;
    errorMessages?: string[];
    warningMessages?: string[];
  } | null;
};

export type FilingPage = { items: FilingRow[]; total: number; pageNo: number; pageSize: number; pages: number };

export type FilingDetail = {
  submission: FilingRow & { requestPayload: { xml?: string; clearedXml?: string; counter?: number; profile?: string } };
  invoice: { id: string; number: string | null; kind: string; total: string; taxTotal: string; currency: string; issuedAt: string | null } | null;
  document: { xml: string | null; clearedXml: string | null; counter: number | null; profile: string | null; clearance: boolean | null };
  chain: { previousHash: string | null; hash: string | null };
  qr: { payload: string | null; tags: QrTag[] };
  authority: { status: string | null; errors: string[]; warnings: string[]; error: string | null; response: Record<string, unknown> };
};

export type ChainState = { authority: string; environment: string; counter: number; lastHash: string; nextCounter: number; updatedAt: string | null };

/** 🔍 عرض — the paged grid, with the window's own «رقم الصفحة» and «حجم الصفحة». */
export const filingsPage = (query: { status?: string; from?: string; to?: string; pageNo: number; pageSize: number }) => {
  const search = new URLSearchParams({ pageNo: String(query.pageNo), pageSize: String(query.pageSize) });
  if (query.status) search.set('status', query.status);
  if (query.from) search.set('from', query.from);
  if (query.to) search.set('to', query.to);
  return apiFetch<FilingPage>(`/einvoice/filings?${search.toString()}`);
};

/** 📄 بيانات الفاتورة — one filing, its document, its cleared document and its QR tags. */
export const filingDetail = (id: string) => apiFetch<FilingDetail>(`/einvoice/filings/${id}`);

/** The tenant's place in the hash chain. */
export const zatcaChain = () => apiFetch<ChainState>('/einvoice/chain');

/** 🔁 إعادة الإرسال — re-files the stored document; the hash never moves. */
export const retryFiling = (id: string) => apiFetch<{ status: string; message?: string }>(`/einvoice/submissions/${id}/retry`, { method: 'POST', body: '{}' });

/** 🧾 إرسال — files one posted sales invoice. */
export const submitInvoiceEinvoice = (invoiceId: string, body: { authority?: 'zatca' | 'eta'; environment?: 'simulation' | 'production' } = {}) =>
  apiFetch<FilingRow>(`/sales-invoices/${invoiceId}/einvoice/submit`, { method: 'POST', body: JSON.stringify(body) });

// ── 📊 حالة المزامنة — `frmInvsSyncStatusZatca.xaml` ─────────────────────────────────────

/** One row of 🔄 مزامنة ZATCA: what happened to the invoice the clerk ticked. */
export type SyncResult = {
  invoiceId: string;
  number: string | null;
  /** `sent` — the authority accepted it · `failed` — refused · `skipped` — never sent. */
  outcome: 'sent' | 'failed' | 'skipped';
  status: string | null;
  authorityStatus: string | null;
  message: string | null;
};

export type SyncReport = {
  requested: number;
  sent: number;
  failed: number;
  skipped: number;
  environment: string;
  authority: string;
  message: string;
  results: SyncResult[];
};

/**
 * 🔄 مزامنة ZATCA — `btnSync_Click` (`frmInvsSyncStatusZatca.xaml.cs` L392-L412) files every
 * row the clerk selected and answers with what happened to each one, because a batch that
 * half-failed must say which half.
 */
export const syncEinvoices = (ids: string[]) => apiFetch<SyncReport>('/einvoice/sync', { method: 'POST', body: JSON.stringify({ ids }) });
