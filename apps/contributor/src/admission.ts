export function approvedOwnerIdsForHost(value: unknown, localOwnerId: string): string[] {
  if (typeof value !== 'object' || value === null) {
    throw new Error('The Open Inference beta server returned invalid admission information.');
  }
  const result = value as { trustedOwnerIds?: unknown; gatewayOwnerId?: unknown };
  const trustedOwnerIds = Array.isArray(result.trustedOwnerIds)
    ? [...new Set(result.trustedOwnerIds
      .filter((id): id is string => typeof id === 'string' && /^[a-f0-9]{64}$/i.test(id))
      .map(id => id.toLowerCase()))]
    : [];
  if (trustedOwnerIds.length === 0 || typeof result.gatewayOwnerId !== 'string' || !trustedOwnerIds.includes(result.gatewayOwnerId.toLowerCase())) {
    throw new Error('The beta server has not configured its MeshLLM owner allowlist yet.');
  }
  const normalizedOwnerId = localOwnerId.toLowerCase();
  if (!trustedOwnerIds.includes(normalizedOwnerId)) {
    throw new Error(`This computer is not approved yet. Send its Owner ID to the beta operator: ${normalizedOwnerId}`);
  }
  return trustedOwnerIds.sort();
}
