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

  // 1. Download Dhan CSV and extract live NSE index options
  const indexOptions: CachedIndexOption[] = [];
  const csvUrl = 'https://images.dhan.co/api-data/api-scrip-master.csv';
  console.log(`\n📥 Downloading latest Dhan scrip master from ${csvUrl}...`);

  try {
    const resp = await fetch(csvUrl, { signal: AbortSignal.timeout(45000) });
    if (resp.ok) {
      const csvText = await resp.text();
      console.log(`   Downloaded ${(csvText.length / 1024 / 1024).toFixed(1)} MB CSV. Parsing NSE index options...`);
      const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
      const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
      const exchIdx = headers.findIndex((h) => /^SEM_EXM_EXCH_ID$|^EXCH_ID$|^EXCHANGE$/i.test(h));
      const segmentIdx = headers.findIndex((h) => /^SEM_SEGMENT$|^EXCHANGE_SEGMENT$|^SEGMENT$/i.test(h));
      const secIdIdx = headers.findIndex((h) => /^SEM_SMST_SECURITY_ID$|^SECURITY_ID$|^SECURITYID$/i.test(h));
      const instNameIdx = headers.findIndex((h) => /^SEM_INSTRUMENT_NAME$|^INSTRUMENT_TYPE$|^TYPE$/i.test(h));
      const symbolIdx = headers.findIndex((h) => /^SEM_TRADING_SYMBOL$|^SYMBOL$|^TRADING_SYMBOL$/i.test(h));
      const nameIdx = headers.findIndex((h) => /^SEM_CUSTOM_SYMBOL$|^COMPANY_NAME$|^NAME$/i.test(h));
      const lotSizeIdx = headers.findIndex((h) => /^SEM_LOT_UNITS$|^LOT_SIZE$|^LOTSIZE$/i.test(h));
      const expiryIdx = headers.findIndex((h) => /^SEM_EXPIRY_DATE$|^EXPIRY_DATE$/i.test(h));
      const strikeIdx = headers.findIndex((h) => /^SEM_STRIKE_PRICE$|^STRIKE_PRICE$|^STRIKE$/i.test(h));
      const optTypeIdx = headers.findIndex((h) => /^SEM_OPTION_TYPE$|^OPTION_TYPE$|^OPT_TYPE$/i.test(h));
      const symNameIdx = headers.findIndex((h) => /^SM_SYMBOL_NAME$|^UNDERLYING_SYMBOL$/i.test(h));

      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(',').map((p) => p.trim().replace(/^"|"$/g, ''));
        const exch = exchIdx >= 0 ? parts[exchIdx] : '';
        const secId = secIdIdx >= 0 ? parts[secIdIdx] : '';
        if (!secId) continue;
        if (exch && exch !== 'NSE' && !exch.startsWith('NSE')) continue;

        const instName = instNameIdx >= 0 ? parts[instNameIdx] : '';
        const rawSegment = segmentIdx >= 0 ? parts[segmentIdx] : '';
        const sym = symbolIdx >= 0 ? parts[symbolIdx] : parts[0];
        const name = nameIdx >= 0 && parts[nameIdx] ? parts[nameIdx] : sym;
        const lot = lotSizeIdx >= 0 ? parseInt(parts[lotSizeIdx], 10) || 1 : 1;

        if (instName === 'OPTIDX') {
          const rawExpiry = expiryIdx >= 0 ? parts[expiryIdx] : '';
          const expiryDate = rawExpiry ? rawExpiry.split(' ')[0].trim() : '';
          const strikePrice = strikeIdx >= 0 ? parseFloat(parts[strikeIdx]) || 0 : 0;
          const optType = optTypeIdx >= 0 && parts[optTypeIdx] === 'PE' ? 'PE' : 'CE';
          const rawSymName = symNameIdx >= 0 ? parts[symNameIdx] : '';
          let root = (rawSymName || sym.split('-')[0].trim()).toUpperCase();
          if (root === 'BANKNIFTY' || root.includes('BANK')) root = 'BANKNIFTY';
          else if (root === 'MIDCPNIFTY' || root.includes('MIDCP') || root.includes('MIDCAP')) root = 'MIDCPNIFTY';
          else if (root === 'FINNIFTY' || root.includes('FIN NIFTY')) root = 'FINNIFTY';
          else if (root === 'NIFTY' || root === 'NIFTY 50') root = 'NIFTY';
          else root = '';

          // Strictly filter to traded indices: NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY
          const TRADED_INDICES = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY']);
          if (!root || !TRADED_INDICES.has(root)) continue;

          indexOptions.push({
            symbolName: root,
            exchange: 'NSE_FNO',
            securityId: secId,
            tradingSymbol: sym,
            customSymbol: name,
            expiryDate,
            strikePrice,
            optionType: optType as 'CE' | 'PE',
            lotSize: lot,
          });
        }
      }
      console.log(`   Found ${indexOptions.length} live NSE index options`);
    }
  } catch (err: any) {
    console.warn(`⚠️ Failed to download Dhan CSV (${err.message}). Trying Firestore sec_id_to_name_mapping...`);
    const mapping = await firestoreService.getSecIdMapping();
    indexOptions.push(...mapping.options);
  }

  if (indexOptions.length === 0) {
    console.error('❌ Could not extract any index options from live CSV or database');
    process.exit(1);
  }

  const nseOptions = indexOptions.filter((opt) => !opt.exchange || opt.exchange.startsWith('NSE'));

  console.log(`\n📤 Uploading contracts to Firestore collection [index_options] across dedicated documents (max 2 expiries: current & next)...`);
  const startTime = Date.now();
  const result = await firestoreService.saveIndexOptions(nseOptions, 2);
  const elapsed = Date.now() - startTime;

  console.log(`✅ Upload complete in ${elapsed}ms!`);
  console.log(`   - Total Contracts Stored  : ${result.totalItems}`);
  console.log(`   - Dedicated Documents     : ${result.documentIds.join(', ')}`);
  console.log(`   - Documents Count         : ${result.documentsCount}`);
  console.log(`   - Firestore WriteTime     : ${result.writeTime}`);

  console.log('\n🔍 Verifying stored data by reading back from Firestore...');
  const verifyStart = Date.now();
  const fetched = await firestoreService.getIndexOptions();
  const meta = await firestoreService.getIndexOptionsMetadata();
  const verifyElapsed = Date.now() - verifyStart;

  console.log(`✅ Verification query completed in ${verifyElapsed}ms!`);
  console.log(`   - Verified Items Count: ${fetched.length}`);
  console.log(`   - Stored Metadata:`, meta);

  if (fetched.length !== result.totalItems) {
    console.error(`❌ Mismatch: Expected ${result.totalItems} items, but read ${fetched.length} from Firestore!`);
    process.exit(1);
  }

  // Spot-check dedicated index documents
  console.log('\n🔎 Spot checking dedicated index documents:');
  for (const sym of result.documentIds) {
    const doc = await firestoreService.getIndexOptionDocument(sym);
    if (doc) {
      console.log(`   📄 Document [${sym}]:`);
      console.log(`      - Name           : ${doc.name}`);
      console.log(`      - Current Expiry : ${doc.currentExpiry}`);
      console.log(`      - Next Expiry    : ${doc.nextExpiry}`);
      console.log(`      - Total Contracts: ${doc.totalContracts}`);
      console.log(`      - Sample Contract: ${doc.contracts[0]?.customSymbol || doc.contracts[0]?.tradingSymbol} (SecID: ${doc.contracts[0]?.securityId})`);
    } else {
      console.warn(`   ⚠️ Document [${sym}] not found!`);
    }
  }

  console.log('\n======================================================');
  console.log('🎉 ALL DEDICATED INDEX OPTION DOCUMENTS STORED IN FIRESTORE SUCCESSFULLY!');
  console.log('======================================================\n');
}

uploadIndexOptionsToFirestore().catch((err) => {
  console.error('❌ Upload script failed:', err);
  process.exit(1);
});
