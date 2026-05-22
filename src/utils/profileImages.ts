export function firstProfileImage(value: unknown): string | null {
  if (!value) return null;

  if (Array.isArray(value)) {
    return typeof value[0] === 'string' && value[0].length > 0 ? value[0] : null;
  }

  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  if (!trimmed.startsWith('[')) {
    return trimmed;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) && typeof parsed[0] === 'string' && parsed[0].length > 0
      ? parsed[0]
      : null;
  } catch {
    return trimmed;
  }
}
