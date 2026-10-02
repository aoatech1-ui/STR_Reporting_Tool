export type Role = 'ADMIN' | 'MANAGER' | 'ACCOUNTANT' | 'VIEWER';

export type Permission =
  | 'read' | 'owners:write' | 'properties:write' | 'commission:write' | 'expenses:write' | 'import:write'
  | 'period:review' | 'period:finalize' | 'statements:send' | 'audit:read' | 'users:manage' | 'settings:view';

const ALL: Permission[] = ['read', 'owners:write', 'properties:write', 'commission:write', 'expenses:write', 'import:write', 'period:review', 'period:finalize', 'statements:send', 'audit:read', 'users:manage', 'settings:view'];

/** Single source of truth for who may do what. Routes declare a permission; they never check roles directly. */
export const GRANTS: Record<Role, ReadonlySet<Permission>> = {
  ADMIN: new Set(ALL),
  MANAGER: new Set(ALL.filter((p) => p !== 'users:manage')), // incl. settings:view: managers need to see whether email/WhatsApp/worker are healthy
  ACCOUNTANT: new Set<Permission>(['read', 'expenses:write', 'import:write', 'period:review', 'audit:read']),
  VIEWER: new Set<Permission>(['read']),
};

export const can = (role: Role, perm: Permission): boolean => GRANTS[role]?.has(perm) ?? false;
