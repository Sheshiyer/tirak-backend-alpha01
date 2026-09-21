export function isPublicImageUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;

  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export function publicProfileImages(value: unknown): string[] {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value.filter(isPublicImageUrl);
  }

  if (typeof value !== 'string') return [];

  const trimmed = value.trim();
  if (!trimmed) return [];

  if (!trimmed.startsWith('[')) {
    return isPublicImageUrl(trimmed) ? [trimmed] : [];
  }

  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed.filter(isPublicImageUrl) : [];
  } catch {
    return [];
  }
}

export function firstProfileImage(value: unknown): string | null {
  return publicProfileImages(value)[0] || null;
}
