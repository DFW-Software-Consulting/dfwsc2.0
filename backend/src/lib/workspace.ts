export const WORKSPACES = ["client_portal", "dfwsc"] as const;

export type Workspace = (typeof WORKSPACES)[number];

export function isWorkspace(value: unknown): value is Workspace {
  return typeof value === "string" && WORKSPACES.includes(value as Workspace);
}

export function isDfwscWorkspace(value: unknown): boolean {
  return value === "dfwsc";
}

export function isPortalWorkspace(value: unknown): boolean {
  return value === "client_portal";
}
