export const WORKSPACES = ["dfwsc_services", "client_portal"] as const;

export type Workspace = (typeof WORKSPACES)[number];

export function isWorkspace(value: unknown): value is Workspace {
  return typeof value === "string" && WORKSPACES.includes(value as Workspace);
}
