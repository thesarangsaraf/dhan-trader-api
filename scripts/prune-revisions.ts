import { execSync } from 'child_process';
import { ConfigService } from '../src/config/config.service';

const config = new ConfigService();
const SERVICE_NAME = (config.cloudRunService || process.env.CLOUD_RUN_SERVICE || '').trim();
const REGION = (config.cloudRunRegion || process.env.CLOUD_RUN_REGION || '').trim();

interface CloudRunRevision {
  metadata: {
    name: string;
    creationTimestamp: string;
  };
  status?: {
    conditions?: Array<{ type: string; status: string }>;
  };
}

async function pruneOldRevisions() {
  console.log(`🔍 Checking Cloud Run revisions for service [${SERVICE_NAME}] in region [${REGION}]...`);

  // 1. Get the currently active revision serving traffic
  let activeRevision = '';
  try {
    activeRevision = execSync(
      `gcloud run services describe ${SERVICE_NAME} --region=${REGION} --format="value(status.latestReadyRevisionName)"`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
  } catch (err: any) {
    console.error(`❌ Failed to fetch active revision for ${SERVICE_NAME}: ${err.message}`);
    return;
  }

  if (!activeRevision) {
    console.warn('⚠️ Could not determine active revision name. Skipping revision cleanup.');
    return;
  }

  console.log(`✅ Active revision serving traffic: ${activeRevision}`);

  // 2. List all revisions for the service
  let revisionsStdout = '';
  try {
    revisionsStdout = execSync(
      `gcloud run revisions list --service=${SERVICE_NAME} --region=${REGION} --format="json"`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch (err: any) {
    console.error(`❌ Failed to list revisions for ${SERVICE_NAME}: ${err.message}`);
    return;
  }

  const jsonStart = revisionsStdout.indexOf('[');
  if (jsonStart === -1) {
    console.log('ℹ️ No revisions found.');
    return;
  }

  const revisions: CloudRunRevision[] = JSON.parse(revisionsStdout.slice(jsonStart));
  const oldRevisions = revisions.filter((rev) => rev.metadata.name !== activeRevision);

  if (oldRevisions.length === 0) {
    console.log(`✨ No older revisions found. Cloud Run has strictly 1 active revision (${activeRevision}).`);
    return;
  }

  console.log(`🗑️ Found ${oldRevisions.length} older Cloud Run revision(s) to delete:`);
  for (const rev of oldRevisions) {
    const revName = rev.metadata.name;
    console.log(`   Deleting revision ${revName} (created ${rev.metadata.creationTimestamp})...`);
    try {
      execSync(`gcloud run revisions delete "${revName}" --region=${REGION} --quiet`, {
        stdio: 'inherit',
      });
      console.log(`   ✅ Deleted revision ${revName}`);
    } catch (delErr: any) {
      console.error(`   ⚠️ Failed to delete revision ${revName}: ${delErr.message}`);
    }
  }

  console.log('✅ Cloud Run revision cleanup complete. Only the latest active revision is retained.');
}

pruneOldRevisions().catch((err) => {
  console.error('Fatal error during revision pruning:', err);
  process.exit(1);
});
