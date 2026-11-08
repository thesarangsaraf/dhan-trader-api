import { ConfigService } from '../src/config/config.service';
import { DhanService } from '../src/dhan/dhan.service';
import { AuthService } from '../src/auth/auth.service';
import { FirestoreService } from '../src/firestore/firestore.service';

async function verifyRealDhanConnection() {
  const config = new ConfigService();
  const firestoreService = new FirestoreService(config);
  firestoreService.initialize();
  await firestoreService.syncAllConfigFromFirestore();

  const dhanService = new DhanService(config, firestoreService);
  const authService = new AuthService(config, dhanService, undefined, firestoreService);
  await authService.syncTokenFromDatabase();

  console.log('\n======================================================');
  console.log('⚡ DHAN HQ API v2 — NESTJS (TYPESCRIPT) REAL DATA CHECK');
  console.log('======================================================\n');

  console.log(`📌 Configured Client ID : ${config.clientId}`);
  const inspection = authService.getTokenInspection();
  console.log(`🔑 Token Status         : ${inspection.status} (${inspection.timeRemainingFormatted})`);
  console.log(`⏳ Token Expiry (IST)   : ${inspection.expiresAtIST}`);

  if (!inspection.configured || inspection.isExpired) {
    console.log('\n❌ [ALERT] Your Dhan Access Token is missing or expired.');
    console.log('👉 Please generate a fresh token on https://web.dhan.co and update your .env:');
    console.log('   DHAN_CLIENT_ID=your_client_id');
    console.log('   DHAN_ACCESS_TOKEN=your_jwt_access_token\n');
    return;
  }

  // 1. Live Profile Check
  console.log('\n1️⃣ Checking Profile (/profile)...');
  const profileRes = await dhanService.getProfile();
  if (profileRes.ok && profileRes.data) {
    console.log('   ✅ Profile Verified Live on Dhan:');
    console.log('   👤 Name     :', profileRes.data.tokenDetails?.userName || profileRes.data.userName || profileRes.data.name || 'Dhan Trader');
    console.log('   🆔 Client ID:', profileRes.data.tokenDetails?.dhanClientId || profileRes.data.clientId || config.clientId);
    console.log('   📊 Segments :', profileRes.data.activeSegment);
  } else {
    console.log('   ❌ Profile check failed on Dhan API:');
    console.log('   Status :', profileRes.status);
    console.log('   Error  :', profileRes.data?.errorMessage || profileRes.data?.message || profileRes.data || profileRes.error);
  }

  // 2. Real Account Margin & Funds Check
  console.log('\n2️⃣ Checking Fund Limits (/fundlimit)...');
  const fundsRes = await dhanService.getFundLimits();
  if (fundsRes.ok && fundsRes.data) {
    const fd = fundsRes.data;
    console.log('   ✅ Live Dhan Account Margins:');
    console.log(`   💵 Available Cash/Margin : ₹${fd.availMargin || fd.availableBalance || fd.cash || 0}`);
    console.log(`   📊 Utilized Margin       : ₹${fd.utilizedMargin || fd.marginUtilized || 0}`);
    console.log(`   🛡️ Collateral Amount     : ₹${fd.collateralAmount || 0}`);
  } else {
    console.log('   ⚠️ Funds check response:', fundsRes.status, fundsRes.data?.errorMessage || fundsRes.data || fundsRes.error);
  }

  // 3. Real Demat Portfolio Holdings
  console.log('\n3️⃣ Checking Demat Holdings (/holdings)...');
  const holdingsRes = await dhanService.getHoldings();
  if (holdingsRes.ok && Array.isArray(holdingsRes.data)) {
    console.log(`   ✅ Demat Holdings Count: ${holdingsRes.data.length}`);
    holdingsRes.data.slice(0, 5).forEach((h: any, i: number) => {
      console.log(`   [${i + 1}] ${h.tradingSymbol || h.symbol}: Qty ${h.totalQty || h.quantity}, LTP: ₹${h.ltp || h.lastPrice}`);
    });
  } else if (holdingsRes.status === 500 && (holdingsRes.data?.errorMessage === 'No holdings available' || holdingsRes.data?.errorCode === 'DH-1111')) {
    console.log('   ✅ Demat Holdings: 0 (Account has no stock holdings)');
  } else {
    console.log('   ⚠️ Holdings check response:', holdingsRes.status, holdingsRes.data?.errorMessage || holdingsRes.data || holdingsRes.error);
  }

  // 4. Real Open & Closed Positions
  console.log('\n4️⃣ Checking Positions (/positions)...');
  const posRes = await dhanService.getPositions();
  if (posRes.ok && Array.isArray(posRes.data)) {
    console.log(`   ✅ Active Positions Count: ${posRes.data.length}`);
    posRes.data.slice(0, 5).forEach((p: any, i: number) => {
      console.log(`   [${i + 1}] ${p.tradingSymbol || p.symbol}: Net Qty ${p.netQty}, LTP: ₹${p.ltp || p.lastPrice}, P&L: ₹${p.realizedProfit || p.realizedPnL || 0}`);
    });
  } else {
    console.log('   ⚠️ Positions check response:', posRes.status, posRes.data?.errorMessage || posRes.data || posRes.error);
  }

  // 5. Real Marketfeed Live LTP
  console.log('\n5️⃣ Checking Live Marketfeed LTP (/marketfeed/ltp)...');
  const ltpRes = await dhanService.getLtp({
    'IDX_I': [13, 25],
  });

  if (ltpRes.ok && ltpRes.data && ltpRes.data.data) {
    console.log('   ✅ Live NSE Marketfeed Received:');
    const idxData = ltpRes.data.data.IDX_I || {};
    if (idxData['13']) console.log(`   📈 NIFTY 50    LTP : ₹${idxData['13'].last_price}`);
    if (idxData['25']) console.log(`   📈 NIFTY BANK  LTP : ₹${idxData['25'].last_price}`);
  } else {
    console.log('   ℹ️ Marketfeed status:', ltpRes.status, ltpRes.data?.data?.['806'] || ltpRes.data?.errorMessage || ltpRes.data || ltpRes.error);
  }

  console.log('\n======================================================\n');
}

verifyRealDhanConnection().catch((err) => {
  console.error('Fatal check error:', err);
});
