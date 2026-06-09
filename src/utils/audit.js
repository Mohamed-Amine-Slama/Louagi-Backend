import { sql } from '../db.js';

export async function appendAudit({ actor, action, targetEntity, targetId, metadata, ip }) {
  await sql`
    insert into public.audit_log (
      actor_id, actor_role, action, target_entity, target_id, metadata, ip_address
    ) values (
      ${actor?.id ?? null}::uuid,
      ${actor?.role ?? null}::user_role,
      ${action},
      ${targetEntity ?? null},
      ${targetId ?? null}::uuid,
      ${metadata ? JSON.stringify(metadata) : null}::jsonb,
      ${ip ?? 'server'}
    )
  `;
}
