import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert';
import { UserAuthService } from '../src/user-auth/user-auth.service';
import { PasswordUtil } from '../src/user-auth/utils/password.util';
import { UserJwtUtil } from '../src/user-auth/utils/user-jwt.util';
import { UserRole } from '../src/user-auth/dto/create-user.dto';

test('PasswordUtil & UserJwtUtil', async (t) => {
  await t.test('PasswordUtil securely hashes and verifies passwords using scrypt', () => {
    const pwd = 'secretPassword123';
    const hash = PasswordUtil.hashPassword(pwd);

    assert.ok(hash.startsWith('scrypt:'));
    assert.strictEqual(PasswordUtil.verifyPassword(pwd, hash), true);
    assert.strictEqual(PasswordUtil.verifyPassword('wrongPassword', hash), false);
    assert.strictEqual(PasswordUtil.verifyPassword('', hash), false);
  });

  await t.test('UserJwtUtil signs, validates, and expires HS256 tokens', () => {
    const token = UserJwtUtil.sign({ sub: 'sarang', username: 'sarang', role: 'admin' }, 60);
    assert.ok(typeof token === 'string');
    assert.strictEqual(token.split('.').length, 3);

    const payload = UserJwtUtil.verify(token);
    assert.ok(payload);
    assert.strictEqual(payload?.username, 'sarang');
    assert.strictEqual(payload?.role, 'admin');

    // Tampered token fails
    const tampered = token.slice(0, -4) + 'abcd';
    assert.strictEqual(UserJwtUtil.verify(tampered), null);

    // Expired token fails
    const expiredToken = UserJwtUtil.sign({ sub: 'sarang', username: 'sarang', role: 'admin' }, -10);
    assert.strictEqual(UserJwtUtil.verify(expiredToken), null);
  });
});

test('UserAuthService (NestJS)', async (t) => {
  let inMemoryDb: Record<string, any> = {};

  const mockFirestoreService: any = {
    isReady: () => true,
    getDoc: async (collection: string, docId: string) => {
      return inMemoryDb[`${collection}/${docId}`] || null;
    },
    setDoc: async (collection: string, docId: string, data: any, merge: boolean) => {
      const key = `${collection}/${docId}`;
      if (merge && inMemoryDb[key]) {
        inMemoryDb[key] = { ...inMemoryDb[key], ...data };
      } else {
        inMemoryDb[key] = { ...data };
      }
      return { success: true, writeTime: new Date().toISOString() };
    },
    deleteDoc: async (collection: string, docId: string) => {
      delete inMemoryDb[`${collection}/${docId}`];
      return { success: true };
    },
    listDocuments: async (collection: string) => {
      const prefix = `${collection}/`;
      return Object.entries(inMemoryDb)
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, data]) => ({ id: k.replace(prefix, ''), data }));
    },
  };

  const service = new UserAuthService(mockFirestoreService);
  await service.onModuleInit();

  await t.test('auto-seeds superuser sarang and admin in Firestore if absent', async () => {
    const sarang = await service.getUser('sarang');
    assert.ok(sarang);
    assert.strictEqual(sarang?.username, 'sarang');
    assert.strictEqual(sarang?.role, 'admin');
    assert.ok(sarang?.passwordHash.startsWith('scrypt:'));
    assert.strictEqual(PasswordUtil.verifyPassword('admin123', sarang?.passwordHash!), true);

    const admin = await service.getUser('admin');
    assert.ok(admin);
    assert.strictEqual(admin?.username, 'admin');
  });

  await t.test('authenticates valid credentials for sarang and admin', async () => {
    const res = await service.login({ username: 'sarang', password: 'admin123' }, 'Mozilla/5.0');
    assert.ok(res.accessToken);
    assert.ok(res.refreshToken);
    assert.strictEqual(res.user.username, 'sarang');

    const decoded = UserJwtUtil.verify(res.accessToken);
    assert.strictEqual(decoded?.username, 'sarang');
  });

  await t.test('rejects invalid password', async () => {
    await assert.rejects(
      async () => service.login({ username: 'sarang', password: 'wrongPassword' }),
      /Invalid username or password/,
    );
  });

  await t.test('refreshes access token with valid refresh token', async () => {
    const loginRes = await service.login({ username: 'sarang', password: 'admin123' });
    const refreshRes = await service.refreshToken({ refreshToken: loginRes.refreshToken });

    assert.ok(refreshRes.accessToken);
    assert.strictEqual(refreshRes.user.username, 'sarang');
  });

  await t.test('rejects revoked refresh token', async () => {
    const loginRes = await service.login({ username: 'sarang', password: 'admin123' });
    await service.logout(loginRes.refreshToken);

    await assert.rejects(
      async () => service.refreshToken({ refreshToken: loginRes.refreshToken }),
      /Invalid or expired refresh token/,
    );
  });

  await t.test('changes password successfully', async () => {
    // 1. Change password with current password verified
    await service.changePassword('sarang', { currentPassword: 'admin123', newPassword: 'tempPassword' });

    // Login with old password fails
    await assert.rejects(
      async () => service.login({ username: 'sarang', password: 'admin123' }),
      /Invalid username or password/,
    );

    // 2. Change password directly to newSarangPassword2026 without current password
    await service.changePassword('sarang', { newPassword: 'newSarangPassword2026' });

    // Login with new password succeeds
    const newLogin = await service.login({ username: 'sarang', password: 'newSarangPassword2026' });
    assert.ok(newLogin.accessToken);
  });

  await t.test('User CRUD: create, list, update, and delete users', async () => {
    // 1. Create a new user
    const createRes = await service.createUser({
      username: 'amit_trader',
      password: 'password123',
      role: UserRole.TRADER,
    });
    assert.strictEqual(createRes.success, true);
    assert.strictEqual(createRes.user.username, 'amit_trader');
    assert.strictEqual(createRes.user.role, 'trader');

    // Duplicate create fails
    await assert.rejects(
      async () => service.createUser({ username: 'amit_trader', password: 'pwd' }),
      /already exists/,
    );

    // 2. List users
    const users = await service.listUsers();
    assert.ok(users.length >= 2);
    const createdUser = users.find((u) => u.username === 'amit_trader');
    assert.ok(createdUser);
    assert.strictEqual(createdUser?.role, 'trader');
    // Ensure passwordHash is never leaked
    assert.strictEqual((createdUser as any).passwordHash, undefined);

    // 3. Update user
    await service.updateUser('amit_trader', { role: UserRole.ADMIN, password: 'newPassword321' });
    const updatedUser = await service.getUser('amit_trader');
    assert.strictEqual(updatedUser?.role, 'admin');
    assert.strictEqual(PasswordUtil.verifyPassword('newPassword321', updatedUser?.passwordHash!), true);

    // 4. Delete user
    const delRes = await service.deleteUser('amit_trader');
    assert.strictEqual(delRes.success, true);
    const deletedCheck = await service.getUser('amit_trader');
    assert.strictEqual(deletedCheck, null);

    // 5. Deleting superuser sarang is prevented
    await assert.rejects(
      async () => service.deleteUser('sarang'),
      /Cannot delete superuser account sarang/,
    );
  });

  await t.test('Active sessions: list sessions, mark current session, kill session, kill other sessions', async () => {
    // 1. Create multiple sessions for sarang (whose password was updated to 'newSarangPassword2026')
    const pwd = 'newSarangPassword2026';
    const login1 = await service.login({ username: 'sarang', password: pwd }, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36', '192.168.1.5');
    const login2 = await service.login({ username: 'sarang', password: pwd }, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1', '192.168.1.10');
    const login3 = await service.login({ username: 'sarang', password: pwd }, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/121.0', '192.168.1.15');

    // 2. List sessions
    const sessions = await service.listUserSessions('sarang', login2.refreshToken);
    assert.strictEqual(sessions.length >= 3, true);

    const currentSession = sessions.find((s) => s.isCurrent);
    assert.ok(currentSession);
    assert.strictEqual(currentSession?.deviceType, 'Mobile');
    assert.strictEqual(currentSession?.os, 'iOS');
    assert.strictEqual(currentSession?.browser, 'Safari');

    // 3. Kill specific session (login3)
    const session3 = sessions.find((s) => s.os === 'Windows');
    assert.ok(session3);
    const killRes = await service.revokeSession('sarang', session3!.id);
    assert.strictEqual(killRes.success, true);

    const afterKill = await service.listUserSessions('sarang');
    assert.strictEqual(afterKill.some((s) => s.id === session3!.id), false);

    // 4. Kill other sessions (keeping login2)
    const revokeOthersRes = await service.revokeOtherSessions('sarang', login2.refreshToken);
    assert.ok(revokeOthersRes.revokedCount >= 1);

    const finalSessions = await service.listUserSessions('sarang');
    assert.strictEqual(finalSessions.length, 1);
    assert.strictEqual(finalSessions[0].id, currentSession!.id);

    // 5. Kill all sessions
    const killAllRes = await service.revokeAllSessionsForUser('sarang');
    assert.strictEqual(killAllRes.revokedCount, 1);
    const emptySessions = await service.listUserSessions('sarang');
    assert.strictEqual(emptySessions.length, 0);

    // 6. Test listAllActiveSessions
    await service.login({ username: 'admin', password: 'admin123' }, 'Chrome/Windows');
    const all = await service.listAllActiveSessions();
    assert.ok(Array.isArray(all));
    assert.ok(all.some((s) => s.username === 'admin'));
  });

  await t.test('deleting admin user permanently removes it and initUsers does not resurrect it in Firestore', async () => {
    // 1. Delete admin user
    const delRes = await service.deleteUser('admin');
    assert.strictEqual(delRes.success, true);

    // 2. getUser('admin') must return null
    const checkAfterDelete = await service.getUser('admin');
    assert.strictEqual(checkAfterDelete, null);

    // 3. Document in Firestore must not exist
    const adminDoc = await mockFirestoreService.getDoc('users', 'admin');
    assert.strictEqual(adminDoc, null);

    // 4. Simulate server restart / cold-start by calling initUsers() again
    await service.initUsers();

    // 5. Admin must NOT be resurrected in Firestore or in-memory cache
    const checkAfterRestart = await service.getUser('admin');
    assert.strictEqual(checkAfterRestart, null);

    const docAfterRestart = await mockFirestoreService.getDoc('users', 'admin');
    assert.strictEqual(docAfterRestart, null);

    const users = await service.listUsers();
    assert.strictEqual(users.some((u) => u.username === 'admin'), false);
  });
});
