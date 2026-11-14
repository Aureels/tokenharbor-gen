import { fetchKeys } from './apikeys.js';
import { createMail, extractCode, fetchInbox } from './mail.js';
import { applyStealth } from './fingerprint.js';
import { cached, self } from './geo.js';
import { hostOf, pick, toPlaywrightProxy } from './proxy.js';
import { waitForReady } from './turnstile.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const SEL = {
  email: 'input[name="email"]',
  password: 'input[name="password"]',
  invite: 'input[name="invite_code"]',
  age: 'input[type="checkbox"]',
  submit: 'button[type="submit"]',
  alerts: '[role="alert"],[aria-live="polite"],[aria-invalid="true"]'
};

function strongPass() {
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*_-+=';
  let out = '';
  for (let i = 0; i < 16; i++) out += charset[Math.floor(Math.random() * charset.length)];
  return out;
}

async function readAlerts(page) {
  return page.evaluate(sel => [...document.querySelectorAll(sel)]
    .map(el => (el.value || el.innerText || '').trim())
    .filter(Boolean), SEL.alerts).catch(() => []);
}

async function submit(page, email, password) {
  await page.fill(SEL.email, email);
  await page.fill(SEL.password, password);
  const invite = await page.$(SEL.invite);
  if (invite) await invite.fill('');
  const age = await page.$(SEL.age);
  if (age) await age.check().catch(() => {});
  await page.click(SEL.submit);
  await page.waitForURL(u => /dashboard|verify|success/.test(u.href), { timeout: 30000 }).catch(() => {});

  const alerts = await readAlerts(page);
  if (alerts.length) return { ok: false, alerts };
  const url = page.url();
  if (/dashboard|verify|success/.test(url)) return { ok: true, url };
  return { ok: false, alerts: ['no redirect'] };
}

async function verify(page, baseUrl, code) {
  try {
    await page.goto(`${baseUrl}/verify?code=${encodeURIComponent(code)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const text = await page.evaluate(() => document.body.innerText);
    if (/invalid|expired/i.test(text)) return false;
    return /verified|success/i.test(text) || /dashboard/.test(page.url());
  } catch {
    return false;
  }
}

async function waitForCode(page, cfg, email, ua, log) {
  for (let i = 0; i < cfg.mailPolls; i++) {
    await sleep(cfg.mailInterval);
    const code = extractCode(await fetchInbox(email, ua, log));
    if (!code) continue;
    log(`code: ${code}`);
    return verify(page, cfg.url, code);
  }
  return false;
}

export async function runAccount({ browser, cfg, proxies, agents, info, debug }) {
  let email = null;
  let lastError = 'unknown';

  for (let attempt = 1; attempt <= cfg.attempts; attempt++) {
    const proxyUrl = proxies.length ? pick(proxies) : null;
    const ua = pick(agents);
    const geoInfo = proxyUrl ? cached(hostOf(proxyUrl)) : await self();
    const options = {
      userAgent: ua,
      viewport: { width: 1366, height: 768 },
      locale: 'en-US',
      ignoreHTTPSErrors: true
    };
    if (geoInfo?.timezone) options.timezoneId = geoInfo.timezone;
    if (proxyUrl) options.proxy = toPlaywrightProxy(proxyUrl);
    const context = await browser.newContext(options);
    let submitted = false;

    try {
      await applyStealth(context);
      const page = await context.newPage();

      if (!email) email = await createMail(ua, debug);
      info(`acc: ${email} via ${proxyUrl || 'direct'} (attempt ${attempt})`);

      await page.goto(`${cfg.url}${cfg.path}`, { waitUntil: 'domcontentloaded', timeout: cfg.timeout });

      if (!(await waitForReady(page, { timeout: cfg.turnstileTimeout, log: debug }))) {
        throw new Error('turnstile timeout');
      }

      let password = strongPass();
      submitted = true;
      let result = await submit(page, email, password);
      if (!result.ok && result.alerts.some(a => /password/i.test(a))) {
        password = strongPass();
        result = await submit(page, email, password);
      }

      const used = email;
      email = null;
      if (!result.ok) throw new Error(result.alerts.join('; '));

      if (/verify/.test(result.url)) {
        if (!(await waitForCode(page, cfg, used, ua, debug))) throw new Error('verify failed');
      }

      const keys = await fetchKeys(page, { info, debug }).catch(e => {
        debug(`keys: ${e.message}`);
        return [];
      });

      return {
        ok: true,
        account: {
          email: used,
          password,
          keys,
          createdAt: new Date().toISOString(),
          proxy: proxyUrl || 'none'
        }
      };
    } catch (e) {
      lastError = e.message;
      if (submitted) email = null;
      debug(`attempt ${attempt} failed: ${e.message}`);
    } finally {
      await context.close().catch(() => {});
    }
  }

  return { ok: false, error: lastError };
}
