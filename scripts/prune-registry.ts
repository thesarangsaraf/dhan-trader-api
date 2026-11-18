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
    artifactType?: string;
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
  if (!latestTagged) {
    console.warn('⚠️ No image with "latest" tag found. Retaining newest image as fallback.');
  }

  const activeImage = latestTagged || images[0];
  const latestDigest = activeImage.version;
  const latestCreateTime = new Date(activeImage.createTime).getTime();

  console.log(`✅ Keeping latest image: ${latestDigest} (created ${activeImage.createTime}, tags: ${activeImage.tags?.join(', ') || 'none'})`);

  // Track digests belonging to the active release (manifest index + platform layers + attestations)
  const activeDigests = new Set<string>();
  activeDigests.add(latestDigest);

  // Try inspecting docker manifest to accurately identify all child platform manifests of :latest
  try {
    const manifestRaw = execSync(`docker manifest inspect ${REGISTRY_REPO}:latest`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(manifestRaw);
    if (parsed.manifests && Array.isArray(parsed.manifests)) {
      for (const m of parsed.manifests) {
        if (m.digest) {
          activeDigests.add(m.digest);
        }
      }
    }
  } catch {
    // Docker daemon might not be running or remote inspect unavailable
  }

  // Any child manifest linked via subjectDigest or created within 60s of the latest manifest belongs to the same build
  for (const img of images) {
    if (img.metadata?.subjectDigest && activeDigests.has(img.metadata.subjectDigest)) {
      activeDigests.add(img.version);
    }
    const imgTime = new Date(img.createTime).getTime();
    if (Math.abs(latestCreateTime - imgTime) <= 60 * 1000) {
      activeDigests.add(img.version);
    }
  }

  // Every other image is an older build (which became tagless when 'latest' was updated)
  const toDelete: ArtifactImage[] = images.filter((img) => !activeDigests.has(img.version));

  if (toDelete.length === 0) {
    console.log('✨ No older images found. Registry contains strictly the latest production image.');
  } else {
    console.log(`🗑️ Found ${toDelete.length} older/tagless image digest(s) to remove:`);
    for (const img of toDelete) {
      console.log(`   - ${img.version} (created ${img.createTime}, tags: ${img.tags?.join(', ') || 'none (tagless)'})`);
      try {
        console.log(`   Deleting ${img.version}...`);
        execSync(`gcloud artifacts docker images delete "${REGISTRY_REPO}@${img.version}" --quiet --delete-tags`, {
          stdio: 'inherit',
        });
      } catch (delErr: any) {
        console.error(`   ⚠️ Failed to delete ${img.version}: ${delErr.message}`);
      }
    }
    console.log('✅ Artifact Registry cleanup complete. Only latest image retained.');
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
