import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { Window } from 'happy-dom';
import { passwordResetPageRoutes, passwordResetScript } from '../../src/routes/passwordResetPage';

const app = new Hono().route('/auth', passwordResetPageRoutes);
async function page(url = 'https://api.example/auth/new#token=synthetic-reset-token') {
  const window = new Window({ url, settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  const response = await app.request('/auth/new');
  window.document.write(await response.text());
  // Scripts are explicitly executed after injecting the synthetic transport.
  const transport = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
  window.fetch = transport;
  const replaceState = vi.spyOn(window.history, 'replaceState');
  window.eval(passwordResetScript);
  return { window, transport, document: window.document, replaceState };
}
async function submit(document: Window['document']) {
  document.querySelector('#reset-form')!.dispatchEvent(new (document.defaultView!.Event)('submit', { cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
}
function fill(document: Window['document'], confirm = 'test-password') {
  (document.querySelector('#password') as any).value = 'test-password';
  (document.querySelector('#confirmation') as any).value = confirm;
}

describe('password reset browser fallback', () => {
  it('serves a private non-reflecting page and same-origin resources', async () => {
    for (const path of ['/new?token=secret-never-reflect', '/reset.js', '/reset.css']) {
      const res = await app.request('/auth' + path);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(await res.text()).not.toContain('secret-never-reflect');
    }
  });
  it('removes fragment credentials immediately and submits actual API fields once', async () => {
    const { document, transport, replaceState } = await page();
    expect(replaceState).toHaveBeenCalledWith(null, '', '/auth/new');
    fill(document);
    await submit(document);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][0]).toBe('/api/auth/reset-password');
    expect(JSON.parse(transport.mock.calls[0][1].body)).toEqual({ token: 'synthetic-reset-token', newPassword: 'test-password' });
    expect((document.querySelector('#reset-form') as any).hidden).toBe(true);
    expect((document.querySelector('#password') as any).value).toBe('');
    await submit(document);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('supports existing query links and removes query credentials', async () => {
    const { document, transport, replaceState } = await page('https://api.example/auth/new?token=legacy-token');
    expect(replaceState).toHaveBeenCalledWith(null, '', '/auth/new');
    fill(document);
    await submit(document);
    expect(JSON.parse(transport.mock.calls[0][1].body).token).toBe('legacy-token');
  });
  it('keeps missing tokens and mismatched passwords from submitting', async () => {
    const missing = await page('https://api.example/auth/new');
    expect((missing.document.querySelector('#submit') as any).disabled).toBe(true);
    expect(missing.transport).not.toHaveBeenCalled();
    const mismatch = await page();
    fill(mismatch.document, 'different');
    await submit(mismatch.document);
    expect(mismatch.transport).not.toHaveBeenCalled();
    expect(mismatch.document.querySelector('#status')!.textContent).toContain('do not match');
  });
  it('rejects HTTP and application failures without displaying provider content', async () => {
    for (const ok of [false, true]) {
      const { document, transport } = await page();
      transport.mockResolvedValue({ ok, status: ok ? 200 : 400, json: async () => ({ success: false, message: 'sensitive provider detail' }) });
      fill(document);
      await submit(document);
      expect((document.querySelector('#reset-form') as any).hidden).toBe(false);
      expect(document.querySelector('#status')!.textContent).not.toContain('sensitive');
      expect(document.querySelector('#status')!.textContent).not.toContain('has been updated');
    }
  });
  it('prevents concurrent submissions and permits retry after network failure', async () => {
    const { document, transport } = await page();
    let reject!: (reason: Error) => void;
    transport.mockImplementationOnce(() => new Promise((_resolve, no) => { reject = no; }));
    fill(document);
    await submit(document);
    await submit(document);
    expect(transport).toHaveBeenCalledTimes(1);
    reject(new Error('network'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect((document.querySelector('#submit') as any).disabled).toBe(false);
    await submit(document);
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
