const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function waitForReady(page, { timeout = 20000, log = () => {} } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const state = await page.evaluate(() => ({
      token: document.querySelector('input[name="cf-turnstile-response"]')?.value || '',
      form: !!document.querySelector('input[name="email"]'),
      challenge: document.body.innerText.includes('Quick human check')
    })).catch(() => null);

    if (state?.token || state?.form) return true;
    if (state && !state.challenge && Date.now() - started > 5000) return true;

    await sleep(1000);
  }
  log(`turnstile: timeout after ${timeout}ms`);
  return false;
}
