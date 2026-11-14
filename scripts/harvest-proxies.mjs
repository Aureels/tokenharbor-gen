import axios from 'axios';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const SOURCES = [
  'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt',
  'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/https/data.txt'
];

const OUT = 'proxies.txt';
const CHECK_URL = 'http://api.ipify.org';
const TIMEOUT = Number(process.env.TIMEOUT || 6000);
const CONCURRENCY = Number(process.env.CONCURRENCY || 100);
const PUSH_EVERY = Number(process.env.PUSH_EVERY || 100);
const LIMIT = Number(process.env.LIMIT || 0);
const SKIP_PUSH = process.env.SKIP_PUSH === '1';
const TOKEN = process.env.GITHUB_TOKEN || '';
const REPO = process.env.REPO_URL || 'https://github.com/Aureels/tokenharbor-gen.git';

const PATTERN = /^(socks[45]|https?):\/\/(?:([^:@]+):([^@]+)@)?([^:]+):(\d+)$/;

const log = msg => console.log(`[harvest] ${msg}`);

function parse(line) {
  const m = line.trim().match(PATTERN);
  if (!m) return null;
  const [url, protocol, , , host, port] = m;
  return { url, protocol, host, port: parseInt(port) };
}

async function readOut() {
  try {
    const text = await fs.readFile(OUT, 'utf-8');
    return text.split('\n').map(parse).filter(Boolean);
  } catch {
    return [];
  }
}

async function writeOut(entries) {
  const lines = [...entries].map(e => e.url);
  await fs.writeFile(OUT, `${lines.join('\n')}\n`);
}

async function fetchSource(url) {
  const { data } = await axios.get(url, { timeout: 20000, responseType: 'text' });
  return String(data).split('\n').map(parse).filter(Boolean);
}

async function check(entry) {
  try {
    const { data } = await axios.get(CHECK_URL, {
      proxy: { protocol: entry.protocol, host: entry.host, port: entry.port },
      timeout: TIMEOUT
    });
    return typeof data === 'string' && data.trim().length > 0;
  } catch {
    return false;
  }
}

function push(count) {
  if (SKIP_PUSH) return log(`skip push (${count} active)`);
  if (!TOKEN) return log('no GITHUB_TOKEN, skipping push');
  const auth = REPO.replace('https://', `https://x-access-token:${TOKEN}@`);
  try {
    execFileSync('git', ['add', OUT], { stdio: 'inherit' });
    execFileSync('git', ['commit', '-m', `proxies: ${count} active`], { stdio: 'inherit' });
    execFileSync('git', ['push', auth, 'main'], { stdio: 'inherit' });
    log(`pushed ${count} active`);
  } catch (e) {
    log(`push failed: ${e.message}`);
  }
}

async function main() {
  const kept = await readOut();
  const seen = new Set(kept.map(e => `${e.host}:${e.port}`));
  log(`existing ${kept.length} proxies`);

  const candidates = [];
  for (const src of SOURCES) {
    const list = await fetchSource(src).catch(e => {
      log(`source failed: ${e.message}`);
      return [];
    });
    for (const entry of list) {
      const id = `${entry.host}:${entry.port}`;
      if (seen.has(id)) continue;
      seen.add(id);
      candidates.push(entry);
    }
  }

  const queue = LIMIT ? candidates.slice(0, LIMIT) : candidates;
  log(`candidates ${queue.length}`);

  const alive = new Set(kept.map(e => e.url));
  let count = kept.length;
  let threshold = Math.floor(count / PUSH_EVERY) * PUSH_EVERY + PUSH_EVERY;
  let checked = 0;

  for (let i = 0; i < queue.length; i += CONCURRENCY) {
    const chunk = queue.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map(check));
    chunk.forEach((entry, j) => {
      if (!results[j] || alive.has(entry.url)) return;
      alive.add(entry.url);
      count++;
    });
    checked += chunk.length;
    await writeOut([...alive].map(parse).filter(Boolean));
    log(`checked ${checked}/${queue.length}, active ${count}`);

    if (count >= threshold) {
      push(count);
      threshold = Math.floor(count / PUSH_EVERY) * PUSH_EVERY + PUSH_EVERY;
    }
  }

  if (count > 0) push(count);
  log(`done: ${count} active proxies in ${OUT}`);
}

main().catch(e => {
  console.error(`[harvest] fatal: ${e.message}`);
  process.exit(1);
});
