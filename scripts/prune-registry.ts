import { execSync } from 'child_process';

const REGISTRY_REPO = 'asia-south1-docker.pkg.dev/dhan-trader-514002/dhan-api-docker/dhan-trader-api';

interface ArtifactImage {
  createTime: string;
  updateTime: string;
  package: string;
  version: string;
  tags?: string[];
  metadata?: {
    mediaType?: string;
    subjectDigest?: string;
    imageSizeBytes?: string;
  };
}

async function pruneRegistry() {
  console.log(`🔍 Inspecting Docker images in Artifact Registry: ${REGISTRY_REPO}...`);

  let stdout = '';
  try {
    stdout = execSync(
      `gcloud artifacts docker images list ${REGISTRY_REPO} --include-tags --sort-by=~CREATE_TIME --format="json"`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch (err: any) {
    console.error(`❌ Failed to list images from Artifact Registry: ${err.message}`);
    process.exit(1);
  }

  // Parse JSON output
  const jsonStartIndex = stdout.indexOf('[');
  if (jsonStartIndex === -1) {
    console.log('ℹ️ No images found in repository.');
    return;
  }

  const images: ArtifactImage[] = JSON.parse(stdout.slice(jsonStartIndex));
  if (!images || images.length === 0) {
    console.log('ℹ️ No images found in repository.');
    return;
  }

  // Find the 'latest' tagged image
  const latestTagged = images.find((img) => img.tags && img.tags.includes('latest'));
  const latestDigest = latestTagged ? latestTagged.version : images[0].version;
  const latestCreateTime = latestTagged ? new Date(latestTagged.createTime).getTime() : new Date(images[0].createTime).getTime();

  console.log(`✅ Keeping latest image: ${latestDigest} (created ${latestTagged?.createTime || images[0].createTime})`);

  // Any image created within 10 minutes of the latest image belongs to the same build (e.g. multi-arch manifests/attestations)
  const marginMs = 10 * 60 * 1000;
  const toDelete: ArtifactImage[] = [];

  for (const img of images) {
    if (img.version === latestDigest) {
      continue;
    }
    const imgTime = new Date(img.createTime).getTime();
    if (Math.abs(latestCreateTime - imgTime) <= marginMs) {
      // Associated layer / attestation of the latest build
      continue;
    }
    toDelete.push(img);
  }

  if (toDelete.length === 0) {
    console.log('✨ No older images found. Registry contains only the latest production image.');
  } else {
    console.log(`🗑️ Found ${toDelete.length} older image digest(s) to remove:`);
    for (const img of toDelete) {
      console.log(`   - ${img.version} (created ${img.createTime}, tags: ${img.tags?.join(', ') || 'none'})`);
      try {
        console.log(`   Deleting ${img.version}...`);
        execSync(`gcloud artifacts docker images delete "${REGISTRY_REPO}@${img.version}" --quiet --delete-tags`, {
          stdio: 'inherit',
        });
      } catch (delErr: any) {
        console.error(`   ⚠️ Failed to delete ${img.version}: ${delErr.message}`);
      }
    }
    console.log('✅ Registry cleanup complete.');
  }

  // Also prune local Docker dangling images
  console.log('🧹 Pruning local dangling Docker images...');
  try {
    execSync('docker image prune -f', { stdio: 'inherit' });
  } catch (dockerErr: any) {
    console.warn(`⚠️ Local docker prune skipped: ${dockerErr.message}`);
  }
}

pruneRegistry().catch((err) => {
  console.error('Fatal error during registry pruning:', err);
  process.exit(1);
});
