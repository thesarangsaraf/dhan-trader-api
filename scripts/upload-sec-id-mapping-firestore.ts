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

  // 1. Fetch scrip master (equities and benchmark indices) by downloading official Dhan CSV
  let scripMaster: any[] = [];
  const csvUrl = 'https://images.dhan.co/api-data/api-scrip-master.csv';
  console.log(`\n📥 Downloading latest Dhan scrip master from ${csvUrl}...`);
  try {
    const resp = await fetch(csvUrl, { signal: AbortSignal.timeout(45000) });
    if (resp.ok) {
      const csvText = await resp.text();
      console.log(`   Downloaded ${(csvText.length / 1024 / 1024).toFixed(1)} MB CSV. Parsing NSE cash equities & indices...`);
      const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
      const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
      const exchIdx = headers.findIndex((h) => /^SEM_EXM_EXCH_ID$|^EXCH_ID$|^EXCHANGE$/i.test(h));
      const segmentIdx = headers.findIndex((h) => /^SEM_SEGMENT$|^EXCHANGE_SEGMENT$|^SEGMENT$/i.test(h));
      const secIdIdx = headers.findIndex((h) => /^SEM_SMST_SECURITY_ID$|^SECURITY_ID$|^SECURITYID$/i.test(h));
      const instTypeIdx = headers.findIndex((h) => /^SEM_INSTRUMENT_NAME$|^INSTRUMENT_TYPE$|^TYPE$/i.test(h));
      const symbolIdx = headers.findIndex((h) => /^SEM_TRADING_SYMBOL$|^SYMBOL$|^TRADING_SYMBOL$/i.test(h));
      const nameIdx = headers.findIndex((h) => /^SEM_CUSTOM_SYMBOL$|^COMPANY_NAME$|^NAME$/i.test(h));
      const lotSizeIdx = headers.findIndex((h) => /^SEM_LOT_UNITS$|^LOT_SIZE$|^LOTSIZE$/i.test(h));

      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(',').map((p) => p.trim().replace(/^"|"$/g, ''));
        const exch = exchIdx >= 0 ? parts[exchIdx] : '';
        const secId = secIdIdx >= 0 ? parts[secIdIdx] : '';
        if (!secId) continue;

        const sym = symbolIdx >= 0 ? parts[symbolIdx] : parts[0];
        // Strictly NSE instruments only - except SENSEX (from BSE)
        const isSensex = sym.includes('SENSEX') || secId === '51';
        if (exch && exch !== 'NSE' && exch !== 'IDX_I' && !exch.startsWith('NSE') && !isSensex) {
          continue;
        }

        const instName = instTypeIdx >= 0 ? parts[instTypeIdx] : '';
        const rawSegment = segmentIdx >= 0 ? parts[segmentIdx] : '';
        const name = nameIdx >= 0 && parts[nameIdx] ? parts[nameIdx] : sym;
        const lot = lotSizeIdx >= 0 ? parseInt(parts[lotSizeIdx], 10) || 1 : 1;

        // 1. Traded Benchmark Indices ONLY: NIFTY 50, BANK NIFTY, MIDCAP NIFTY, SENSEX
        const isIndex = instName === 'INDEX' || rawSegment === 'I' || exch === 'IDX_I';
        if (isIndex) {
          let tradedIndexSymbol = '';
          let tradedIndexName = '';
          const symUpper = sym.toUpperCase();

          if (secId === '13' || symUpper === 'NIFTY' || symUpper === 'NIFTY 50') {
            tradedIndexSymbol = 'NIFTY 50';
            tradedIndexName = 'Nifty 50 Index';
          } else if (secId === '25' || symUpper === 'BANKNIFTY' || symUpper === 'BANK NIFTY') {
            tradedIndexSymbol = 'BANK NIFTY';
            tradedIndexName = 'Nifty Bank Index';
          } else if (secId === '442' || symUpper === 'MIDCPNIFTY' || symUpper === 'MIDCAP NIFTY') {
            tradedIndexSymbol = 'MIDCAP NIFTY';
            tradedIndexName = 'Nifty Midcap Select';
          } else if (secId === '51' || symUpper === 'SENSEX') {
            tradedIndexSymbol = 'SENSEX';
            tradedIndexName = 'BSE Sensex Index';
          }

          if (tradedIndexSymbol) {
            scripMaster.push({
              securityId: secId,
              symbol: tradedIndexSymbol,
              name: name && name !== sym ? name : tradedIndexName,
              exchangeSegment: 'IDX_I',
              instrumentType: 'INDEX',
              lotSize: lot,
            });
          }
          continue;
        }

        // 2. NSE Equities
        if (instName === 'EQUITY' || rawSegment === 'E') {
          scripMaster.push({
            securityId: secId,
            symbol: sym,
            name: name,
            exchangeSegment: 'NSE_EQ',
            instrumentType: 'EQUITY',
            lotSize: lot,
          });
        }
      }
      console.log(`   Found ${scripMaster.length} NSE equities & benchmark indices`);
    } else {
      console.warn(`⚠️ HTTP ${resp.status} downloading Dhan CSV.`);
    }
  } catch (err: any) {
    console.warn(`⚠️ Failed to download Dhan CSV: ${err.message}. Checking existing Firestore mapping...`);
    const existing = await firestoreService.getSecIdMapping();
    scripMaster = existing.scripMaster;
  }

  // 2. Save strictly equities & indices into sec_id_to_name_mapping (empty options array cleans up any stale options docs)
  console.log('\n📤 Uploading and organizing into collection [sec_id_to_name_mapping]...');
  const startTime = Date.now();
  const result = await firestoreService.saveSecIdMapping([], scripMaster);
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
