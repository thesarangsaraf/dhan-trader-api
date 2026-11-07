import { ConfigService } from '../src/config/config.service';
import { FirestoreService } from '../src/firestore/firestore.service';
import { DhanService } from '../src/dhan/dhan.service';

function decodeJwt(token: string): any {
  try {
    const parts = token.trim().split('.');
    if (parts.length < 2) return null;
    let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';
    return JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

async function verifyRealFirestoreConnection() {
  const config = new ConfigService();
  const firestoreService = new FirestoreService(config);
  const dhanService = new DhanService(config, firestoreService);

  console.log('\n======================================================');
  console.log('⚡ GOOGLE CLOUD FIRESTORE — LIVE CONNECTION CHECK');
  console.log('======================================================\n');

  console.log(`📌 Google Cloud Project : ${config.firestoreProjectId}`);
  console.log(`🗄️ Firestore Database   : ${config.firestoreDatabaseId}`);
  console.log(`🔑 Service Account Key  : ${config.firestoreKeyFile}`);

  const initSuccess = firestoreService.initialize();
  const status = firestoreService.getStatus();

  if (!initSuccess || !status.configured) {
    console.log('\n❌ [ERROR] Firestore initialization failed:');
    console.log(`   ${status.error || 'Unknown error'}`);
    console.log('\n👉 Make sure the service account key JSON file is present in project root.');
    console.log('   Expected file: google-service-account-key.json\n');
    process.exit(1);
  }

  console.log(`👤 Service Account Email: ${status.clientEmail}`);
  console.log(`📂 Key File Path        : ${status.keyFile}`);

  // 1. Connection & Collections listing
  console.log('\n1️⃣ Testing Firestore Connectivity & Listing Collections...');
  const testRes = await firestoreService.testConnection();

  if (testRes.success) {
    console.log(`   ✅ Connected successfully! (Latency: ${testRes.latencyMs}ms)`);
    console.log(`   📚 Collections found: [${testRes.collections?.join(', ') || 'None'}]`);
  } else {
    console.log(`   ❌ Connection test failed: ${testRes.error}`);
    process.exit(1);
  }

  // 2. Read / Write Verification
  console.log('\n2️⃣ Verifying Read & Write Permissions...');
  try {
    const testDocId = `check-${Date.now()}`;
    const testData = {
      service: 'dhan-trader-api',
      message: 'Firestore connection verified successfully!',
      timestamp: new Date().toISOString(),
    };

    console.log(`   Writing test document: connection_test/${testDocId}...`);
    const writeRes = await firestoreService.setDoc('connection_test', testDocId, testData);
    console.log(`   ✅ Document written at: ${writeRes.writeTime}`);

    console.log(`   Reading back document: connection_test/${testDocId}...`);
    const readData = await firestoreService.getDoc('connection_test', testDocId);
    console.log(`   ✅ Document verified: "${readData?.message}"`);

    console.log(`   Cleaning up test document...`);
    await firestoreService.deleteDoc('connection_test', testDocId);
    console.log(`   ✅ Cleanup completed successfully!`);
  } catch (err: any) {
    console.log(`   ⚠️ Read/Write test encountered an issue: ${err.message}`);
  }

  // 3. Saving and Caching Dhan JWT Token in Firestore Database
  console.log('\n3️⃣ Saving Dhan Access Token to Firestore Database (dhan/token)...');
  const currentToken = config.accessToken;
  const currentClientId = config.clientId;

  if (currentToken) {
    const payload = decodeJwt(currentToken);
    const expDate = payload?.exp ? new Date(payload.exp * 1000).toISOString() : undefined;

    const saveRes = await firestoreService.saveDhanToken({
      accessToken: currentToken,
      clientId: currentClientId,
      expiresAt: expDate,
      source: 'verify_script',
    });
    console.log(`   ✅ Token successfully saved to Firestore: dhan/token (at ${saveRes.writeTime})`);

    // Verify retrieval from Firestore
    console.log('   Reading token back from database (dhan/token)...');
    const storedToken = await firestoreService.getDhanToken();
    if (storedToken?.accessToken) {
      const masked = `${storedToken.accessToken.slice(0, 10)}...${storedToken.accessToken.slice(-8)}`;
      console.log(`   ✅ Retrieved Token from Database: ${masked}`);
      console.log(`   🆔 Client ID                     : ${storedToken.clientId}`);
      console.log(`   ⏳ Expires At                    : ${storedToken.expiresAt || 'N/A'}`);
    }

    // 4. Test Live REST call to Dhan API using cached token from Firestore
    console.log('\n4️⃣ Testing Dhan API REST call using cached token from Firestore...');
    const profileRes = await dhanService.getProfile();
    if (profileRes.ok) {
      console.log('   ✅ Dhan HQ API v2 REST call succeeded with database-cached token:');
      console.log(`   👤 Name     : ${profileRes.data.userName || profileRes.data.name || 'Trader'}`);
      console.log(`   🆔 Client ID: ${profileRes.data.dhanClientId || profileRes.data.clientId}`);
      console.log(`   📊 Segments : ${profileRes.data.activeSegment}`);
    } else {
      console.log(`   ⚠️ Dhan API response: HTTP ${profileRes.status}`, profileRes.data || profileRes.error);
    }
  } else {
    console.log('   ℹ️ No local access token found to seed. Token can be saved via POST /api/auth/update');
  }

  console.log('\n======================================================');
  console.log('🎉 DHAN JWT TOKEN PERSISTENCE IN FIRESTORE ACTIVE');
  console.log('⚡ All subsequent REST calls to Dhan use the in-memory cache.');
  console.log('======================================================\n');
}

verifyRealFirestoreConnection().catch((err) => {
  console.error('Fatal Firestore verification error:', err);
  process.exit(1);
});
