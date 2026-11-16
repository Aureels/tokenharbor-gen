import { fetchKeys } from './apikeys.js';
import { checkFreeModel, enableFreeModels } from './freemodels.js';
import { createMail, extractCode, extractVerifyLink, fetchInbox } from './mail.js';
import { applyStealth, randomProfile } from './fingerprint.js';
import { cached, self } from './geo.js';
import { hostOf, markProxy, markSuccess, pick, toPlaywrightProxy } from './proxy.js';
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
  await page.fill(SEL.email, email, { timeout: 20000 });
  await page.fill(SEL.password, password, { timeout: 20000 });
  const invite = await page.$(SEL.invite);
  if (invite) await invite.fill('', { timeout: 5000 }).catch(() => {});
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

async function pickFreeKey(keys) {
  let first = null;
  for (const key of keys) {
    const result = await checkFreeModel(key);
    if (!first) first = result;
    if (result.status === 'active') return { key, free: result };
  }
  return { key: keys[0] || null, free: first || { status: 'no-key', code: 0 } };
}

async function waitForVerifyLink(page, cfg, mail, ua, log) {
  for (let i = 0; i < cfg.mailPolls; i++) {
    await sleep(cfg.mailInterval);
    const emails = await fetchInbox(mail, ua, log);

    const link = extractVerifyLink(emails);
    if (link) {
      await page.goto(link, { waitUntil: 'domcontentloaded', timeout: cfg.timeout });
      log('email verified');
      return true;
    }

    const code = extractCode(emails);
    if (code) {
      log(`code: ${code}`);
      return verify(page, cfg.url, code);
    }
  }
  return false;
}

export async function runAccount({ browser, cfg, proxies, agents, info, debug }) {
  let mail = null;
  let lastError = 'unknown';

  for (let attempt = 1; attempt <= cfg.attempts; attempt++) {
    const proxyUrl = proxies.length ? pick(proxies) : null;
    const ua = pick(agents);
    const geoInfo = proxyUrl ? cached(hostOf(proxyUrl)) : await self();
    const profile = randomProfile();
    const options = {
      userAgent: ua,
      viewport: profile.viewport,
      locale: 'en-US',
      ignoreHTTPSErrors: true
    };
    if (geoInfo?.timezone) options.timezoneId = geoInfo.timezone;
    if (proxyUrl) options.proxy = toPlaywrightProxy(proxyUrl);
    const context = await browser.newContext(options);
    let submitted = false;

    try {
      await applyStealth(context, profile);
      const page = await context.newPage();
      await page.route('**/*', route => {
        const type = route.request().resourceType();
        return ['image', 'media', 'font'].includes(type) ? route.abort() : route.continue();
      });

      await page.goto(`${cfg.url}${cfg.path}`, { waitUntil: 'domcontentloaded', timeout: cfg.timeout });

      if (!(await waitForReady(page, { timeout: cfg.turnstileTimeout, log: debug }))) {
        throw new Error('turnstile timeout');
      }

      if (!mail) mail = await createMail(ua, debug);
      info(`acc: ${mail.email} via ${proxyUrl || 'direct'} (attempt ${attempt})`);

      let password = strongPass();
      submitted = true;
      let result = await submit(page, mail.email, password);
      if (!result.ok && result.alerts.some(a => /password/i.test(a))) {
        password = strongPass();
        result = await submit(page, mail.email, password);
      }

      const used = mail;
      mail = null;
      if (!result.ok) throw new Error(result.alerts.join('; '));

      await enableFreeModels(page, { info, debug }).catch(e => debug(`free models: ${e.message}`));

      const keys = await fetchKeys(page, { info, debug }).catch(e => {
        debug(`keys: ${e.message}`);
        return [];
      });

      const verified = await waitForVerifyLink(page, cfg, used, ua, debug).catch(() => false);
      if (/verify/.test(result.url) && !verified) throw new Error('verify failed');

      let picked = await pickFreeKey(keys);
      if (picked.free.status === 'error') {
        await sleep(5000);
        const retry = await pickFreeKey(keys);
        if (retry.free.status !== 'error') picked = retry;
      }
      const free = picked.free;
      if (free.status === 'active') info('free model: active');
      else debug(`free model: ${free.status} (${free.code}${free.detail ? ` ${free.detail}` : ''})`);

      if (proxyUrl) markSuccess(proxyUrl);

      return {
        ok: true,
        account: {
          email: used.email,
          mail_token: used.token || undefined,
          password,
          keys: picked.key ? [picked.key] : [],
          free_model: free.status,
          createdAt: new Date().toISOString(),
          proxy: proxyUrl || 'none'
        }
      };
    } catch (e) {
      lastError = e.message;
      if (submitted) mail = null;

      if (proxyUrl) {
        if (/Too many sign-ups|can't create another account/i.test(e.message)) markProxy(proxyUrl, 20, 'network-limit');
        else if (/turnstile timeout/i.test(e.message)) markProxy(proxyUrl, 8, 'turnstile');
        else if (/ERR_TUNNEL|ERR_PROXY|ERR_EMPTY|ERR_CONNECTION|Timeout/i.test(e.message)) markProxy(proxyUrl, 8, 'dead');
      }

      debug(`attempt ${attempt} failed: ${e.message}`);
    } finally {
      await context.close().catch(() => {});
    }
  }

  return { ok: false, error: lastError };
}

export async function loginAndFetchKeys({ browser, cfg, agents, account, info, debug, attemptVerify = false }) {
  const geoInfo = await self();
  const options = {
    userAgent: pick(agents),
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
    ignoreHTTPSErrors: true
  };
  if (geoInfo?.timezone) options.timezoneId = geoInfo.timezone;

  const context = await browser.newContext(options);
  try {
    await applyStealth(context);
    const page = await context.newPage();
    info(`login: ${account.email}`);

    await page.goto(`${cfg.url}/login`, { waitUntil: 'domcontentloaded', timeout: cfg.timeout });
    if (!(await waitForReady(page, { timeout: cfg.turnstileTimeout, log: debug }))) {
      throw new Error('turnstile timeout');
    }

    await page.fill(SEL.email, account.email);
    await page.fill(SEL.password, account.password);
    await page.click(SEL.submit);
    await page.waitForURL(/dashboard/, { timeout: 30000 }).catch(() => {});

    if (!/dashboard/.test(page.url())) {
      const alerts = await readAlerts(page);
      throw new Error(alerts.join('; ') || `login stuck at ${page.url()}`);
    }

    await enableFreeModels(page, { info, debug }).catch(e => debug(`free models: ${e.message}`));

    if (attemptVerify) {
      const verified = await waitForVerifyLink(page, cfg, { email: account.email, token: account.mail_token }, pick(agents), debug).catch(() => false);
      debug(`verify attempt: ${verified ? 'ok' : 'no link'}`);
      if (verified && /login/.test(page.url())) {
        await page.fill(SEL.email, account.email).catch(() => {});
        await page.fill(SEL.password, account.password).catch(() => {});
        await page.click(SEL.submit).catch(() => {});
        await page.waitForURL(/dashboard/, { timeout: 30000 }).catch(() => {});
      }
    }

    if (account.keys?.length) {
      const existing = await pickFreeKey(account.keys);
      if (existing.free.status === 'active' || existing.free.status === 'quota') {
        info(`free model: ${existing.free.status}`);
        return { ok: true, keys: account.keys, free: existing.free };
      }
    }

    const keys = await fetchKeys(page, { info, debug });
    const picked = await pickFreeKey(keys);
    if (picked.free.status === 'active') info('free model: active');
    else debug(`free model: ${picked.free.status} (${picked.free.code})`);

    return { ok: true, keys: picked.key ? [picked.key] : [], free: picked.free };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    await context.close().catch(() => {});
  }
}
