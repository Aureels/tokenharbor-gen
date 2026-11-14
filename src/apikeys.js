const KEY_RE = /\b(?:sk|tk|th)-[A-Za-z0-9_-]{16,}\b/;

function deepFind(value, out) {
  if (typeof value === 'string') {
    if (KEY_RE.test(value)) out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(v => deepFind(v, out));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [name, v] of Object.entries(value)) {
      if (typeof v === 'string' && v.length > 16 && /key|secret|token/i.test(name)) out.add(v);
      else deepFind(v, out);
    }
  }
}

async function readKeys(page) {
  return page.evaluate(async () => {
    const res = await fetch('/api/keys', { headers: { accept: 'application/json' } });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  });
}

async function createKey(page, name) {
  return page.evaluate(async keyName => {
    const res = await fetch('/api/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ name: keyName })
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  }, name);
}

async function scanDom(page) {
  return page.evaluate(() => {
    const vals = [...document.querySelectorAll('input,textarea,code,pre')].map(el => el.value || el.textContent || '');
    vals.push(document.body.innerText);
    return vals.join('\n');
  });
}

export async function fetchKeys(page, { info = () => {}, debug = () => {} } = {}) {
  const keys = new Set();

  const current = await readKeys(page);
  if (current.status === 200) {
    deepFind(current.json ?? current.text, keys);
  } else {
    debug(`keys: GET /api/keys -> ${current.status}`);
  }

  if (!keys.size) {
    const name = `key-${Math.random().toString(36).slice(2, 8)}`;
    const created = await createKey(page, name);
    if (created.status >= 200 && created.status < 300) {
      deepFind(created.json ?? created.text, keys);
    } else {
      debug(`keys: POST /api/keys -> ${created.status} ${created.text.slice(0, 120)}`);
    }
  }

  if (!keys.size) {
    const dom = await scanDom(page).catch(() => '');
    for (const m of dom.matchAll(/\b(?:sk|tk|th)-[A-Za-z0-9_-]{16,}\b/g)) keys.add(m[0]);
  }

  const result = [...keys];
  if (result.length) info(`keys: ${result.length} found`);
  else debug('keys: none found');
  return result;
}
