// Authentication middleware.
//
// Verifies the Bearer token, loads the actor (from Redis or DB), and stashes it
// on ctx.actor. Handlers receive a guaranteed actor and don't call
// `requireActor` themselves. Public handlers opt out via `meta.public = true`.

import { actorFromRequest } from '../../middleware/auth.js';
import { HttpError } from '../../graphql/helpers.js';

export function authMiddleware() {
  return async ({ name, ctx, metadata }, next) => {
    if (metadata?.public) return next();
    if (!ctx.actor) {
      const actor = await actorFromRequest(ctx.req);
      if (!actor) throw new HttpError(401, 'Invalid or expired token');
      ctx.actor = actor;
    }
    return next();
  };
}
