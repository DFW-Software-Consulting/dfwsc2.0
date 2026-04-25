export const WORKSPACES = ["dfwsc_services", "client_portal", "ledger_crm"] as const;

export const CRM_WORKSPACES = ["dfwsc_services", "ledger_crm"] as const;

export type Workspace = (typeof WORKSPACES)[number];

export function isWorkspace(value: unknown): value is Workspace {
  return typeof value === "string" && WORKSPACES.includes(value as Workspace);
}

export function isCrmWorkspace(value: unknown): value is (typeof CRM_WORKSPACES)[number] {
  return (
    typeof value === "string" && CRM_WORKSPACES.includes(value as (typeof CRM_WORKSPACES)[number])
  );
}
