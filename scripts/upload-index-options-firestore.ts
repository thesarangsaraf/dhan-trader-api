import * as fs from 'fs';
import * as path from 'path';
import { ConfigService } from '../src/config/config.service';
import { FirestoreService, CachedIndexOption } from '../src/firestore/firestore.service';

async function uploadIndexOptionsToFirestore() {
  console.log('\n======================================================');
  console.log('🚀 UPLOADING NSE INDEX OPTIONS TO GOOGLE CLOUD FIRESTORE');
  console.log('======================================================\n');

  const config = new ConfigService();
  const firestoreService = new FirestoreService(config);

  console.log(`📌 Google Cloud Project : ${config.firestoreProjectId}`);
  console.log(`🗄️ Firestore Database   : ${config.firestoreDatabaseId}`);
  console.log(`🔑 Service Account Key  : ${config.firestoreKeyFile}`);

  const initSuccess = firestoreService.initialize();
  if (!initSuccess) {
    console.error('❌ Failed to initialize Firestore client. Check credentials.');
    process.exit(1);
  }

  // 1. Locate index-options.json
  const candidatePaths = [
    path.resolve(__dirname, '..', 'data', 'index-options.json'),
    path.resolve(process.cwd(), 'data', 'index-options.json'),
  ];

  let jsonPath: string | null = null;
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      jsonPath = p;
      break;
    }
  }

  if (!jsonPath) {
    console.error('❌ Could not locate data/index-options.json file');
    process.exit(1);
  }

  console.log(`\n📂 Reading index options from: ${jsonPath}`);
  const rawData = fs.readFileSync(jsonPath, 'utf8');
  const indexOptions: CachedIndexOption[] = JSON.parse(rawData);
  console.log(`📊 Found ${indexOptions.length} total index options contracts`);

  // Verify NSE-only directive
  const nonNse = indexOptions.filter((opt) => opt.exchange && !opt.exchange.startsWith('NSE'));
  if (nonNse.length > 0) {
    console.warn(`⚠️ Warning: Found ${nonNse.length} non-NSE contracts. Filtering strictly to NSE...`);
  }
  const nseOptions = indexOptions.filter((opt) => !opt.exchange || opt.exchange.startsWith('NSE'));

  console.log(`\n📤 Uploading ${nseOptions.length} contracts to Firestore collection [index_options] (chunks of 500)...`);
  const startTime = Date.now();
  const result = await firestoreService.saveIndexOptions(nseOptions, 500);
  const elapsed = Date.now() - startTime;

  console.log(`✅ Upload complete in ${elapsed}ms!`);
  console.log(`   - Total Items Stored : ${result.totalItems}`);
  console.log(`   - Total Chunks Stored: ${result.totalChunks}`);
  console.log(`   - Firestore WriteTime: ${result.writeTime}`);

  console.log('\n🔍 Verifying stored data by reading back from Firestore...');
  const verifyStart = Date.now();
  const fetched = await firestoreService.getIndexOptions();
  const meta = await firestoreService.getIndexOptionsMetadata();
  const verifyElapsed = Date.now() - verifyStart;

  console.log(`✅ Verification query completed in ${verifyElapsed}ms!`);
  console.log(`   - Verified Items Count: ${fetched.length}`);
  console.log(`   - Stored Metadata:`, meta);

  if (fetched.length !== nseOptions.length) {
    console.error(`❌ Mismatch: Expected ${nseOptions.length} items, but read ${fetched.length} from Firestore!`);
    process.exit(1);
  }

  // Spot-check sample contracts
  console.log('\n🔎 Spot checking sample contracts:');
  const niftySample = fetched.find((c) => c.symbolName === 'NIFTY');
  const bankSample = fetched.find((c) => c.symbolName === 'BANKNIFTY');
  console.log('   - Sample NIFTY contract     :', niftySample?.customSymbol || niftySample?.tradingSymbol, `(SecID: ${niftySample?.securityId})`);
  console.log('   - Sample BANKNIFTY contract :', bankSample?.customSymbol || bankSample?.tradingSymbol, `(SecID: ${bankSample?.securityId})`);

  console.log('\n======================================================');
  console.log('🎉 ALL NSE INDEX OPTIONS STORED IN FIRESTORE SUCCESSFULLY!');
  console.log('======================================================\n');
}

uploadIndexOptionsToFirestore().catch((err) => {
  console.error('❌ Upload script failed:', err);
  process.exit(1);
});
