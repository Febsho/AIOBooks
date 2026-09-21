export interface Principal {
  id: string;
  role: "ADMIN" | "USER";
}

export interface ScopedResource {
  ownerUserId: string;
  scope: "PRIVATE" | "SHARED";
}

export function canReadScopedResource(principal: Principal, resource: ScopedResource, granted = false): boolean {
  return principal.role === "ADMIN" || principal.id === resource.ownerUserId || (resource.scope === "SHARED" && granted);
}

export function canManageScopedResource(principal: Principal, resource: ScopedResource, manageGrant = false): boolean {
  return principal.role === "ADMIN" || principal.id === resource.ownerUserId || manageGrant;
}
