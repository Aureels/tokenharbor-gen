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
