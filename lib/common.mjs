// AI 辅助生成（Claude Code）。lexmount-fetch 与 lexmount-browser 共用的配置、状态、策略和脱敏代码。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Lexmount } from 'lexmount';
import { parse } from 'yaml';

// 反爬验证页常返回 HTTP 200 且有正文，只能按标题和地址识别
const CHALLENGE = /安全验证|验证码|人机验证|captcha|just a moment|attention required|access denied|are you a robot|verify you are human/i;
// 登录态、context ID 和失败截图放在仓库之外，不会被误提交
export const STATE_DIR = join(homedir(), '.local', 'state', 'lexmount-fetch');
const STATE_FILE = join(STATE_DIR, 'state.json');

export class CliError extends Error {
  // final：再换方式也没用，不要降级到云浏览器；code 为进程退出码
  constructor(message, { final = false, code = 1 } = {}) {
    super(message);
    this.final = final;
    this.code = code;
  }
}

export function findConfig() {
  if (process.env.LEXMOUNT_CONFIG) return process.env.LEXMOUNT_CONFIG;
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const candidate = join(dir, 'lexmount-config.yaml');
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) break;
  }
  const global = join(homedir(), '.config', 'lexmount', 'config.yaml');
  if (existsSync(global)) return global;
  return null;
}

// 环境变量名与 lexmount SDK、官方 CLI 一致；配置文件优先
export function loadConfig() {
  const path = findConfig();
  const config = path ? parse(readFileSync(resolve(path), 'utf8')) ?? {} : {};
  config['api-key'] ||= process.env.LEXMOUNT_API_KEY;
  config['project-id'] ||= process.env.LEXMOUNT_PROJECT_ID;
  config['base-url'] ||= process.env.LEXMOUNT_BASE_URL;
  if (!config['api-key'] || !config['project-id']) {
    throw new CliError(
      '缺少 api-key / project-id：设置 LEXMOUNT_API_KEY、LEXMOUNT_PROJECT_ID，或提供 lexmount-config.yaml（LEXMOUNT_CONFIG、项目根目录、~/.config/lexmount/config.yaml）',
      { code: 2 },
    );
  }
  return config;
}

export function createClient(config) {
  return new Lexmount({
    apiKey: config['api-key'],
    projectId: config['project-id'],
    baseUrl: config['base-url'],
  });
}

// 服务端不支持 readOnly context（2026-10-21 实测 HTTP 400 "Read only context is not implemented"），
// 改为每次复制一份登录态、以 readWrite 打开，用完删除，页面上的操作不会写回原 context
export async function forkContext(client, contextId) {
  const fork = await client.contexts.fork(contextId);
  const state = readState();
  (state.forkedContexts ??= []).push(fork.id);
  writeState(state);
  return fork.id;
}

// 会话关闭后 context 锁要几秒才释放，删除会先返回 409；删不掉的留在 state 里，下次再清
export async function deleteForkedContext(client, id, attempts = 10) {
  for (let i = 0; ; i++) {
    try {
      await client.contexts.delete(id);
      break;
    } catch (e) {
      if (/not found|HTTP 404/i.test(e.message)) break;
      if (i + 1 >= attempts) return false;
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  const state = readState();
  state.forkedContexts = (state.forkedContexts ?? []).filter((x) => x !== id);
  writeState(state);
  return true;
}

export async function cleanupForkedContexts(client) {
  for (const id of readState().forkedContexts ?? []) await deleteForkedContext(client, id, 1);
}

// 实时画面能接管会话，只交给用户本机浏览器打开，不打印、不落盘
export function openInBrowser(url) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]]
    // 不用 cmd /c start：URL 里的 & 会被 cmd 当成命令分隔符
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : ['xdg-open', [url]];
  execFileSync(cmd, args, { stdio: 'ignore' });
}

// connectUrl 能接管云浏览器，会出现在 Playwright 报错里
export function redact(text, secrets) {
  let out = String(text).replace(/\bwss?:\/\/\S+/g, 'ws://<redacted>');
  for (const s of secrets) if (s) out = out.split(String(s)).join('<redacted>');
  return out;
}

export function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function writeState(state) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function loadProfile(config, name) {
  const p = config['fetch-profiles']?.[name];
  if (!p) throw new CliError(`lexmount-config.yaml 里没有 fetch-profiles.${name}`, { final: true, code: 2 });
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

export function policyViolation(profile, target, method = 'GET') {
  const { protocol, host, pathname } = new URL(target);
  if (method !== 'GET') return `禁止 ${method} 请求`;
  if (!/^https?:$/.test(protocol)) return `禁止 ${protocol} 地址`;
  if (!profile.allowHosts.includes(host)) return `域名 ${host} 不在 allow-hosts 中`;
  const denied = profile.denyPaths.find((re) => re.test(pathname));
  if (denied) return `路径 ${pathname} 命中 deny-paths ${denied}`;
  return null;
}

// 导航只放行 allow-hosts 内、未命中 deny-paths 的 GET；blockNonGet 时其余请求也只放行 GET / HEAD。被拦的请求记入 blocked
export async function installPolicy(context, page, profile, blocked, { blockNonGet = false } = {}) {
  const record = (violation, method, url) => {
    const { host, pathname } = new URL(url);
    blocked.add(`${violation}（${method} ${host}${pathname}）`);
  };
  await context.route('**/*', (route, request) => {
    const method = request.method();
    const violation = request.isNavigationRequest()
      ? policyViolation(profile, request.url(), method)
      : blockNonGet && method !== 'GET' && method !== 'HEAD' ? `禁止 ${method} 请求` : null;
    if (!violation) return route.continue();
    record(violation, method, request.url());
    return route.abort('blockedbyclient');
  });
  // route 拦不到重定向的下一跳（2026-10-21 实测 302 到 allow-hosts 之外照样放行），在响应阶段检查 3xx 的 Location
  const cdp = await context.newCDPSession(page);
  cdp.on('Fetch.requestPaused', (e) => {
    const location = e.responseHeaders?.find((h) => h.name.toLowerCase() === 'location')?.value;
    const next = location ? new URL(location, e.request.url).href : null;
    const violation = next && policyViolation(profile, next);
    if (violation) record(`重定向：${violation}`, 'GET', next);
    const reply = violation
      ? cdp.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'BlockedByClient' })
      : cdp.send('Fetch.continueRequest', { requestId: e.requestId });
    reply.catch(() => {});
  });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }] });
  // 新标签页、跨进程 iframe 不经过上面的 CDP 会话，重定向只能事后发现并报错
  context.on('request', (request) => {
    if (!request.isNavigationRequest() || !request.redirectedFrom()) return;
    const violation = policyViolation(profile, request.url(), request.method());
    if (violation) record(`重定向：${violation}`, request.method(), request.url());
  });
}

export function challengeReason({ title, finalUrl }) {
  const { host, pathname } = new URL(finalUrl);
  if (CHALLENGE.test(title ?? '')) return `标题「${title}」`;
  if (CHALLENGE.test(host + pathname)) return `跳转到 ${host}${pathname}`;
  return null;
}
