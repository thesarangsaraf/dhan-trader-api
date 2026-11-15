import * as crypto from 'node:crypto';

export interface JwtPayload {
  sub: string;
  username: string;
  role: string;
  iat?: number;
  exp?: number;
}

export class UserJwtUtil {
  private static readonly DEFAULT_SECRET = process.env.JWT_SECRET || 'dhan-trader-user-jwt-secret-key-2026';

  /**
   * Signs a JWT using HMAC-SHA256 (HS256).
   * @param payload User identity information
   * @param expiresInSeconds Lifetime in seconds (default 15 minutes = 900s)
   * @param secret Optional custom secret key
   */
  public static sign(
    payload: Omit<JwtPayload, 'iat' | 'exp'>,
    expiresInSeconds: number = 900,
    secret: string = this.DEFAULT_SECRET,
  ): string {
    const now = Math.floor(Date.now() / 1000);
    const fullPayload: JwtPayload = {
      ...payload,
      iat: now,
      exp: now + expiresInSeconds,
    };

    const header = { alg: 'HS256', typ: 'JWT' };
    const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify(fullPayload)).toString('base64url');
    const dataToSign = `${headerB64}.${payloadB64}`;

    const signature = crypto
      .createHmac('sha256', secret)
      .update(dataToSign)
      .digest('base64url');

    return `${dataToSign}.${signature}`;
  }

  /**
   * Verifies and decodes a HS256 JWT token.
   * Returns decoded payload if valid and unexpired; returns null otherwise.
   */
  public static verify(
    token: string,
    secret: string = this.DEFAULT_SECRET,
  ): JwtPayload | null {
    if (!token || typeof token !== 'string') return null;

    const parts = token.trim().split('.');
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signature] = parts;
    const dataToSign = `${headerB64}.${payloadB64}`;

    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(dataToSign)
      .digest('base64url');

    try {
      const sigBuf = Buffer.from(signature);
      const expectedBuf = Buffer.from(expectedSignature);

      if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
        return null;
      }

      const payloadJson = Buffer.from(payloadB64, 'base64url').toString('utf8');
      const payload: JwtPayload = JSON.parse(payloadJson);

      const now = Math.floor(Date.now() / 1000);
      if (payload.exp && payload.exp < now) {
        return null; // Expired
      }

      return payload;
    } catch {
      return null;
    }
  }

  /**
   * Generates a cryptographically strong random token for long-lived refresh tokens.
   */
  public static generateRefreshToken(): string {
    return crypto.randomBytes(40).toString('hex');
  }
}
