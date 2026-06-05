// Smoke-test route the client can hit after sign-in to verify the JWT verify
// path. Returns the actor extracted by requireAuth.

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';

export const meRouter = Router();

meRouter.get('/me', requireAuth, (req, res) => {
  res.json({ ok: true, actor: req.actor });
});
