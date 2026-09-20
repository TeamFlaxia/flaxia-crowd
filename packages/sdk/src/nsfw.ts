import type { NudeNetDetection } from './types';

/** Minimum detection confidence before a NudeNet label is trusted. */
export const NSFW_LABEL_THRESHOLD = 0.5;

/** Labels that make the whole image explicit. */
export const NSFW_EXPLICIT_LABELS: ReadonlySet<string> = new Set([
  'FEMALE_GENITALIA_EXPOSED',
  'MALE_GENITALIA_EXPOSED',
  'ANUS_EXPOSED',
]);

/** NudeNet label -> host-facing content tag. */
export const NSFW_ELEMENT_TAGS: Readonly<Record<string, string>> = {
  FEMALE_GENITALIA_EXPOSED: 'exposed_genital',
  MALE_GENITALIA_EXPOSED: 'exposed_genital',
  ANUS_EXPOSED: 'exposed_anus',
  FEMALE_BREAST_EXPOSED: 'exposed_breast',
  MALE_BREAST_EXPOSED: 'exposed_breast',
  BUTTOCKS_EXPOSED: 'exposed_buttocks',
};

export interface NsfwTagResult {
  /** True when an explicit label crossed the confidence threshold. */
  nsfw: boolean;
  /** Deduplicated content tags, including `'nsfw'` when {@link nsfw} is true. */
  tags: string[];
}

/**
 * Map raw NudeNet detections to host content tags. Pure and deterministic so
 * it can run both in the orchestrator callback path and in unit tests.
 */
export function resolveNsfwTags(detections: NudeNetDetection[] | undefined): NsfwTagResult {
  if (!detections || detections.length === 0) return { nsfw: false, tags: [] };

  const tags = new Set<string>();
  let nsfw = false;

  for (const detection of detections) {
    if (detection.score < NSFW_LABEL_THRESHOLD) continue;
    if (NSFW_EXPLICIT_LABELS.has(detection.label)) nsfw = true;
    const elementTag = NSFW_ELEMENT_TAGS[detection.label];
    if (elementTag) tags.add(elementTag);
  }

  if (nsfw) tags.add('nsfw');
  return { nsfw, tags: Array.from(tags) };
}