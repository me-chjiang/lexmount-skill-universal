#!/usr/bin/env node
// AI 辅助生成（Claude Code）。用 Lexmount 抓取网页正文，输出 markdown。
// 公开页：先走 Web Fetch API（快、不占 Browser hours），失败、正文过短或遇到验证页再升级到云浏览器。
// 需登录的页：先由用户运行 login 把登录态存进 Lexmount 持久化 context，之后用 --profile 只读抓取。
// 用法：
//   node fetch.mjs <url> [--browser] [--wait <selector>] [--max-chars N]
//   node fetch.mjs <url> --profile <name> [--wait <selector>] [--max-chars N]
//   node fetch.mjs login <name> [--interactive] [--retry]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { Lexmount } from 'lexmount';
import { parse } from 'yaml';

const NAV_TIMEOUT_MS = 45_000;
// JS 渲染的页面经 Web Fetch 往往只剩空壳，正文低于此长度就升级到云浏览器
const MIN_TEXT_CHARS = 100;
// 反爬验证页常返回 HTTP 200 且有正文，只能按标题和地址识别
const CHALLENGE = /安全验证|验证码|人机验证|captcha|just a moment|attention required|access denied|are you a robot|verify you are human/i;
// 登录态、context ID 和失败截图放在仓库之外，不会被误提交
const STATE_DIR = join(homedir(), '.local', 'state', 'lexmount-fetch');
const STATE_FILE = join(STATE_DIR, 'state.json');
const USAGE = `用法：
  node fetch.mjs <http(s)://url> [--browser] [--wait <selector>] [--max-chars N]
  node fetch.mjs <http(s)://url> --profile <name> [--wait <selector>] [--max-chars N]
  node fetch.mjs login <name> [--interactive] [--retry]`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    browser: { type: 'boolean', default: false },
    profile: { type: 'string' },
    interactive: { type: 'boolean', default: false },
    retry: { type: 'boolean', default: false },
    wait: { type: 'string' },
    'max-chars': { type: 'string', default: '20000' },
  },
});

class FetchError extends Error {
  // final：再换方式也没用，不要降级到云浏览器；code 为进程退出码
  constructor(message, { final = false, code = 1 } = {}) {
    super(message);
    this.final = final;
    this.code = code;
  }
}

function findConfig() {
  if (process.env.LEXMOUNT_CONFIG) return process.env.LEXMOUNT_CONFIG;
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const candidate = join(dir, 'lexmount-config.yaml');
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) break;
  }
  const global = join(homedir(), '.config', 'lexmount', 'config.yaml');
  if (existsSync(global)) return global;
  throw new Error('找不到 lexmount-config.yaml：设置 LEXMOUNT_CONFIG，或放在项目根目录 / ~/.config/lexmount/config.yaml');
}

// connectUrl 能接管云浏览器，会出现在 Playwright 报错里
function redact(text, secrets) {
  let out = String(text).replace(/\bwss?:\/\/\S+/g, 'ws://<redacted>');
  for (const s of secrets) if (s) out = out.split(String(s)).join('<redacted>');
  return out;
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function loadProfile(config, name) {
  const p = config['fetch-profiles']?.[name];
  if (!p) throw new FetchError(`lexmount-config.yaml 里没有 fetch-profiles.${name}`, { final: true, code: 2 });
  return {
    ...p,
    name,
    // 配置里只写凭据所在的键名，凭据本身只存一处
    user: config[p.username],
    pass: config[p.password],
    allowHosts: p['allow-hosts'] ?? [],
    denyPaths: (p['deny-paths'] ?? []).map((s) => new RegExp(s, 'i')),
    secrets: [config[p.username], config[p.password], ...(p.redact ?? [])],
  };
}

function policyViolation(profile, target, method = 'GET') {
  const { protocol, host, pathname } = new URL(target);
  if (method !== 'GET') return `禁止 ${method} 请求`;
  if (!/^https?:$/.test(protocol)) return `禁止 ${protocol} 地址`;
  if (!profile.allowHosts.includes(host)) return `域名 ${host} 不在 allow-hosts 中`;
  const denied = profile.denyPaths.find((re) => re.test(pathname));
  if (denied) return `路径 ${pathname} 命中 deny-paths ${denied}`;
  return null;
}

function challengeReason({ title, finalUrl }) {
  const { host, pathname } = new URL(finalUrl);
  if (CHALLENGE.test(title ?? '')) return `标题「${title}」`;
  if (CHALLENGE.test(host + pathname)) return `跳转到 ${host}${pathname}`;
  return null;
}

async function fetchWithWebFetch(config, url) {
  const baseUrl = (config['base-url'] || 'https://api.lexmount.cn').replace(/\/$/, '');
  const res = await fetch(`${baseUrl}/v1/extract`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': config['api-key'],
      'X-Project-Id': config['project-id'],
    },
    body: JSON.stringify({ extract: { url } }),
    signal: AbortSignal.timeout(40_000),
  });
  const body = await res.json().catch(() => ({}));
  if (body.error?.code === 'http_status_not_ok') {
    // 目标页本身 4xx/5xx，换云浏览器也一样，不再浪费 Browser hours
    throw new FetchError(`目标页返回 HTTP ${body.error.upstream_status_code ?? '?'}`, { final: true });
  }
  if (!res.ok || body.error) {
    const code = body.error?.code ?? body.error ?? body.message ?? '';
    throw new FetchError(`Web Fetch HTTP ${res.status} ${typeof code === 'string' ? code : JSON.stringify(code)}`);
  }
  const r = body.result ?? {};
  const result = { title: r.title, text: r.main_text ?? '', finalUrl: r.final_url ?? url, status: r.status_code ?? null, engine: r.engine };
  const challenge = challengeReason(result);
  if (challenge) throw new FetchError(`Web Fetch 遇到验证页（${challenge}）`);
  if (result.text.trim().length < MIN_TEXT_CHARS) throw new FetchError(`Web Fetch 正文过短（${result.text.trim().length} 字符）`);
  return result;
}

async function withBrowser(config, secrets, makeSessionOptions, fn) {
  const client = new Lexmount({
    apiKey: config['api-key'],
    projectId: config['project-id'],
    baseUrl: config['base-url'],
  });
  let session;
  let browser;
  try {
    session = await client.sessions.create({ browserMode: 'normal', ...(await makeSessionOptions(client)) });
    browser = await chromium.connectOverCDP(session.connectUrl);
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultTimeout(NAV_TIMEOUT_MS);
    return await fn({ session, context, page });
  } catch (e) {
    const own = e instanceof FetchError;
    throw new FetchError(redact(e.message, [session?.connectUrl, config['api-key'], ...secrets]), {
      final: own && e.final,
      code: own ? e.code : 1,
    });
  } finally {
    // Browser hours 计费且并发有限，任何路径都要释放云端会话；readWrite context 在关闭时才保存
    try {
      await browser?.close();
    } finally {
      try {
        await session?.close();
      } finally {
        client.close();
      }
    }
  }
}

async function extract(page, url) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (response && response.status() >= 400) throw new FetchError(`目标页返回 HTTP ${response.status()}`);
  if (opts.wait) await page.waitForSelector(opts.wait);
  else await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  const extracted = await page.evaluate(() => {
    const main = document.querySelector('main, article, [role="main"]');
    const root = main && main.innerText.trim().length > 200 ? main : document.body;
    return { title: document.title, text: root.innerText };
  });
  // 错误页上 page.url() 会停在 about:blank，此时以响应地址为准
  const finalUrl = page.url() === 'about:blank' && response ? response.url() : page.url();
  const result = { ...extracted, finalUrl, status: response?.status() ?? null };
  const challenge = challengeReason(result);
  if (challenge) throw new FetchError(`被反爬验证页拦截（${challenge}）`);
  return result;
}

async function fetchPublic(config, url) {
  if (!opts.browser && !opts.wait) {
    try {
      const result = await fetchWithWebFetch(config, url);
      return render({ ...result, via: `Lexmount Web Fetch（engine ${result.engine ?? '?'}）` });
    } catch (e) {
      if (e.final) throw e;
      console.error(`${redact(e.message, [config['api-key']])}，改用云浏览器`);
    }
  }
  return withBrowser(config, [], () => ({}), async ({ session, page }) => {
    const result = await extract(page, url);
    return render({ ...result, via: `Lexmount 云浏览器（session ${session.id}）` });
  });
}

async function fetchWithProfile(config, url) {
  const profile = loadProfile(config, opts.profile);
  const violation = policyViolation(profile, url);
  if (violation) throw new FetchError(`策略拒绝：${violation}`, { code: 3 });
  const contextId = readState()[profile.name]?.contextId;
  if (!contextId) throw new FetchError(`profile ${profile.name} 尚未登录，请让用户运行 login`, { code: 4 });
  const loggedOut = profile['logged-out'] && new RegExp(profile['logged-out']);

  const out = await withBrowser(
    config,
    profile.secrets,
    () => ({ context: { id: contextId, mode: profile['context-mode'] ?? 'readOnly' } }),
    async ({ session, context, page }) => {
      const blocked = [];
      // 拦住页面脚本或重定向触发的越权跳转：只放行 allow-hosts 内、未命中 deny-paths 的 GET 导航
      await context.route('**/*', (route, request) => {
        if (request.isNavigationRequest()) {
          const v = policyViolation(profile, request.url(), request.method());
          if (v) {
            blocked.push(v);
            return route.abort('blockedbyclient');
          }
        }
        return route.continue();
      });
      try {
        for (const w of profile.warmup ?? []) await page.goto(w, { waitUntil: 'domcontentloaded' });
        const result = await extract(page, url);
        if (loggedOut?.test(result.finalUrl)) {
          throw new FetchError(`profile ${profile.name} 登录态已失效，请让用户运行 login`, { code: 4 });
        }
        return render({ ...result, via: `Lexmount 云浏览器（profile ${profile.name}，session ${session.id}）` });
      } catch (e) {
        if (blocked.length) throw new FetchError(`策略拒绝：${blocked.join('；')}`, { code: 3 });
        throw e;
      }
    },
  );
  return redact(out, profile.secrets);
}

async function login(config, name) {
  const profile = loadProfile(config, name);
  if (!profile.user || !profile.pass) throw new FetchError(`profile ${name} 引用的用户名或密码为空`, { code: 2 });
  const state = readState();
  const entry = (state[name] ??= {});
  if (entry.loginFailedAt && !opts.retry) {
    throw new FetchError(
      `profile ${name} 上次登录失败（${entry.loginFailedAt}），为避免锁号不自动重试。由用户排查后加 --retry 重跑`,
      { code: 4 },
    );
  }
  const loggedIn = new RegExp(profile['logged-in']);
  const sel = profile.selectors;

  return withBrowser(
    config,
    profile.secrets,
    async (client) => {
      if (!entry.contextId) {
        entry.contextId = (await client.contexts.create({ description: `lexmount-fetch ${name}` })).id;
        writeState(state);
      }
      return { context: { id: entry.contextId, mode: 'readWrite' } };
    },
    async ({ session, page }) => {
      await page.goto(profile['login-url'], { waitUntil: 'domcontentloaded' });
      if (loggedIn.test(page.url())) return `profile ${name} 已处于登录状态`;
      const scope = sel.frame ? page.frameLocator(sel.frame) : page;
      const field = (s) => scope.locator(s).filter({ visible: true }).first();
      let submitted = false;
      try {
        await field(sel.username).fill(profile.user, { timeout: 15_000 });
        await field(sel.password).fill(profile.pass, { timeout: 15_000 });
        submitted = true;
        const done = page.waitForURL(loggedIn, { timeout: opts.interactive ? 300_000 : 20_000 });
        await field(sel.submit).click();
        if (opts.interactive) {
          const quick = await Promise.race([done.then(() => true), new Promise((r) => setTimeout(r, 5_000, false))]);
          if (!quick) {
            // 实时画面能接管会话，只交给用户本机浏览器打开，不打印、不落盘
            execFileSync('open', [session.inspectUrl]);
            console.error('需要人工验证：已在你的浏览器打开云浏览器实时画面，请在 5 分钟内完成验证');
          }
        }
        await done;
      } catch (e) {
        // 截图前清空输入框，截图里不留账号
        await field(sel.username).fill('', { timeout: 2_000 }).catch(() => {});
        await field(sel.password).fill('', { timeout: 2_000 }).catch(() => {});
        const shot = join(STATE_DIR, `login-failed-${name}.png`);
        mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
        writeFileSync(shot, await page.screenshot(), { mode: 0o600 });
        const { host, pathname } = new URL(page.url());
        const where = `停在 ${host}${pathname}，截图：${shot}`;
        if (!submitted) throw new FetchError(`profile ${name} 未能填写登录表单（${e.message.split('\n')[0]}），${where}`);
        entry.loginFailedAt = new Date().toISOString();
        writeState(state);
        throw new FetchError(`profile ${name} 提交后未登录成功，未重试。${where}`, { code: 4 });
      }
      delete entry.loginFailedAt;
      writeState(state);
      return `profile ${name} 登录成功，登录态已保存到 Lexmount context`;
    },
  );
}

function render(result) {
  const maxChars = Number(opts['max-chars']);
  const text = result.text.replace(/\n{3,}/g, '\n\n').trim();
  const truncated = text.length > maxChars;
  const lines = [
    `# ${result.title || '(无标题)'}`,
    '',
    `- 来源：${result.finalUrl}`,
    `- 方式：${result.via}${result.status ? `，HTTP ${result.status}` : ''}`,
    `- 抓取时间：${new Date().toISOString()}`,
  ];
  if (truncated) lines.push(`- 已截断：显示前 ${maxChars} / ${text.length} 字符`);
  lines.push('', '---', '', truncated ? text.slice(0, maxChars) : text);
  return lines.join('\n');
}

try {
  const config = parse(readFileSync(resolve(findConfig()), 'utf8'));
  if (positionals[0] === 'login') {
    if (!positionals[1]) throw new FetchError(USAGE, { code: 2 });
    console.log(await login(config, positionals[1]));
  } else {
    const url = positionals[0];
    if (!url || !/^https?:\/\//.test(url)) throw new FetchError(USAGE, { code: 2 });
    console.log(opts.profile ? await fetchWithProfile(config, url) : await fetchPublic(config, url));
  }
} catch (e) {
  console.error(e.code === 2 ? e.message : `失败：${e.message}`);
  process.exit(e instanceof FetchError ? e.code : 1);
}
