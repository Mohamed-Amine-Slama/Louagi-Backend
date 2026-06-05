import { Router } from 'express';

import { resolvers } from '../graphql/resolvers.js';

export const graphqlRouter = Router();

function inferOperationName(query = '') {
  const match = String(query).match(/\b(?:query|mutation)\s+([A-Za-z0-9_]+)/);
  return match?.[1] ?? null;
}

graphqlRouter.post('/graphql', async (req, res, next) => {
  const operationName = req.body?.operationName || inferOperationName(req.body?.query);
  const variables = req.body?.variables || {};
  const resolver = resolvers[operationName];

  if (!operationName || !resolver) {
    return res.status(400).json({
      errors: [{ message: `Unknown GraphQL operation: ${operationName || 'missing'}` }],
    });
  }

  try {
    const result = await resolver(variables, {
      req,
      ip: req.ip || req.get('x-forwarded-for') || 'server',
    });
    return res.json({ data: { [operationName]: result } });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ errors: [{ message: err.message }] });
    }
    return next(err);
  }
});
