// GraphQL transport. Thin shim — the actual business logic lives in
// src/cqrs/. This file only translates between the HTTP wire format and the
// command/query bus dispatch.

import { Router } from 'express';

import { sql } from '../db.js';
import { dispatch, hasOperation } from '../cqrs/index.js';
import { createLoaders } from '../graphql/loaders.js';

export const graphqlRouter = Router();

function inferOperationName(query = '') {
  const match = String(query).match(/\b(?:query|mutation)\s+([A-Za-z0-9_]+)/);
  return match?.[1] ?? null;
}

graphqlRouter.post('/graphql', async (req, res, next) => {
  const operationName = req.body?.operationName || inferOperationName(req.body?.query);
  const variables = req.body?.variables || {};

  if (!operationName || !hasOperation(operationName)) {
    return res.status(400).json({
      errors: [{ message: `Unknown GraphQL operation: ${operationName || 'missing'}` }],
    });
  }

  const ctx = {
    req,
    ip: req.ip || req.get('x-forwarded-for') || 'server',
    loaders: createLoaders(sql),
    actor: null, // populated by auth middleware on the bus
  };

  try {
    const result = await dispatch(operationName, variables, ctx);
    return res.json({ data: { [operationName]: result } });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ errors: [{ message: err.message }] });
    }
    return next(err);
  }
});
