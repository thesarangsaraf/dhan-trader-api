import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { Firestore, CollectionReference, DocumentReference } from '@google-cloud/firestore';
import { JWT } from 'google-auth-library';
import { ConfigService } from '../config/config.service';

export interface FirestoreStatus {
  configured: boolean;
  projectId: string;
  databaseId: string;
  keyFile: string;
  keyFileFound: boolean;
  clientEmail?: string;
  error?: string | null;
}

export interface StoredDhanToken {
  accessToken: string;
  clientId: string;
  updatedAt: string;
  expiresAt?: string;
  expiresAtIST?: string;
  issuedAtIST?: string;
  userName?: string;
  status?: string;
  source?: string;
}

export interface FirestoreTestResult {
  success: boolean;
  message: string;
  projectId: string;
  databaseId: string;
  latencyMs?: number;
  collections?: string[];
  error?: string;
}

@Injectable()
export class FirestoreService implements OnModuleInit {
  private readonly logger = new Logger(FirestoreService.name);
  private db: Firestore | null = null;
  private clientEmail: string | null = null;
  private keyFilePath: string | null = null;
  private keyFileFound = false;
  private initError: string | null = null;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.initialize();
  }

  /**
   * Initializes connection to Google Cloud Firestore with the configured service account.
   */
  public initialize(): boolean {
    try {
      const projectId = this.config.firestoreProjectId || 'dhan-trader-514002';
      const databaseId = this.config.firestoreDatabaseId || 'dhan-trader-firebase-db';
      const keyFileConfig = this.config.firestoreKeyFile || 'google-service-account-key.json';

      // 1. Resolve key file path across common locations
      const candidatePaths = [
        path.isAbsolute(keyFileConfig) ? keyFileConfig : path.resolve(process.cwd(), keyFileConfig),
        path.resolve(__dirname, '..', '..', keyFileConfig),
        path.resolve(__dirname, '..', '..', 'google-service-account-key.json'),
      ];

      if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        candidatePaths.unshift(process.env.GOOGLE_APPLICATION_CREDENTIALS);
      }

      let foundPath: string | null = null;
      for (const p of candidatePaths) {
        if (fs.existsSync(p)) {
          foundPath = p;
          break;
        }
      }

      this.keyFilePath = foundPath || candidatePaths[0];
      this.keyFileFound = !!foundPath;

      if (!foundPath) {
        this.initError = `Service account key file not found at: ${this.keyFilePath}`;
        this.logger.warn(`Firestore not initialized: ${this.initError}`);
        return false;
      }

      // 2. Read and parse service account credentials
      const keyJson = JSON.parse(fs.readFileSync(foundPath, 'utf8'));
      if (!keyJson.client_email || !keyJson.private_key) {
        this.initError = 'Service account JSON is missing client_email or private_key';
        this.logger.error(`Firestore initialization failed: ${this.initError}`);
        return false;
      }

      this.clientEmail = keyJson.client_email;
      const actualProjectId = keyJson.project_id || projectId;

      // 3. Create Google Auth JWT client (clean, modern authentication without deprecation warnings)
      const authClient = new JWT({
        email: keyJson.client_email,
        key: keyJson.private_key,
        scopes: [
          'https://www.googleapis.com/auth/cloud-platform',
          'https://www.googleapis.com/auth/datastore',
        ],
      });

      // 4. Initialize Firestore instance pointing to project and named database
      this.db = new Firestore({
        projectId: actualProjectId,
        databaseId: databaseId,
        authClient: authClient,
        ignoreUndefinedProperties: true,
      });

      this.initError = null;
      this.logger.log(
        `✅ Google Cloud Firestore connected (Project: ${actualProjectId}, Database: ${databaseId}, ServiceAccount: ${this.clientEmail})`,
      );
      return true;
    } catch (err: any) {
      this.initError = err.message || String(err);
      this.logger.error(`Failed to initialize Google Firestore: ${this.initError}`, err.stack);
      return false;
    }
  }

  /**
   * Directly set or override Firestore instance (useful for unit testing/mocking).
   */
  public setFirestoreInstance(instance: Firestore | null) {
    this.db = instance;
    this.initError = null;
  }

  /**
   * Check whether Firestore client is initialized and ready.
   */
  public isReady(): boolean {
    return this.db !== null;
  }

  /**
   * Retrieve the active Firestore client instance.
   */
  public getDb(): Firestore {
    if (!this.db) {
      throw new Error(
        `Firestore is not initialized. Error: ${this.initError || 'No active connection'}. Check service account credentials.`,
      );
    }
    return this.db;
  }

  /**
   * Returns current Firestore connection metadata and health state.
   */
  public getStatus(): FirestoreStatus {
    return {
      configured: this.isReady(),
      projectId: this.config.firestoreProjectId || 'dhan-trader-514002',
      databaseId: this.config.firestoreDatabaseId || 'dhan-trader-firebase-db',
      keyFile: this.keyFilePath || this.config.firestoreKeyFile,
      keyFileFound: this.keyFileFound,
      clientEmail: this.clientEmail || undefined,
      error: this.initError,
    };
  }

  /**
   * Execute a live connectivity test against Firestore.
   */
  public async testConnection(): Promise<FirestoreTestResult> {
    const projectId = this.config.firestoreProjectId || 'dhan-trader-514002';
    const databaseId = this.config.firestoreDatabaseId || 'dhan-trader-firebase-db';

    if (!this.db) {
      return {
        success: false,
        message: 'Firestore client is not initialized',
        projectId,
        databaseId,
        error: this.initError || 'Credentials missing or invalid',
      };
    }

    const start = Date.now();
    try {
      const collections = await this.db.listCollections();
      const latencyMs = Date.now() - start;
      const collectionNames = collections.map((col) => col.id);

      return {
        success: true,
        message: `Successfully connected to Firestore database [${databaseId}] in project [${projectId}]`,
        projectId,
        databaseId,
        latencyMs,
        collections: collectionNames,
      };
    } catch (err: any) {
      const latencyMs = Date.now() - start;
      return {
        success: false,
        message: `Failed to communicate with Firestore database [${databaseId}]`,
        projectId,
        databaseId,
        latencyMs,
        error: err.message || String(err),
      };
    }
  }

  /**
   * Helper: Retrieve Dhan access token document from Firestore database (dhan/token).
   */
  public async getDhanToken(): Promise<StoredDhanToken | null> {
    if (!this.isReady()) {
      return null;
    }
    const token = await this.getDoc<StoredDhanToken>('dhan', 'token');
    if (token) return token;

    // Fallback migration check for legacy path (tokens/dhan)
    const legacyToken = await this.getDoc<StoredDhanToken>('tokens', 'dhan');
    if (legacyToken) {
      await this.setDoc('dhan', 'token', legacyToken, true);
      await this.deleteDoc('tokens', 'dhan').catch(() => {});
      return legacyToken;
    }
    return null;
  }

  /**
   * Helper: Save or update Dhan access token in Firestore database (dhan/token).
   */
  public async saveDhanToken(
    tokenData: Partial<StoredDhanToken> & { accessToken: string; clientId: string },
  ): Promise<{ success: boolean; writeTime: string }> {
    const payload: Record<string, any> = {
      accessToken: tokenData.accessToken,
      clientId: tokenData.clientId,
      updatedAt: tokenData.updatedAt || new Date().toISOString(),
      status: tokenData.status || 'ACTIVE',
      source: tokenData.source || 'dhan',
    };
    if (tokenData.expiresAt) payload.expiresAt = tokenData.expiresAt;
    if (tokenData.expiresAtIST) payload.expiresAtIST = tokenData.expiresAtIST;
    if (tokenData.issuedAtIST) payload.issuedAtIST = tokenData.issuedAtIST;
    if (tokenData.userName) payload.userName = tokenData.userName;

    return this.setDoc('dhan', 'token', payload, true);
  }

  /**
   * Helper: Get a reference to a Firestore collection.
   */
  public collection(collectionName: string): CollectionReference {
    return this.getDb().collection(collectionName);
  }

  /**
   * Helper: Get a reference to a specific document.
   */
  public doc(collectionName: string, docId: string): DocumentReference {
    return this.getDb().collection(collectionName).doc(docId);
  }

  /**
   * Helper: Retrieve a document by ID.
   */
  public async getDoc<T = any>(collectionName: string, docId: string): Promise<T | null> {
    const snapshot = await this.doc(collectionName, docId).get();
    if (!snapshot.exists) {
      return null;
    }
    return snapshot.data() as T;
  }

  /**
   * Helper: Write or update a document by ID.
   */
  public async setDoc<T = Record<string, any>>(
    collectionName: string,
    docId: string,
    data: T,
    merge = true,
  ): Promise<{ success: boolean; writeTime: string }> {
    const res = await this.doc(collectionName, docId).set(data as any, { merge });
    return {
      success: true,
      writeTime: res.writeTime.toDate().toISOString(),
    };
  }

  /**
   * Helper: Delete a document by ID.
   */
  public async deleteDoc(collectionName: string, docId: string): Promise<{ success: boolean }> {
    await this.doc(collectionName, docId).delete();
    return { success: true };
  }

  /**
   * Helper: List documents in a collection with an optional limit.
   */
  public async listDocuments(
    collectionName: string,
    limit = 50,
  ): Promise<Array<{ id: string; data: any }>> {
    const snapshot = await this.collection(collectionName).limit(limit).get();
    return snapshot.docs.map((docSnap) => ({
      id: docSnap.id,
      data: docSnap.data(),
    }));
  }
}
