import { Hono } from 'hono';

// Kept on the API origin so the email fallback works independently of marketing hosting.
export const passwordResetScript = String.raw`(() => {
  const form = document.getElementById('reset-form');
  const status = document.getElementById('status');
  const button = document.getElementById('submit');
  const password = document.getElementById('password');
  const confirmation = document.getElementById('confirmation');
  const url = new URL(window.location.href);
  let token = new URLSearchParams(url.hash.slice(1)).get('token') || url.searchParams.get('token');
  window.history.replaceState(null, '', url.pathname);
  if (!token) {
    status.textContent = 'Open the complete link from your password-reset email. If it has expired, request a new link in Tirak.';
    return;
  }
  button.disabled = false;
  let pending = false;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (pending || !token) return;
    if (password.value.length < 8) {
      status.textContent = 'Use at least 8 characters for your password.';
      return;
    }
    if (password.value !== confirmation.value) {
      status.textContent = 'The passwords do not match.';
      return;
    }
    pending = true;
    button.disabled = true;
    status.textContent = 'Updating your password…';
    try {
      const response = await fetch('/api/auth/reset-password', {
        method: 'POST', credentials: 'omit', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword: password.value })
      });
      const result = await response.json();
      if (!response.ok || result.success !== true) {
        status.textContent = response.status === 400 || response.status === 401
          ? 'This link is invalid or has expired. Request a new password-reset link in Tirak.'
          : 'Your password could not be updated. Please try again later.';
        return;
      }
      token = null;
      form.reset();
      form.hidden = true;
      status.textContent = 'Your password has been updated. Return to Tirak and sign in with your new password.';
      document.getElementById('open-app').hidden = false;
    } catch {
      status.textContent = 'Unable to connect. Check your connection and try again.';
    } finally {
      pending = false;
      button.disabled = !token;
    }
  });
})();`;

const styles = `:root{font-family:system-ui,-apple-system,sans-serif;color:#271833;background:#f7f3fa;color-scheme:light}*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px}main{width:100%;max-width:440px;padding:32px;background:white;border:1px solid #e7ddec;border-radius:24px;box-shadow:0 12px 40px #351e4810}.brand{color:#71368e;font-weight:800;font-size:24px;margin:0 0 32px}h1{font-size:28px;line-height:1.2;margin:0 0 12px}p{line-height:1.6}label{display:block;font-weight:600;margin-top:20px}input{width:100%;font:inherit;padding:12px;border:1px solid #96849f;border-radius:10px;margin-top:8px}input:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid #b886d1;outline-offset:3px}button,.app-link{font:inherit;font-weight:650;color:white;background:#71368e;border:0;border-radius:12px;padding:14px 20px;margin-top:24px;cursor:pointer}button{width:100%}button:disabled{opacity:.55;cursor:default}.app-link{display:inline-block;text-decoration:none}.app-link[hidden]{display:none}#status{min-height:26px;color:#574263}small{display:block;margin-top:8px;color:#66586d}`;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow"><title>Reset your password · Tirak</title><link rel="stylesheet" href="/auth/reset.css"><script src="/auth/reset.js" defer></script></head><body><main><p class="brand">tirak</p><h1>Choose a new password</h1><p>Use a password you don’t use for other accounts.</p><form id="reset-form"><label for="password">New password</label><input id="password" type="password" autocomplete="new-password" minlength="8" required aria-describedby="password-help"><small id="password-help">At least 8 characters.</small><label for="confirmation">Confirm new password</label><input id="confirmation" type="password" autocomplete="new-password" minlength="8" required><button id="submit" type="submit" disabled>Update password</button></form><p id="status" role="status" aria-live="polite"></p><noscript>JavaScript is required to securely reset your password. Enable it and reopen your email link.</noscript><a id="open-app" class="app-link" href="tirak://auth/login" hidden>Open Tirak</a></main></body></html>`;

export const passwordResetPageRoutes = new Hono();
passwordResetPageRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Robots-Tag', 'noindex, nofollow');
  c.header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'");
  await next();
});
passwordResetPageRoutes.get('/new', (c) => c.html(html));
passwordResetPageRoutes.get('/reset.js', (c) => c.body(passwordResetScript, 200, { 'Content-Type': 'text/javascript; charset=utf-8' }));
passwordResetPageRoutes.get('/reset.css', (c) => c.body(styles, 200, { 'Content-Type': 'text/css; charset=utf-8' }));
