import { createHmac, timingSafeEqual } from 'node:crypto';

import type { MiddlewareHandler } from '@mastra/core/server';

export function createIncidentSignature(
  secret: string,
  timestamp: string,
  rawBody: string,
): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
}

export function verifyIncidentSignature(input: {
  secret: string;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  now?: Date;
  toleranceSeconds?: number;
}): boolean {
  if (!input.timestamp || !input.signature) return false;
  const seconds = Number(input.timestamp);
  if (!Number.isInteger(seconds)) return false;
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - seconds) > (input.toleranceSeconds ?? 300)) return false;
  const expected = Buffer.from(
    createIncidentSignature(input.secret, input.timestamp, input.rawBody),
  );
  const actual = Buffer.from(input.signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function createHmacMiddleware(secret: string): MiddlewareHandler {
  return async (context, next) => {
    const rawBody = await context.req.raw.clone().text();
    const valid = verifyIncidentSignature({
      secret,
      timestamp: context.req.header('x-incident-timestamp') ?? null,
      signature: context.req.header('x-incident-signature') ?? null,
      rawBody,
    });
    if (!valid) return context.json({ reasonCode: 'INVALID_SIGNATURE' }, 401);
    return next();
  };
}
