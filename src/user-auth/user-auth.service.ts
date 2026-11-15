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

  private readonly defaultAdminUsername = process.env.ADMIN_USERNAME || 'admin';
  private readonly defaultAdminPassword = process.env.ADMIN_PASSWORD || 'admin123';

  constructor(private readonly firestoreService: FirestoreService) {
    this.seedInMemoryDefaults();
  }

  private seedInMemoryDefaults() {
    const now = new Date().toISOString();
    // Default sarang superuser
    this.inMemoryUsers.set('sarang', {
      username: 'sarang',
      passwordHash: PasswordUtil.hashPassword('admin123'),
      role: UserRole.ADMIN,
      refreshTokens: [],
      createdAt: now,
      updatedAt: now,
    });
    // Default admin user
    this.inMemoryUsers.set(this.defaultAdminUsername.toLowerCase(), {
      username: this.defaultAdminUsername,
      passwordHash: PasswordUtil.hashPassword(this.defaultAdminPassword),
      role: UserRole.ADMIN,
      refreshTokens: [],
      createdAt: now,
      updatedAt: now,
    });
  }

  async onModuleInit() {
    await this.initUsers();
  }

  /**
   * Initializes superuser 'sarang' and default 'admin' in Firestore collection 'users'.
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
      const isInitialSetup = !sarangDoc || !sarangDoc.passwordHash;
      if (isInitialSetup) {
        const sarangUser: StoredUserDoc = {
          username: 'sarang',
          passwordHash: PasswordUtil.hashPassword(process.env.SARANG_PASSWORD || 'admin123'),
          role: UserRole.ADMIN,
          refreshTokens: [],
          createdAt: now,
          updatedAt: now,
        };
        await this.firestoreService.setDoc('users', 'sarang', sarangUser, true);
        this.logger.log(`🔐 Auto-seeded superuser [sarang] in Firestore (users/sarang)`);
      }

      // 2. Default 'admin' user initialization:
      // Only seed 'admin' during the initial system setup if it does not already exist.
      // Once the system is initialized (sarang exists), if 'admin' is absent,
      // it means it was deleted by the user! Never resurrect deleted users.
      const adminDocId = this.defaultAdminUsername.toLowerCase();
      const adminDoc = await this.firestoreService.getDoc<StoredUserDoc>('users', adminDocId);
      if (isInitialSetup && (!adminDoc || !adminDoc.passwordHash)) {
        // Check if legacy config/auth_user exists to preserve password
        const legacyAuth = await this.firestoreService.getDoc<StoredUserDoc>('config', 'auth_user');
        const adminUser: StoredUserDoc = {
          username: this.defaultAdminUsername,
          passwordHash: legacyAuth?.passwordHash || PasswordUtil.hashPassword(this.defaultAdminPassword),
          role: UserRole.ADMIN,
          refreshTokens: legacyAuth?.refreshTokens || [],
          createdAt: legacyAuth?.createdAt || now,
          updatedAt: now,
        };
        await this.firestoreService.setDoc('users', adminDocId, adminUser, true);
        if (legacyAuth) {
          try {
            await this.firestoreService.deleteDoc('config', 'auth_user');
          } catch (e: any) {
            this.logger.warn(`Could not clean up legacy config/auth_user: ${e.message}`);
          }
        }
        this.logger.log(`👤 Initialized admin user [${this.defaultAdminUsername}] in Firestore (users/${adminDocId})`);
      } else if (!adminDoc) {
        // If adminDoc does not exist in Firestore on an already initialized system,
        // ensure in-memory cache drops it too so it stays deleted across restarts.
        this.inMemoryUsers.delete(adminDocId);
        // Also ensure any lingering legacy config/auth_user is purged
        try {
          await this.firestoreService.deleteDoc('config', 'auth_user');
        } catch {
          // ignore
        }
      }
    } catch (err: any) {
      this.logger.warn(`Could not initialize users in Firestore: ${err.message}`);
    }
  }

  /**
   * Retrieves user document from Firestore 'users' collection or in-memory fallback.
   */
  public async getUser(username: string): Promise<StoredUserDoc | null> {
    const docId = (username || '').trim().toLowerCase();
    if (!docId) return null;

    if (this.firestoreService.isReady()) {
      try {
        const user = await this.firestoreService.getDoc<StoredUserDoc>('users', docId);
        if (user) return user;

        // When Firestore is connected and ready, if document is not in 'users', user does not exist.
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
          return docs.map(({ data }) => ({
            username: data.username || data.id,
            role: data.role || UserRole.TRADER,
            createdAt: data.createdAt || new Date().toISOString(),
            updatedAt: data.updatedAt || new Date().toISOString(),
            sessionCount: (data.refreshTokens || []).length,
          }));
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
      if (docId === this.defaultAdminUsername.toLowerCase()) {
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

    const user = await this.getUser(cleanUsername);
    if (!user) {
      throw new UnauthorizedException('Invalid username or password');
    }

    const passwordMatch = PasswordUtil.verifyPassword(cleanPassword, user.passwordHash);
    if (!passwordMatch) {
      throw new UnauthorizedException('Invalid username or password');
    }

    // 15-minute access token
    const accessToken = UserJwtUtil.sign(
      {
        sub: user.username,
        username: user.username,
        role: user.role || 'admin',
      },
      900,
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

    // Search in Firestore
    if (this.firestoreService.isReady()) {
      try {
        const docs = await this.firestoreService.listDocuments('users', 100);
        for (const { data } of docs) {
          const session = (data.refreshTokens || []).find((s: StoredRefreshToken) => s.token === dto.refreshToken);
          if (session) {
            matchedUser = data as StoredUserDoc;
            matchedSession = session;
            break;
          }
        }
      } catch (err: any) {
        this.logger.warn(`Could not search refresh token in Firestore: ${err.message}`);
      }
    } else {
      // Fallback to in-memory ONLY when Firestore is not ready
      for (const u of this.inMemoryUsers.values()) {
        const session = (u.refreshTokens || []).find((s) => s.token === dto.refreshToken);
        if (session) {
          matchedUser = u;
          matchedSession = session;
          break;
        }
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

    // Issue a fresh 15-minute access token
    const accessToken = UserJwtUtil.sign(
      {
        sub: matchedUser.username,
        username: matchedUser.username,
        role: matchedUser.role || 'admin',
      },
      900,
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
      // 1. If Firestore is ready, find and update user document in Firestore
      if (this.firestoreService.isReady()) {
        try {
          const docs = await this.firestoreService.listDocuments('users', 100);
          for (const { data } of docs) {
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

      // 2. Also remove from in-memory cache
      for (const u of this.inMemoryUsers.values()) {
        const hasToken = (u.refreshTokens || []).some((s) => s.token === refreshToken);
        if (hasToken) {
          u.refreshTokens = u.refreshTokens?.filter((s) => s.token !== refreshToken);
          if (!this.firestoreService.isReady()) {
            await this.saveUser(u);
          }
          break;
        }
      }
    }
    return { success: true, message: 'Logged out successfully' };
  }

  /**
   * Changes password for currently authenticated user.
   */
  public async changePassword(username: string, dto: ChangePasswordDto) {
    const user = await this.getUser(username);
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
   * Retrieves profile of current user.
   */
  public async getProfile(username: string) {
    const user = await this.getUser(username);
    return {
      username: user?.username || username,
      role: user?.role || 'admin',
    };
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
