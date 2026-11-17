/**
 * HTTP 请求封装：自动识别 HTTP_PROXY / HTTPS_PROXY / NO_PROXY 环境变量。
 * Node 内置 fetch（undici）默认不走系统代理，这里补上，保证公司网络/代理环境下也能用。
 */
import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';

let cachedDispatcher: Dispatcher | undefined;
let cachedKey = '';

function noProxyList(): string[] {
  const raw = process.env.NO_PROXY || process.env.no_proxy || '';
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** 私有/保留地址不走代理（内网服务、局域网模型常用） */
function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host === '::1' || host.endsWith('.local') || host.endsWith('.lan')) return true;
  if (host === '0.0.0.0' || host === '127.0.0.1' || host.startsWith('127.')) return true;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 链路本地
  return false;
}

function shouldBypass(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    for (const rule of noProxyList()) {
      if (rule === '*') return true;
      const r = rule.startsWith('.') ? rule.slice(1) : rule;
      if (host === r || host.endsWith('.' + r)) return true;
    }
    if (isPrivateHost(host)) return true;
  } catch {
    /* ignore */
  }
  return false;
}

function proxyUrl(): string {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    ''
  ).trim();
}

function dispatcher(): Dispatcher | undefined {
  const p = proxyUrl();
  if (!p) return undefined;
  const key = p;
  if (cachedKey !== key || !cachedDispatcher) {
    cachedDispatcher = new ProxyAgent(p);
    cachedKey = key;
  }
  return cachedDispatcher;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** 走代理感知的 fetch */
export async function httpFetch(url: string, opts: RequestOptions = {}): Promise<Response> {
  const d = shouldBypass(url) ? undefined : dispatcher();
  const timeoutMs = opts.timeoutMs ?? 120000;
  const controller = new AbortController();
  // timeoutMs <= 0 表示「不超时」（流式请求用），此时不能设定时器，否则会立即 abort
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  if (opts.signal) opts.signal.addEventListener('abort', () => controller.abort());
  try {
    const res = (await undiciFetch(url, {
      method: opts.method ?? 'GET',
      headers: opts.headers,
      body: opts.body as never,
      dispatcher: d,
      signal: controller.signal,
      // 流式请求（timeoutMs<=0）同时关闭 undici 的 300s 头/体超时，
      // 否则本地大模型冷启动或长生成会被底层静默掐断（表现为 fetch failed）
      ...(timeoutMs > 0 ? {} : { headersTimeout: 0, bodyTimeout: 0 }),
    })) as unknown as Response;
    return res;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 读取 SSE 流，逐行回调（data: 开头的行） */
export async function* readSSE(
  res: Response,
  signal?: AbortSignal,
): AsyncGenerator<{ event?: string; data: string }> {
  const body = res.body;
  if (!body) throw new Error('响应没有 body，无法流式读取');
  const reader = (body as unknown as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let event: string | undefined;
        const dataLines: string[] = [];
        for (const line of chunk.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length) yield { event, data: dataLines.join('\n') };
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

export async function readText(res: Response): Promise<string> {
  return res.text();
}
