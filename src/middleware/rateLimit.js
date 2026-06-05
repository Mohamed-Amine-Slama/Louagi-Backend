import { rateLimit } from 'express-rate-limit';

import { config } from '../config.js';

const rateLimitResponse = {
  ok: false,
  error: 'Too many requests. Try again later.',
};

export const apiRateLimit = rateLimit({
  windowMs: config.rateLimitWindowMs,
  limit: config.rateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitResponse,
  skip: (req) => req.path === '/health',
});

export const graphqlRateLimit = rateLimit({
  windowMs: config.rateLimitWindowMs,
  limit: config.graphqlRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitResponse,
});
