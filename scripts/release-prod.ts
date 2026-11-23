import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { ConfigService } from '../src/config/config.service';

const config = new ConfigService();
const REGISTRY_REPO = (config.containerRegistryRepo || process.env.CONTAINER_REGISTRY_REPO || '').trim();
const IMAGE_TAG = `${REGISTRY_REPO}:latest`;
const CLOUD_RUN_SERVICE = (config.cloudRunService || process.env.CLOUD_RUN_SERVICE || '').trim();
const REGION = (config.cloudRunRegion || process.env.CLOUD_RUN_REGION || '').trim();

function runStep(title: string, command: string) {
  console.log(`\n======================================================`);
  console.log(`🚀 ${title}`);
  console.log(`Command: ${command}`);
  console.log(`======================================================\n`);
  try {
    execSync(command, { stdio: 'inherit' });
  } catch (err: any) {
    console.error(`\n❌ Step failed: ${title} (${err.message})`);
    process.exit(1);
  }
}

async function releaseProduction() {
  console.log(`📦 Starting Production Release for ${CLOUD_RUN_SERVICE}...`);
  console.log(`🎯 Target Image: ${IMAGE_TAG}`);

  // 1. Build TypeScript backend
  runStep('Step 1: Compiling TypeScript backend', 'npm run build');

  // 2. Build multi-stage production Docker image for Cloud Run (linux/amd64)
  runStep('Step 2: Building Docker image for Cloud Run (linux/amd64)', `docker build --platform linux/amd64 -t ${IMAGE_TAG} .`);

  // 3. Push image to GCP Artifact Registry with tag :latest
  // Note: Pushing with :latest tag automatically removes the tag from previous images, making them tagless
  runStep('Step 3: Pushing image to GCP Artifact Registry', `docker push ${IMAGE_TAG}`);

  // 4. Update Cloud Run service revision and inject environment variables via YAML definition file
  const envYamlPath = path.resolve(__dirname, '..', '.cloudrun-env.yaml');
  const envYamlContent = [
    `FIRESTORE_PROJECT_ID: "${config.firestoreProjectId}"`,
    `FIRESTORE_DATABASE_ID: "${config.firestoreDatabaseId}"`,
    `FIRESTORE_KEY_FILE: "${config.firestoreKeyFile}"`,
    `FIRESTORE_AUTH_SCOPES: "${config.firestoreAuthScopes.join(',')}"`,
    `DHAN_API_BASE: "${config.dhanApiBase}"`,
    `DHAN_SCRIP_MASTER_URL: "${config.dhanScripMasterUrl}"`,
    `WEBHOOK_BASE_URL: "${config.webhookBaseUrl}"`,
    `TELEGRAM_API_BASE: "${config.telegramApiBase}"`,
    `YAHOO_FINANCE_BASE_URL: "${config.yahooFinanceBaseUrl}"`,
    `JWT_SECRET: "${config.jwtSecret}"`,
    `CRON_SECRET: "${config.cronSecret}"`,
    `POLL_INTERVAL_MS: "${config.pollIntervalMs}"`,
    `NODE_ENV: "production"`,
  ].join('\n');

  fs.writeFileSync(envYamlPath, envYamlContent, 'utf8');

  try {
    runStep(
      'Step 4: Updating Cloud Run service revision and injecting environment variables',
      `gcloud run services update ${CLOUD_RUN_SERVICE} --image ${IMAGE_TAG} --region ${REGION} --env-vars-file "${envYamlPath}"`,
    );
  } finally {
    if (fs.existsSync(envYamlPath)) {
      fs.unlinkSync(envYamlPath);
    }
  }

  // 5. Delete older inactive Cloud Run revisions to keep only the newly deployed active revision
  runStep('Step 5: Pruning older Cloud Run revisions', 'npm run prune:revisions');

  // 6. Prune older images from Artifact Registry to keep only the latest image and conserve registry space
  runStep('Step 6: Pruning older tagless images from Artifact Registry', 'npm run prune:registry');

  console.log(`\n🎉 Production release, Cloud Run revision pruning, and registry cleanup completed successfully!`);
}

releaseProduction().catch((err) => {
  console.error('Fatal release error:', err);
  process.exit(1);
});
