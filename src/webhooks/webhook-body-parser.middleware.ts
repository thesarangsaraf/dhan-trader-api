import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

/**
 * Parses a raw string body (JSON, double-encoded JSON, or URL-encoded form data)
 * into a plain object for webhook DTO binding.
 */
export function parseWebhookStringBody(raw: string): Record<string, any> {
  const trimmed = raw.trim();
  if (!trimmed) return {};

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'string') {
      try {
        const inner = JSON.parse(parsed);
        if (inner && typeof inner === 'object') return inner;
      } catch {
        // Ignore non-JSON inner string
      }
    }
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch {
    if (trimmed.includes('=')) {
      const params = new URLSearchParams(trimmed);
      const obj: Record<string, any> = {};
      for (const [k, v] of params.entries()) {
        obj[k] = v;
      }
      if (obj.payload && typeof obj.payload === 'string') {
        try {
          const inner = JSON.parse(obj.payload);
          if (inner && typeof inner === 'object') return inner;
        } catch {
          // Keep flat form parameters
        }
      }
      if (Object.keys(obj).length > 0) return obj;
    }
  }

  return {};
}

/**
 * Ensures webhook requests sent with `text/plain` or missing `Content-Type` headers
 * (e.g. Go-http-client postbacks) are parsed into `req.body` before ValidationPipe runs.
 */
@Injectable()
export class WebhookBodyParserMiddleware implements NestMiddleware {
  use(req: Request & { _body?: boolean }, _res: Response, next: NextFunction): void {
    if (typeof req.body === 'string') {
      req.body = parseWebhookStringBody(req.body);
      next();
      return;
    }

    if (req._body || (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0)) {
      next();
      return;
    }

    if (!req.readable || req.readableEnded) {
      next();
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim()) {
        req.body = parseWebhookStringBody(raw);
        req._body = true;
      }
      next();
    });
    req.on('error', () => {
      next();
    });
  }
}
