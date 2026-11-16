import axios from 'axios';

const CHAT_API = 'https://tokenharbor.ai/v1/chat/completions';
const PROBE_MODEL = 'deepseek-v4.1-flash:free';

export async function checkFreeModel(key, { model = PROBE_MODEL, timeout = 60000, retries = 2 } = {}) {
  let last = { status: 'error', code: 0, detail: 'no attempt' };

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 3000));
    last = await once(key, model, timeout);
    if (last.status !== 'error') return last;
    if (last.code && last.code !== 0 && last.code < 500) return last;
  }

  return last;
}

async function once(key, model, timeout) {
  try {
    const res = await axios.post(
      CHAT_API,
      { model, messages: [{ role: 'user', content: 'hi' }] },
      {
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0'
        },
        timeout,
        validateStatus: () => true
      }
    );

    if (res.status === 200) return { status: 'active', code: 200 };
    if (res.status === 429) return { status: 'quota', code: 429 };

    const body = JSON.stringify(res.data || {});
    if (res.status === 403 && /free_models_disabled/.test(body)) return { status: 'disabled', code: 403 };

    const detail = res.data?.error?.code || res.data?.error?.type || body.slice(0, 80);
    return { status: 'error', code: res.status, detail: String(detail) };
  } catch (e) {
    return { status: 'error', code: 0, detail: e.message };
  }
}

async function privacy(page) {
  return page.evaluate(async () => {
    const res = await fetch('/api/me/privacy', { headers: { accept: 'application/json' } });
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, data };
  }).catch(() => null);
}

export async function enableFreeModels(page, { info = () => {}, debug = () => {} } = {}) {
  await page.waitForSelector('[role="switch"], button:has-text("Enable free models")', { timeout: 10000 }).catch(() => {});

  const before = await privacy(page);
  if (before?.data?.free_models_enabled) {
    debug('free models: already enabled');
    return true;
  }

  const button = page.getByRole('button', { name: /enable free models/i }).first();
  if (await button.count()) {
    await button.click({ timeout: 5000 }).catch(e => debug(`free models: modal click: ${e.message}`));
  } else {
    const toggle = page.locator('[role="switch"]').first();
    if (await toggle.count()) {
      await toggle.click({ timeout: 5000 }).catch(e => debug(`free models: switch click: ${e.message}`));
    }
  }
  await page.waitForTimeout(4000);

  let after = await privacy(page);
  if (after?.data?.free_models_enabled !== true) {
    const toggle = page.locator('[role="switch"]').first();
    if (await toggle.count()) {
      await toggle.click({ timeout: 5000 }).catch(e => debug(`free models: retry click: ${e.message}`));
      await page.waitForTimeout(3000);
      after = await privacy(page);
    }
  }

  const ok = after?.data?.free_models_enabled === true;
  if (ok) info('free models enabled');
  else debug('free models: not enabled');
  return ok;
}
