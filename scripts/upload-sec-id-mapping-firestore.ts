import * as fs from 'fs';
import * as path from 'path';
import { ConfigService } from '../src/config/config.service';
import { FirestoreService, CachedIndexOption } from '../src/firestore/firestore.service';

async function uploadSecIdMappingToFirestore() {
  console.log('\n======================================================');
  console.log('🚀 UPLOADING SEC ID TO NAME MAPPING TO GOOGLE CLOUD FIRESTORE');
  console.log('   Collection: [sec_id_to_name_mapping]');
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

  // 1. Fetch index options from Firestore or data/index-options.json
  console.log('\n📥 Loading index options from Firestore database [index_options]...');
  let indexOptions: CachedIndexOption[] = await firestoreService.getIndexOptions();
  console.log(`   Found ${indexOptions.length} options contracts from Firestore`);

  // 2. Fetch scrip-master from data/scrip-master.json
  const scripPath = path.resolve(process.cwd(), 'data', 'scrip-master.json');
  let scripMaster: any[] = [];
  if (fs.existsSync(scripPath)) {
    console.log(`📂 Reading scrip master from: ${scripPath}`);
    scripMaster = JSON.parse(fs.readFileSync(scripPath, 'utf8'));
    console.log(`   Found ${scripMaster.length} total scrip master items`);
  } else {
    console.warn(`⚠️ Warning: data/scrip-master.json not found on disk.`);
  }

  // 3. Save into sec_id_to_name_mapping
  console.log('\n📤 Uploading and organizing into collection [sec_id_to_name_mapping]...');
  const startTime = Date.now();
  const result = await firestoreService.saveSecIdMapping(indexOptions, scripMaster);
  const elapsed = Date.now() - startTime;

  console.log(`✅ Upload complete in ${elapsed}ms!`);
  console.log(`   - Collection Name    : ${result.collection}`);
  console.log(`   - Total Instruments  : ${result.totalInstruments}`);
  console.log(`   - Total Options      : ${result.totalOptions}`);
  console.log(`   - Total Indices      : ${result.totalIndices}`);
  console.log(`   - Total Equities     : ${result.totalEquities}`);
  console.log(`   - Documents Created  : ${result.documents.length}`);
  console.log(`   - Document List      :`, result.documents);
  console.log(`   - Sync Timestamp     : ${result.syncedAt}`);

  // 4. Verify by reading back from Firestore
  console.log('\n🔍 Verifying stored data by reading back from Firestore...');
  const verifyStart = Date.now();
  const readBack = await firestoreService.getSecIdMapping();
  const meta = await firestoreService.getSecIdMappingMetadata();
  const verifyElapsed = Date.now() - verifyStart;

  console.log(`✅ Read back verified in ${verifyElapsed}ms!`);
  console.log(`   - Verified Options Count : ${readBack.options.length}`);
  console.log(`   - Verified Scrip Count   : ${readBack.scripMaster.length}`);
  console.log(`   - Total Verified Items   : ${readBack.options.length + readBack.scripMaster.length}`);
  console.log(`   - Stored Metadata        :`, meta);

  console.log('\n======================================================');
  console.log('🎉 ALL SEC ID TO NAME MAPPING DATA STORED SUCCESSFULLY!');
  console.log('======================================================\n');
}

uploadSecIdMappingToFirestore().catch((err) => {
  console.error('❌ Upload script failed:', err);
  process.exit(1);
});
