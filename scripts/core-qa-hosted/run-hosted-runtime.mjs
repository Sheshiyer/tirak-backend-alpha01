import { mkdir, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { HOSTED_RUNTIME } from './constants.mjs';
import { runHostedJourney, sanitizeHostedProof } from './adapter.mjs';

function sanitizeError(error) {
  return {
    name: error?.name || 'Error',
    message: String(error?.message || error || 'unknown error'),
    code: error?.code || null,
  };
}

async function main() {
  const repoRoot = process.cwd();
  const startedAt = new Date().toISOString();
  const proof = {
    ok: false,
    verificationState: 'running',
    startedAt,
    hosted: {
      workerUrl: HOSTED_RUNTIME.workerUrl,
      accountId: HOSTED_RUNTIME.accountId,
      d1DatabaseId: HOSTED_RUNTIME.d1DatabaseId,
      r2BucketName: HOSTED_RUNTIME.r2BucketName,
      cacheNamespaceId: HOSTED_RUNTIME.cacheNamespaceId,
    },
    steps: [],
    methodSanity: [],
    limitations: [
      'This runner must only execute after the parent-owned hosted runtime/schema/deploy gate is explicitly opened.',
      'This seat does not open the parent-owned hosted execution gate; proof remains unverified until that parent gate is opened and the run is executed there.',
    ],
  };

  const outputDir = path.join(repoRoot, 'scripts/core-qa-hosted/generated');
  const proofPath = path.join(outputDir, 'core-qa-hosted-proof.json');
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const checkpoint = () => writeFileSync(proofPath, JSON.stringify(sanitizeHostedProof(proof), null, 2), { mode: 0o600 });
  Object.defineProperty(proof, 'onStep', { value: checkpoint, enumerable: false });
  checkpoint();

  try {
    await runHostedJourney({ repoRoot, proof });
    proof.ok = true;
    proof.verificationState = 'verified';
  } catch (error) {
    proof.ok = false;
    proof.verificationState = error?.code === 'RUN_JOURNEY_EXPORT_MISSING' ? 'blocked' : 'failed';
    proof.error = sanitizeError(error);
  }

  await writeFile(proofPath, JSON.stringify(sanitizeHostedProof(proof), null, 2), 'utf8');

  if (!proof.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
