// Server-side enforcement of the workspace role stored on User.role.
// Today every user is the OWNER of their own workspace, but the schema
// already models ADMIN and MEMBER for invited household members. Enforcing
// the role here (instead of leaving the field decorative) means role-gated
// actions are closed by default when multi-user workspaces ship.

export const WORKSPACE_ROLES = Object.freeze(["OWNER", "ADMIN", "MEMBER"]);

// Roles allowed to link, refresh, or delete financial connections and data.
export const WORKSPACE_MANAGER_ROLES = Object.freeze(["OWNER", "ADMIN"]);

export class WorkspaceRoleError extends Error {
  constructor(message, status = 403) {
    super(message);
    this.name = "WorkspaceRoleError";
    this.status = status;
  }
}

export function normalizeWorkspaceRole(role) {
  return WORKSPACE_ROLES.includes(role) ? role : "OWNER";
}

export async function requireWorkspaceRole(prisma, userId, allowedRoles) {
  const record = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  // A user with no row yet is the owner of their own brand-new workspace.
  const role = normalizeWorkspaceRole(record?.role);
  if (!allowedRoles.includes(role)) {
    throw new WorkspaceRoleError(
      `Your workspace role (${role}) does not permit this action. Ask the workspace owner to perform it.`
    );
  }
  return role;
}

export async function requireWorkspaceManagerRole(prisma, userId) {
  return requireWorkspaceRole(prisma, userId, WORKSPACE_MANAGER_ROLES);
}
