import type { orgV1 } from '@eve/contracts';
import { api } from '../api';
import { t } from '../i18n/t';

/** Org API paths and labels for the UI (types from contracts/org/v1). */
export type Structure = orgV1.Structure;
export type StructurePosition = orgV1.Structure['positions'][number];
export type StructureUnit = orgV1.Structure['units'][number];

export const orgPaths = {
  structure: (companyId: string, asOf: string) =>
    `/org/companies/${companyId}/structure?asOf=${asOf}`,
  position: (id: string, asOf: string) => `/org/positions/${id}?asOf=${asOf}`,
  history: (id: string) => `/org/positions/${id}/history`,
  team: (id: string, asOf: string) => `/org/positions/${id}/team?depth=direct&asOf=${asOf}`,
  findings: (companyId: string, query = '') => `/org/findings?companyId=${companyId}${query}`,
  personPositions: (personId: string, asOf: string) =>
    `/org/persons/${personId}/positions?asOf=${asOf}`,
  manager: (personId: string, asOf: string) => `/org/persons/${personId}/manager?asOf=${asOf}`,
  changeRequests: (companyId: string) => `/org/change-requests?companyId=${companyId}`,
  changeRequest: (id: string) => `/org/change-requests/${id}`,
  profile: (companyId: string) => `/org/companies/${companyId}/profile`,
  export: (companyId: string, asOf: string) =>
    `/api/v1/org/companies/${companyId}/positions.xlsx?asOf=${asOf}`,
};

export const orgApi = {
  correctPosition: (id: string, body: unknown) =>
    api('POST', `/org/positions/${id}/corrections`, body),
  acceptFinding: (id: string, reason: string) =>
    api('POST', `/org/findings/${id}/accept`, { reason }),
  reopenFinding: (id: string, reason: string) =>
    api('POST', `/org/findings/${id}/reopen`, { reason }),
  runRules: (companyId: string) => api('POST', `/org/companies/${companyId}/rule-runs`),
  submitChange: (body: orgV1.ChangeRequestInput) =>
    api<orgV1.ChangeRequestView>('POST', '/org/change-requests', body),
  resubmitChange: (id: string, body: unknown) =>
    api<orgV1.ChangeRequestView>('POST', `/org/change-requests/${id}/resubmit`, body),
  decide: (approvalId: string, decision: 'approve' | 'reject' | 'return', note: string | null) =>
    api('POST', `/platform/approvals/${approvalId}/${decision}`, note === null ? {} : { note }),
};

export function positionTypeLabel(type: StructurePosition['type']): string {
  return t(`org.position.type.${type}`);
}

export function statusLabel(status: StructurePosition['status']): string {
  return t(`org.position.status.${status}`);
}

export function kindLabel(kind: orgV1.AssignmentKind): string {
  return t(`org.assignment.kind.${kind}`);
}

export function severityLabel(severity: orgV1.Severity): string {
  return t(`org.finding.severity.${severity}`);
}
