// Pure builder for audit_log rows. Keeps the ip/client-metadata derivation
// testable without a database: appendAudit() in graphql/helpers.js inserts
// exactly what this returns.

export function auditEntry({ actor, action, targetEntity, targetId, metadata, ip, ctx } = {}) {
  const client = ctx?.client ?? null;
  return {
    actorId: actor?.id ?? null,
    actorRole: actor?.role ?? null,
    action,
    targetEntity: targetEntity ?? null,
    targetId: targetId ?? null,
    metadata: client ? { ...(metadata || {}), client } : metadata ?? null,
    ip: ctx?.ip ?? ip ?? 'server',
  };
}
