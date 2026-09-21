import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { uploadRoutes } from '@/routes/uploads';
import { createTestEnv } from '@tests/setup';

describe('public image delivery', () => {
  const app = new Hono();
  app.route('/uploads', uploadRoutes);

  it('serves an allowlisted R2 image without authentication', async () => {
    const env = createTestEnv();
    env.STORAGE.get = vi.fn(async () => ({
      body: 'image-bytes',
      httpEtag: '"etag-1"',
      writeHttpMetadata(headers: Headers) {
        headers.set('Content-Type', 'image/jpeg');
      },
    }));

    const response = await app.request('http://localhost/uploads/public/avatars/user/photo.jpg', {}, env as any);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('cache-control')).toContain('immutable');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toBe('image-bytes');
  });

  it.each(['documents/user/id.pdf', 'unknown/file.jpg'])('does not expose private or unknown key %s', async (key) => {
    const env = createTestEnv();
    env.STORAGE.get = vi.fn();
    const response = await app.request(`http://localhost/uploads/public/${key}`, {}, env as any);
    expect(response.status).toBe(404);
    expect(env.STORAGE.get).not.toHaveBeenCalled();
  });

  it('returns 404 when an allowlisted image is missing', async () => {
    const env = createTestEnv();
    env.STORAGE.get = vi.fn(async () => null);
    const response = await app.request('http://localhost/uploads/public/images/missing.jpg', {}, env as any);
    expect(response.status).toBe(404);
  });

  it('returns 404 for malformed percent encoding', async () => {
    const env = createTestEnv();
    env.STORAGE.get = vi.fn();
    const response = await app.request('http://localhost/uploads/public/images/%E0%A4%A', {}, env as any);
    expect(response.status).toBe(404);
    expect(env.STORAGE.get).not.toHaveBeenCalled();
  });
});
