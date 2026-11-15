import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import UserAgent from 'user-agents';
import fs from 'fs-extra';
import { SingleBar, Presets } from 'cli-progress';
import chalk from 'chalk';
import { loginAndFetchKeys, runAccount } from './src/account.js';
import { cached, lookup } from './src/geo.js';
import { hostOf, loadProxies, validateProxies } from './src/proxy.js';

if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.XVFB_WRAPPED) {
  const res = spawnSync('xvfb-run', ['-a', ...process.argv], {
    stdio: 'inherit',
    env: { ...process.env, XVFB_WRAPPED: '1' }
  });
  if (res.error) console.log(chalk.yellow('[warn] xvfb-run unavailable, trying headful without display'));
  else process.exit(res.status ?? 1);
}

chromium.use(StealthPlugin());

const ARGS = process.argv.slice(2);
const USE_PROXY = ARGS.includes('--proxy');
const DEBUG = ARGS.includes('--debug');
const COUNT = parseInt(ARGS.find(a => /^\d+$/.test(a))) || 1;

const CFG = {
  url: 'https://tokenharbor.ai',
  path: '/login?mode=signup',
  outFile: 'list.json',
  proxyFile: 'proxies.txt',
  timeout: 30000,
  attempts: 3,
  turnstileTimeout: 20000,
  mailPolls: 30,
  mailInterval: 5000,
  delay: [5000, 15000]
};

const CHROME_PATHS = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'];
const CHANNEL = CHROME_PATHS.some(p => fs.existsSync(p)) ? 'chrome' : undefined;

const C = { s: chalk.green, e: chalk.red, w: chalk.yellow, i: chalk.cyan, d: chalk.gray };
const info = msg => console.log(C.i(msg));
const debug = msg => { if (DEBUG) console.log(C.d(msg)); };

class Gen {
  constructor() {
    this.proxies = [];
    this.agents = [];
    this.accounts = [];
    this.stats = { ok: 0, fail: 0 };
    this.bar = new SingleBar({
      format: `${C.i('[{bar}]')} {percentage}% | {value}/{total} | ✓{success} ✗{failed}`,
      barCompleteChar: '█',
      barIncompleteChar: '░',
      hideCursor: true
    }, Presets.shades_classic);
  }

  async init() {
    await Promise.all([this.loadProxy(), this.loadAgents(), this.loadAccounts()]);
    info(`[init] ${USE_PROXY ? this.proxies.length + ' proxies' : 'direct (no proxy)'}, ${this.agents.length} UAs, ${this.accounts.length} saved`);
    return this;
  }

  async loadProxy() {
    if (!USE_PROXY) return;
    const list = await loadProxies(CFG.proxyFile, debug);
    if (!list.length) {
      console.log(C.w('[warn] proxies.txt empty, running direct'));
      return;
    }
    info(`[proxy] validating ${list.length} proxies...`);
    this.proxies = await validateProxies(list, debug);
    info(`[proxy] ${this.proxies.length} alive`);
    if (!this.proxies.length) {
      console.log(C.w('[warn] no alive proxies, running direct'));
      return;
    }
    const hosts = this.proxies.map(hostOf).filter(Boolean);
    await lookup(hosts);
    debug(`[geo] resolved ${hosts.filter(h => cached(h)).length}/${hosts.length} proxy locations`);
  }

  async loadAgents() {
    for (let i = 0; i < 100; i++) this.agents.push(new UserAgent({ deviceCategory: 'desktop' }).toString());
  }

  async loadAccounts() {
    try {
      this.accounts = JSON.parse(await fs.readFile(CFG.outFile, 'utf-8'));
    } catch {
      this.accounts = [];
    }
  }

  async save() {
    const tmp = `${CFG.outFile}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.accounts, null, 2));
    await fs.rename(tmp, CFG.outFile);
  }

  launch() {
    return chromium.launch({
      headless: false,
      channel: CHANNEL,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1366,768'
      ]
    });
  }

  async run(n) {
    info(`[start] ${n} accounts`);
    this.bar.start(n, 0, { success: 0, failed: 0 });

    const browser = await this.launch();

    try {
      for (let i = 0; i < n; i++) {
        const result = await runAccount({ browser, cfg: CFG, proxies: this.proxies, agents: this.agents, info, debug });

        if (result.ok && !this.accounts.some(a => a.email === result.account.email)) {
          this.accounts.push(result.account);
          await this.save();
          this.stats.ok++;
          const keyCount = result.account.keys.length;
          console.log(C.s(`[ok] ${result.account.email} (${keyCount} key${keyCount === 1 ? '' : 's'}, free: ${result.account.free_model})`));
        } else if (!result.ok) {
          this.stats.fail++;
          console.log(C.e(`[fail] ${result.error}`));
        }

        this.bar.increment(1, { success: this.stats.ok, failed: this.stats.fail });
        if (i < n - 1) await new Promise(r => setTimeout(r, Math.random() * (CFG.delay[1] - CFG.delay[0]) + CFG.delay[0]));
      }
    } finally {
      await browser.close().catch(() => {});
    }

    this.bar.stop();
    console.log(C.i('\n[done]'));
    console.log(C.s(`  ok: ${this.stats.ok}`));
    console.log(C.e(`  fail: ${this.stats.fail}`));
    console.log(C.i(`  file: ${CFG.outFile}`));
  }

  async runPrune() {
    const kept = [];
    const total = this.accounts.length;
    const browser = await this.launch();
    try {
      for (const account of this.accounts) {
        if (!account.keys?.length) {
          console.log(C.e(`[drop] ${account.email}: no key`));
          continue;
        }
        const result = await loginAndFetchKeys({ browser, cfg: CFG, agents: this.agents, account, info, debug });
        if (result.ok && ['active', 'quota'].includes(result.free.status)) {
          account.keys = result.keys;
          account.free_model = result.free.status;
          kept.push(account);
          console.log(C.s(`[keep] ${account.email} (${result.free.status})`));
        } else {
          console.log(C.e(`[drop] ${account.email}: ${result.ok ? result.free.status : result.error}`));
        }
      }
    } finally {
      await browser.close().catch(() => {});
    }
    this.accounts = kept;
    await this.save();
    console.log(C.i(`[prune] kept ${kept.length}/${total} — file: ${CFG.outFile}`));
  }

  async runKeys() {
    const targets = this.accounts.filter(a => a.email && a.password);
    if (!targets.length) {
      console.log(C.w('[warn] no accounts with credentials in list.json'));
      return;
    }
    info(`[keys] ${targets.length} account(s)`);

    const browser = await this.launch();
    try {
      for (const account of targets) {
        const result = await loginAndFetchKeys({ browser, cfg: CFG, agents: this.agents, account, info, debug });
        if (!result.ok) {
          console.log(C.e(`[fail] ${account.email}: ${result.error}`));
          continue;
        }
        account.keys = result.keys;
        account.free_model = result.free.status;
        await this.save();
        console.log(C.s(`[ok] ${account.email} (${result.keys.length} key${result.keys.length === 1 ? '' : 's'}, free: ${result.free.status})`));
      }
    } finally {
      await browser.close().catch(() => {});
    }

    console.log(C.i(`  file: ${CFG.outFile}`));
  }
}

new Gen().init().then(g => {
  if (ARGS.includes('--prune')) return g.runPrune();
  if (ARGS.includes('--keys')) return g.runKeys();
  return g.run(COUNT);
}).catch(e => {
  console.error(C.e(e.message));
  process.exit(1);
});
