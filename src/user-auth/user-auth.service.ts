import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { FirestoreService } from '../firestore/firestore.service';
import { PasswordUtil } from './utils/password.util';
import { UserJwtUtil } from './utils/user-jwt.util';
import { parseUserAgent } from './utils/user-agent.util';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { CreateUserDto, UserRole } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { ActiveSessionDto } from './dto/active-session.dto';

export interface StoredRefreshToken {
  id?: string;
  token: string;
  createdAt: string;
  expiresAt: string;
  userAgent?: string;
  ip?: string;
}

export interface StoredUserDoc {
  username: string;
  passwordHash: string;
  role: string;
  refreshTokens?: StoredRefreshToken[];
  createdAt: string;
  updatedAt: string;
}

export interface UserSummary {
  username: string;
  role: string;
  createdAt: string;
  updatedAt: string;
  sessionCount: number;
}

@Injectable()
export class UserAuthService implements OnModuleInit {
  private readonly logger = new Logger(UserAuthService.name);
  private inMemoryUsers: Map<string, StoredUserDoc> = new Map();

  constructor(private readonly firestoreService: FirestoreService) {}

  async onModuleInit() {
    await this.initUsers();
  }

  /**
   * Initializes superuser 'sarang' and any configured admin users in Firestore collection 'users'.
   * Never injects hardcoded fallback passwords. All credentials originate from Firestore or explicit env vars.
   */
  public async initUsers(): Promise<void> {
    try {
      if (!this.firestoreService.isReady()) {
        this.logger.warn('Firestore is not ready yet during UserAuthService initialization.');
        return;
      }

      const now = new Date().toISOString();

      // 1. Ensure superuser 'sarang' exists
      const sarangDoc = await this.firestoreService.getDoc<StoredUserDoc>('users', 'sarang');
      if (sarangDoc && sarangDoc.passwordHash) {
        this.inMemoryUsers.set('sarang', sarangDoc);
      } else if (process.env.SARANG_PASSWORD && process.env.SARANG_PASSWORD.trim()) {
        const sarangUser: StoredUserDoc = {
          username: 'sarang',
          passwordHash: PasswordUtil.hashPassword(process.env.SARANG_PASSWORD.trim()),
          role: UserRole.ADMIN,
          refreshTokens: [],
          createdAt: now,
          updatedAt: now,
        };
        await this.firestoreService.setDoc('users', 'sarang', sarangUser, true);
        this.inMemoryUsers.set('sarang', sarangUser);
        this.logger.log(`🔐 Initialized superuser [sarang] in Firestore from environment configuration`);
      } else {
        this.logger.warn(
          `⚠️ Superuser 'sarang' not found in Firestore and SARANG_PASSWORD is not set. Please ensure user exists in Firestore.`,
        );
      }

      // 2. Load admin user if present in Firestore or configured via environment on initial setup
      const adminUsername = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();
      const adminDoc = await this.firestoreService.getDoc<StoredUserDoc>('users', adminUsername);
      if (adminDoc && adminDoc.passwordHash) {
        this.inMemoryUsers.set(adminUsername, adminDoc);
      } else if (!sarangDoc && process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.trim()) {
        // Initial first-time system setup only when sarang does not exist and ADMIN_PASSWORD is set in env
        const adminUser: StoredUserDoc = {
          username: adminUsername,
          passwordHash: PasswordUtil.hashPassword(process.env.ADMIN_PASSWORD.trim()),
          role: UserRole.ADMIN,
          refreshTokens: [],
          createdAt: now,
          updatedAt: now,
        };
        await this.firestoreService.setDoc('users', adminUsername, adminUser, true);
        this.inMemoryUsers.set(adminUsername, adminUser);
        this.logger.log(`👤 Initialized admin user [${adminUsername}] in Firestore from environment`);
      } else {
        this.inMemoryUsers.delete(adminUsername);
      }

      // 3. Preload all existing users and their active sessions from Firestore into memory
      // Guarantees sessions survive server restarts instantly without cold-start cache misses
      const allUsers = await this.firestoreService.listDocuments('users', 100);
      for (const { data } of allUsers) {
        const docId = (data.username || data.id || '').toLowerCase();
        if (docId && data.passwordHash) {
          this.inMemoryUsers.set(docId, data as StoredUserDoc);
        }
      }
    } catch (err: any) {
      this.logger.warn(`Could not initialize users in Firestore: ${err.message}`);
    }
  }

  /**
   * Retrieves user document from Firestore 'users' collection or in-memory fallback.
   */
  public async getUser(username: string, force = false): Promise<StoredUserDoc | null> {
    const docId = (username || '').trim().toLowerCase();
    if (!docId) return null;

    if (!force && this.inMemoryUsers.has(docId)) {
      return this.inMemoryUsers.get(docId)!;
    }

    if (this.firestoreService.isReady()) {
      try {
        const user = await this.firestoreService.getDoc<StoredUserDoc>('users', docId);
        if (user) {
          this.inMemoryUsers.set(docId, user);
          return user;
        }

        // When Firestore is connected and ready, if document is not in 'users', user does not exist.
        this.inMemoryUsers.delete(docId);
        return null;
      } catch (err: any) {
        this.logger.warn(`Could not fetch user [${docId}] from Firestore: ${err.message}`);
      }
    }

    // Fallback to in-memory only when Firestore is not ready
    return this.inMemoryUsers.get(docId) || null;
  }

  /**
   * Save user document to Firestore and in-memory cache.
   */
  private async saveUser(user: StoredUserDoc): Promise<void> {
    const docId = user.username.toLowerCase();
    this.inMemoryUsers.set(docId, user);

    if (this.firestoreService.isReady()) {
      await this.firestoreService.setDoc('users', docId, user, true);
    }
  }

  /**
   * List all users (excluding password hashes) - strictly restricted to superuser 'sarang'.
   */
  public async listUsers(): Promise<UserSummary[]> {
    if (this.firestoreService.isReady()) {
      try {
        const docs = await this.firestoreService.listDocuments('users', 100);
        if (docs && docs.length > 0) {
          return docs.map(({ data }) => {
            const docId = (data.username || data.id || '').toLowerCase();
            if (docId) {
              this.inMemoryUsers.set(docId, data as StoredUserDoc);
            }
            return {
              username: data.username || data.id,
              role: data.role || UserRole.TRADER,
              createdAt: data.createdAt || new Date().toISOString(),
              updatedAt: data.updatedAt || new Date().toISOString(),
              sessionCount: (data.refreshTokens || []).length,
            };
          });
        }
      } catch (err: any) {
        this.logger.warn(`Could not list users from Firestore: ${err.message}`);
      }
    }

    // Fallback to in-memory users
    const summaries: UserSummary[] = [];
    for (const u of this.inMemoryUsers.values()) {
      summaries.push({
        username: u.username,
        role: u.role,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
        sessionCount: (u.refreshTokens || []).length,
      });
    }

    return summaries;
  }

  /**
   * Create a new user - restricted to superuser 'sarang'.
   */
  public async createUser(dto: CreateUserDto): Promise<{ success: boolean; message: string; user: { username: string; role: string } }> {
    const cleanUsername = (dto.username || '').trim();
    const docId = cleanUsername.toLowerCase();

    if (!cleanUsername) {
      throw new BadRequestException('Username is required');
    }

    const existing = await this.getUser(docId);
    if (existing) {
      throw new ConflictException(`User '${cleanUsername}' already exists`);
    }

    const now = new Date().toISOString();
    const newUser: StoredUserDoc = {
      username: cleanUsername,
      passwordHash: PasswordUtil.hashPassword(dto.password.trim()),
      role: dto.role || UserRole.TRADER,
      refreshTokens: [],
      createdAt: now,
      updatedAt: now,
    };

    await this.saveUser(newUser);
    this.logger.log(`👤 User '${cleanUsername}' created with role [${newUser.role}]`);

    return {
      success: true,
      message: `User '${cleanUsername}' created successfully`,
      user: {
        username: cleanUsername,
        role: newUser.role,
      },
    };
  }

  /**
   * Update an existing user (role and/or password) - restricted to superuser 'sarang'.
   */
  public async updateUser(username: string, dto: UpdateUserDto): Promise<{ success: boolean; message: string }> {
    const cleanUsername = (username || '').trim();
    const docId = cleanUsername.toLowerCase();

    const user = await this.getUser(docId);
    if (!user) {
      throw new NotFoundException(`User '${cleanUsername}' not found`);
    }

    const now = new Date().toISOString();

    if (dto.role) {
      // Prevent demoting 'sarang' from admin
      if (docId === 'sarang' && dto.role !== UserRole.ADMIN) {
        throw new BadRequestException('Superuser sarang must retain admin role');
      }
      user.role = dto.role;
    }

    if (dto.password && dto.password.trim()) {
      user.passwordHash = PasswordUtil.hashPassword(dto.password.trim());
      // Invalidate existing sessions when password is reset by admin
      user.refreshTokens = [];
    }

    user.updatedAt = now;
    await this.saveUser(user);
    this.logger.log(`⚙️ User '${cleanUsername}' updated`);

    return {
      success: true,
      message: `User '${cleanUsername}' updated successfully`,
    };
  }

  /**
   * Delete an existing user - restricted to superuser 'sarang'. Cannot delete 'sarang'.
   */
  public async deleteUser(username: string): Promise<{ success: boolean; message: string }> {
    const cleanUsername = (username || '').trim();
    const docId = cleanUsername.toLowerCase();

    if (docId === 'sarang') {
      throw new BadRequestException('Cannot delete superuser account sarang');
    }

    const user = await this.getUser(docId);
    if (!user) {
      throw new NotFoundException(`User '${cleanUsername}' not found`);
    }

    this.inMemoryUsers.delete(docId);
    if (this.firestoreService.isReady()) {
      await this.firestoreService.deleteDoc('users', docId);
      // If deleting the admin user, permanently purge legacy config/auth_user document as well
      if (docId === 'admin') {
        try {
          await this.firestoreService.deleteDoc('config', 'auth_user');
        } catch (e: any) {
          this.logger.warn(`Could not delete legacy config/auth_user: ${e.message}`);
        }
      }
    }

    this.logger.log(`🗑️ User '${cleanUsername}' deleted`);
    return {
      success: true,
      message: `User '${cleanUsername}' deleted successfully`,
    };
  }

  /**
   * Helper to derive or retrieve a stable unique session ID.
   */
  public static getSessionId(session: StoredRefreshToken): string {
    if (session.id) return session.id;
    return crypto.createHash('sha256').update(session.token).digest('hex').slice(0, 16);
  }

  /**
   * Validates username and password, returns short-lived JWT access token & 365-day persistent refresh token.
   */
  public async login(dto: LoginDto, userAgent?: string, ip?: string) {
    const cleanUsername = (dto.username || '').trim();
    const cleanPassword = (dto.password || '').trim();

    if (!cleanUsername || !cleanPassword) {
      throw new UnauthorizedException('Username and password are required');
    }

    const user = await this.getUser(cleanUsername, true);
    if (!user) {
      throw new UnauthorizedException('Invalid username or password');
    }

    const passwordMatch = PasswordUtil.verifyPassword(cleanPassword, user.passwordHash);
    if (!passwordMatch) {
      throw new UnauthorizedException('Invalid username or password');
    }

    // 30-day stateless access token (2,592,000s)
    // Ensures sessions survive backend server restarts seamlessly without requiring frequent refresh calls
    const accessToken = UserJwtUtil.sign(
      {
        sub: user.username,
        username: user.username,
        role: user.role || 'admin',
      },
      30 * 24 * 60 * 60,
    );

    // 365-day (1 year) long-lived persistent refresh token
    const refreshToken = UserJwtUtil.generateRefreshToken();
    const sessionId = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();

    const newSession: StoredRefreshToken = {
      id: sessionId,
      token: refreshToken,
      createdAt: now.toISOString(),
      expiresAt,
      userAgent: userAgent || 'Browser',
      ip: ip || '127.0.0.1',
    };

    const activeTokens = (user.refreshTokens || [])
      .filter((t) => new Date(t.expiresAt).getTime() > Date.now())
      .slice(-14);

    activeTokens.push(newSession);
    user.refreshTokens = activeTokens;
    await this.saveUser(user);

    return {
      accessToken,
      refreshToken,
      sessionId,
      user: {
        username: user.username,
        role: user.role || 'admin',
      },
    };
  }

  /**
   * Refreshes access token using persistent refresh token across any user record.
   */
  public async refreshToken(dto: RefreshTokenDto, userAgent?: string) {
    if (!dto.refreshToken) {
      throw new UnauthorizedException('Refresh token is required');
    }

    let matchedUser: StoredUserDoc | null = null;
    let matchedSession: StoredRefreshToken | null = null;

    // 1. Search in-memory users cache first (zero database reads if user session is cached)
    for (const u of this.inMemoryUsers.values()) {
      const session = (u.refreshTokens || []).find((s) => s.token === dto.refreshToken);
      if (session) {
        matchedUser = u;
        matchedSession = session;
        break;
      }
    }

    // 2. If not found in memory, query Firestore and populate cache
    if (!matchedUser && this.firestoreService.isReady()) {
      try {
        const docs = await this.firestoreService.listDocuments('users', 100);
        for (const { data } of docs) {
          const docId = (data.username || data.id || '').toLowerCase();
          if (docId) this.inMemoryUsers.set(docId, data as StoredUserDoc);
          const session = (data.refreshTokens || []).find((s: StoredRefreshToken) => s.token === dto.refreshToken);
          if (session && !matchedUser) {
            matchedUser = data as StoredUserDoc;
            matchedSession = session;
          }
        }
      } catch (err: any) {
        this.logger.warn(`Could not search refresh token in Firestore: ${err.message}`);
      }
    }

    if (!matchedUser || !matchedSession) {
      throw new UnauthorizedException('Invalid or expired refresh token. Please sign in again.');
    }

    if (new Date(matchedSession.expiresAt).getTime() <= Date.now()) {
      matchedUser.refreshTokens = (matchedUser.refreshTokens || []).filter((s) => s.token !== dto.refreshToken);
      await this.saveUser(matchedUser);
      throw new UnauthorizedException('Your session has expired. Please log in again.');
    }

    // Issue a fresh 30-day stateless access token
    const accessToken = UserJwtUtil.sign(
      {
        sub: matchedUser.username,
        username: matchedUser.username,
        role: matchedUser.role || 'admin',
      },
      30 * 24 * 60 * 60,
    );

    return {
      accessToken,
      user: {
        username: matchedUser.username,
        role: matchedUser.role || 'admin',
      },
    };
  }

  /**
   * Revokes a session on logout.
   */
  public async logout(refreshToken?: string) {
    if (refreshToken) {
      // 1. Search in-memory cache first to avoid unnecessary Firestore collection scans
      let foundUser: StoredUserDoc | null = null;
      for (const u of this.inMemoryUsers.values()) {
        const hasToken = (u.refreshTokens || []).some((s) => s.token === refreshToken);
        if (hasToken) {
          foundUser = u;
          break;
        }
      }

      if (foundUser) {
        foundUser.refreshTokens = (foundUser.refreshTokens || []).filter((s) => s.token !== refreshToken);
        await this.saveUser(foundUser);
        return { success: true, message: 'Logged out successfully' };
      }

      // 2. If not found in memory, query Firestore
      if (this.firestoreService.isReady()) {
        try {
          const docs = await this.firestoreService.listDocuments('users', 100);
          for (const { data } of docs) {
            const docId = (data.username || data.id || '').toLowerCase();
            if (docId) this.inMemoryUsers.set(docId, data as StoredUserDoc);
            const hasToken = ((data as StoredUserDoc).refreshTokens || []).some((s) => s.token === refreshToken);
            if (hasToken) {
              const updatedUser = data as StoredUserDoc;
              updatedUser.refreshTokens = (updatedUser.refreshTokens || []).filter((s) => s.token !== refreshToken);
              await this.saveUser(updatedUser);
              break;
            }
          }
        } catch (err: any) {
          this.logger.warn(`Could not remove refresh token from Firestore during logout: ${err.message}`);
        }
      }
    }
    return { success: true, message: 'Logged out successfully' };
  }

  /**
   * Changes password for currently authenticated user.
   */
  public async changePassword(username: string, dto: ChangePasswordDto) {
    const user = await this.getUser(username, true);
    if (!user) {
      throw new BadRequestException('User record not found');
    }

    if (dto.currentPassword) {
      if (!PasswordUtil.verifyPassword(dto.currentPassword, user.passwordHash)) {
        throw new BadRequestException('Current password is incorrect');
      }
    }

    user.passwordHash = PasswordUtil.hashPassword(dto.newPassword);
    user.updatedAt = new Date().toISOString();
    await this.saveUser(user);

    return { success: true, message: 'Password updated successfully' };
  }

  /**
   * List all active sessions for a user, sorted newest first.
   */
  public async listUserSessions(username: string, currentRefreshToken?: string): Promise<ActiveSessionDto[]> {
    const user = await this.getUser(username);
    if (!user) {
      throw new NotFoundException(`User '${username}' not found`);
    }

    const now = Date.now();
    const rawTokens = user.refreshTokens || [];
    const validTokens = rawTokens.filter((t) => new Date(t.expiresAt).getTime() > now);

    // If any expired tokens were pruned, persist updated user doc
    if (validTokens.length !== rawTokens.length) {
      user.refreshTokens = validTokens;
      await this.saveUser(user);
    }

    // Sort newest first
    const sorted = [...validTokens].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    return sorted.map((t) => {
      const parsedUa = parseUserAgent(t.userAgent);
      return {
        id: UserAuthService.getSessionId(t),
        username: user.username,
        userAgent: t.userAgent || 'Web Browser',
        browser: parsedUa.browser,
        os: parsedUa.os,
        deviceType: parsedUa.deviceType,
        ip: t.ip || '127.0.0.1',
        createdAt: t.createdAt,
        expiresAt: t.expiresAt,
        isCurrent: currentRefreshToken ? t.token === currentRefreshToken : false,
      };
    });
  }

  /**
   * Revoke/kill a specific active session by its sessionId.
   */
  public async revokeSession(username: string, sessionId: string): Promise<{ success: boolean; message: string }> {
    const user = await this.getUser(username);
    if (!user) {
      throw new NotFoundException(`User '${username}' not found`);
    }

    const rawTokens = user.refreshTokens || [];
    const target = rawTokens.find((t) => UserAuthService.getSessionId(t) === sessionId);
    if (!target) {
      throw new NotFoundException('Session not found or already terminated');
    }

    user.refreshTokens = rawTokens.filter((t) => UserAuthService.getSessionId(t) !== sessionId);
    await this.saveUser(user);
    this.logger.log(`🚫 Session [${sessionId}] terminated for user '${user.username}'`);

    return {
      success: true,
      message: 'Active session terminated successfully',
    };
  }

  /**
   * Revoke/kill all other active sessions for a user (preserving current session).
   */
  public async revokeOtherSessions(
    username: string,
    currentRefreshToken: string,
  ): Promise<{ success: boolean; message: string; revokedCount: number }> {
    const user = await this.getUser(username);
    if (!user) {
      throw new NotFoundException(`User '${username}' not found`);
    }

    const rawTokens = user.refreshTokens || [];
    const keepSession = rawTokens.find((t) => t.token === currentRefreshToken);
    const initialCount = rawTokens.length;

    user.refreshTokens = keepSession ? [keepSession] : [];
    const revokedCount = initialCount - user.refreshTokens.length;

    await this.saveUser(user);
    this.logger.log(`🚫 Revoked ${revokedCount} other session(s) for user '${user.username}'`);

    return {
      success: true,
      message: `${revokedCount} other session(s) terminated successfully`,
      revokedCount,
    };
  }

  /**
   * Revoke/kill all active sessions for a user.
   */
  public async revokeAllSessionsForUser(
    username: string,
  ): Promise<{ success: boolean; message: string; revokedCount: number }> {
    const user = await this.getUser(username);
    if (!user) {
      throw new NotFoundException(`User '${username}' not found`);
    }

    const revokedCount = (user.refreshTokens || []).length;
    user.refreshTokens = [];
    await this.saveUser(user);
    this.logger.log(`🚫 Revoked all ${revokedCount} active session(s) for user '${user.username}'`);

    return {
      success: true,
      message: `All ${revokedCount} active session(s) terminated successfully for '${user.username}'`,
      revokedCount,
    };
  }

  /**
   * List all active sessions across all users in the system - restricted to superuser 'sarang'.
   */
  public async listAllActiveSessions(currentRefreshToken?: string): Promise<ActiveSessionDto[]> {
    const users = await this.listUsers();
    const all: ActiveSessionDto[] = [];
    for (const u of users) {
      try {
        const userSessions = await this.listUserSessions(u.username, currentRefreshToken);
        all.push(...userSessions);
      } catch {
        // Ignore errors for individual user fetch
      }
    }
    return all.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }
}
