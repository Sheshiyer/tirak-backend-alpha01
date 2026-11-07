import { z } from 'zod';
import { computePayloadDigest } from './supplier-onboarding';

const tag = z.string().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
export const attributionSchema = z.object({
  landingPath: z.enum(['/', '/tirak', '/download', '/apply', '/contact', '/bangkok', '/chiang-mai', '/phuket', '/culture', '/adventure', '/wellness', '/nightlife', '/food', '/lifestyle', '/cinema', '/events']),
  utmSource: tag.optional(), utmMedium: tag.optional(), utmCampaign: tag.optional(), utmContent: tag.optional(),
}).strict();
export type AcquisitionAttribution = z.infer<typeof attributionSchema>;

export interface IntakeDigests {
  core: string;
  historicalAttributed?: string;
}

// Keep new receipts readable by the retained Worker while campaign writes are held.
export async function computeIntakeDigests(
  corePayload: Record<string, unknown>,
  attribution?: AcquisitionAttribution,
): Promise<IntakeDigests> {
  const core = await computePayloadDigest(corePayload);
  const historicalAttributed = attribution && await computePayloadDigest({ ...corePayload, attribution });
  return { core, historicalAttributed };
}

export function matchesIntakeDigest(savedDigest: string | null, digests: IntakeDigests): boolean {
  return !savedDigest || savedDigest === digests.core || savedDigest === digests.historicalAttributed;
}
