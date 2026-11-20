import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigService } from '../src/config/config.service';
import { FirestoreService } from '../src/firestore/firestore.service';

async function setupCronSecret() {
  const config = new ConfigService();
  const firestoreService = new FirestoreService(config);

  console.log('\n======================================================');
  console.log('⏰ CLOUD SCHEDULER SECURITY TOKEN — FIRESTORE SETUP');
  console.log('======================================================\n');

  console.log(`📌 Google Cloud Project : ${config.firestoreProjectId}`);
  console.log(`🗄️ Firestore Database   : ${config.firestoreDatabaseId}`);

  const initialized = firestoreService.initialize();
  if (!initialized || !firestoreService.isReady()) {
    console.error('❌ Firestore initialization failed. Check service account credentials.');
    process.exit(1);
  }

  // 1. Check existing cron secret in Firestore
  const existing = await firestoreService.getCronConfig(true);
  let secret = existing?.cronSecret;

  if (secret) {
    console.log(`ℹ️ Existing Cron Secret found in Firestore (config/cron):`);
    console.log(`   Secret: ${secret}`);
    console.log(`   Updated: ${existing?.updatedAt || 'N/A'}`);
  } else {
    // Generate new cryptographically secure 64-character hex token
    secret = crypto.randomBytes(32).toString('hex');
    console.log(`✨ Generated new 64-character Cron Secret:`);
    console.log(`   Secret: ${secret}`);

    const res = await firestoreService.saveCronConfig(
      secret,
      'GCP Cloud Scheduler API token renewal secret',
    );
    console.log(`✅ Saved new Cron Secret to Firestore at ${res.writeTime}`);
  }

  // 2. Ensure local .env contains CRON_SECRET for local dev / tests
  const envPath = path.resolve(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    let envContent = fs.readFileSync(envPath, 'utf8');
    if (envContent.includes('CRON_SECRET=')) {
      envContent = envContent.replace(/CRON_SECRET=.*/g, `CRON_SECRET=${secret}`);
    } else {
      envContent += `\n# GCP Cloud Scheduler Pre-Shared Secret\nCRON_SECRET=${secret}\n`;
    }
    fs.writeFileSync(envPath, envContent, 'utf8');
    console.log(`📄 Synchronized local .env with CRON_SECRET`);
  }

  console.log('\n======================================================');
  console.log('🎉 Setup Complete!');
  console.log(`🔑 CRON_SECRET: ${secret}`);
  console.log('======================================================\n');

  return secret;
}

setupCronSecret().catch((err) => {
  console.error('Fatal error during cron secret setup:', err);
  process.exit(1);
});
