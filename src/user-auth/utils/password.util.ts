import * as crypto from 'node:crypto';

export class PasswordUtil {
  /**
   * Hashes a plaintext password using standard scrypt key derivation with random salt.
   */
  public static hashPassword(password: string): string {
    const salt = crypto.randomBytes(16).toString('hex');
    const derivedKey = crypto.scryptSync(password, salt, 64);
    return `scrypt:${salt}:${derivedKey.toString('hex')}`;
  }

  /**
   * Securely verifies a plaintext password against the stored scrypt hash using timingSafeEqual.
   */
  public static verifyPassword(password: string, storedHash: string): boolean {
    if (!password || !storedHash) return false;

    try {
      const parts = storedHash.split(':');
      if (parts.length === 3 && parts[0] === 'scrypt') {
        const [, salt, originalHash] = parts;
        const derivedKey = crypto.scryptSync(password, salt, 64);
        const derivedHash = derivedKey.toString('hex');
        
        const originalBuf = Buffer.from(originalHash, 'hex');
        const derivedBuf = Buffer.from(derivedHash, 'hex');

        if (originalBuf.length !== derivedBuf.length) {
          return false;
        }

        return crypto.timingSafeEqual(originalBuf, derivedBuf);
      }
      return false;
    } catch {
      return false;
    }
  }
}
