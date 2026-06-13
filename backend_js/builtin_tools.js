import { lookup } from 'node:dns/promises';

const ALLOWED_CHARS = /^[\d\s.+\-*/%()]+$/;
const MAX_EXPR_LEN = 200;
// Cap exponentiation: even pure-arithmetic input like 9**9**9 can exhaust CPU/memory.
const MAX_POW_BASE = 1_000_000;
const MAX_POW_EXP = 100;

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: 'Get the current date and time of the server, including timezone.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculate',
      description: 'Evaluate a basic arithmetic expression. Supports + - * / // % ** and parentheses.',
      parameters: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: 'Arithmetic expression, e.g. (2 + 3) * 4',
          },
        },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'access_url',
      description:
        'Browse the web or call an HTTP(S) API: fetch a URL and return its status, ' +
        'response headers, and body. Supports custom request headers, methods, and a ' +
        'request body. Use this to read web pages, query REST APIs, or check resources. ' +
        'Only public http/https endpoints are reachable; private/internal addresses are blocked.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The absolute http:// or https:// URL to request.',
          },
          method: {
            type: 'string',
            description: 'HTTP method (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS). Defaults to GET.',
            default: 'GET',
          },
          headers: {
            type: 'object',
            description: 'Custom request headers as a flat string-to-string map, e.g. {"Authorization": "Bearer ...", "Accept": "application/json"}.',
            additionalProperties: { type: 'string' },
          },
          body: {
            type: 'string',
            description: 'Optional request body, sent as-is for methods that allow it (POST/PUT/PATCH/DELETE).',
          },
        },
        required: ['url'],
      },
    },
  },
];

// --- access_url -------------------------------------------------------------
const ACCESS_URL_TIMEOUT_MS = 15_000;
const ACCESS_URL_MAX_BYTES = 256 * 1024; // cap body fed back to the model
const ACCESS_URL_MAX_REDIRECTS = 5;
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
// Hop-by-hop / unsafe headers the caller must not be able to override.
const FORBIDDEN_REQUEST_HEADERS = new Set([
  'host', 'content-length', 'connection', 'transfer-encoding', 'keep-alive',
  'upgrade', 'te', 'trailer', 'proxy-authorization', 'proxy-connection',
]);

// Block SSRF to loopback, private, link-local, and other non-public ranges.
function isPrivateIp(addr) {
  const ip = String(addr);
  if (ip.includes(':')) {
    // IPv6
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return true;
    if (low.startsWith('fe80') || low.startsWith('fc') || low.startsWith('fd')) return true; // link-local + unique-local
    // IPv4-mapped IPv6, e.g. ::ffff:127.0.0.1
    const m = low.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateIp(m[1]);
    return false;
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true; // loopback
  if (a === 0) return true; // "this" network
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true; // multicast + reserved
  return false;
}

// Resolve a hostname and reject if any resolved address is private (anti-SSRF).
async function assertPublicHost(hostname) {
  const bare = hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (/^\d+\.\d+\.\d+\.\d+$/.test(bare) || bare.includes(':')) {
    if (isPrivateIp(bare)) throw new Error(`Refusing to access private/internal address: ${hostname}`);
    return;
  }
  if (bare.toLowerCase() === 'localhost') throw new Error('Refusing to access localhost');
  let results;
  try {
    results = await lookup(bare, { all: true });
  } catch {
    throw new Error(`Could not resolve host: ${hostname}`);
  }
  for (const { address } of results) {
    if (isPrivateIp(address)) throw new Error(`Refusing to access private/internal address: ${hostname} (${address})`);
  }
}

function sanitizeHeaders(headers) {
  const out = {};
  if (headers && typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) {
      const name = String(key).trim();
      if (!name || FORBIDDEN_REQUEST_HEADERS.has(name.toLowerCase())) continue;
      out[name] = String(value);
    }
  }
  return out;
}

export async function accessUrl(url, method = 'GET', headers = {}, body = null) {
  const raw = String(url ?? '').trim();
  if (!raw) throw new Error('url must not be empty');

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http:// and https:// URLs are supported');
  }

  const verb = String(method ?? 'GET').toUpperCase();
  if (!ALLOWED_METHODS.has(verb)) {
    throw new Error(`Unsupported method: ${verb}. Allowed: ${[...ALLOWED_METHODS].join(', ')}`);
  }

  const reqHeaders = sanitizeHeaders(headers);
  const hasBody = body != null && body !== '' && verb !== 'GET' && verb !== 'HEAD';

  // Follow redirects manually so each hop is re-validated against the SSRF guard.
  let currentUrl = parsed;
  let response;
  for (let hop = 0; hop <= ACCESS_URL_MAX_REDIRECTS; hop += 1) {
    await assertPublicHost(currentUrl.hostname);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ACCESS_URL_TIMEOUT_MS);
    try {
      response = await fetch(currentUrl, {
        method: verb,
        headers: reqHeaders,
        body: hasBody ? String(body) : undefined,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') throw new Error(`Request timed out after ${ACCESS_URL_TIMEOUT_MS} ms`);
      throw new Error(`Request failed: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }

    // 3xx with a Location → resolve and loop; otherwise we're done.
    const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
    if (!location) break;
    if (hop === ACCESS_URL_MAX_REDIRECTS) throw new Error(`Too many redirects (>${ACCESS_URL_MAX_REDIRECTS})`);
    try {
      currentUrl = new URL(location, currentUrl);
    } catch {
      throw new Error(`Invalid redirect target: ${location}`);
    }
    if (currentUrl.protocol !== 'http:' && currentUrl.protocol !== 'https:') {
      throw new Error(`Refusing to follow redirect to non-http(s) target: ${location}`);
    }
  }

  // Read the body up to the cap so a huge response can't blow up memory/context.
  const responseHeaders = {};
  for (const [key, value] of response.headers.entries()) responseHeaders[key] = value;

  let text = '';
  let truncated = false;
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > ACCESS_URL_MAX_BYTES) {
        const remaining = ACCESS_URL_MAX_BYTES - (received - value.length);
        text += decoder.decode(value.subarray(0, Math.max(0, remaining)), { stream: false });
        truncated = true;
        await reader.cancel();
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
    if (!truncated) text += decoder.decode();
  }

  return {
    url: response.url || currentUrl.toString(),
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
    body: text,
    truncated,
  };
}

function tokenize(expression) {
  const tokens = [];
  let i = 0;
  while (i < expression.length) {
    const c = expression[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1;
      continue;
    }
    if ((c >= '0' && c <= '9') || c === '.') {
      let j = i;
      while (j < expression.length && ((expression[j] >= '0' && expression[j] <= '9') || expression[j] === '.')) j += 1;
      const text = expression.slice(i, j);
      if (!/^(\d+(\.\d*)?|\.\d+)$/.test(text)) throw new Error(`Invalid number: ${text}`);
      tokens.push({ type: 'number', value: Number(text) });
      i = j;
      continue;
    }
    if (c === '*' && expression[i + 1] === '*') {
      tokens.push({ type: '**' });
      i += 2;
      continue;
    }
    if (c === '/' && expression[i + 1] === '/') {
      tokens.push({ type: '//' });
      i += 2;
      continue;
    }
    if ('+-*/%()'.includes(c)) {
      tokens.push({ type: c });
      i += 1;
      continue;
    }
    throw new Error(`Unexpected character: ${c}`);
  }
  return tokens;
}

// Grammar (matches Python precedence and associativity):
//   expr   := term (('+' | '-') term)*
//   term   := factor (('*' | '/' | '//' | '%') factor)*
//   factor := ('+' | '-') factor | power          -- so -2**2 === -(2**2) === -4
//   power  := atom ('**' factor)?                 -- right-assoc; exponent may be signed
//   atom   := number | '(' expr ')'
class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() {
    return this.tokens[this.pos];
  }

  take(type) {
    const tok = this.tokens[this.pos];
    if (!tok || (type && tok.type !== type)) {
      throw new Error('Only numbers and arithmetic operators are supported');
    }
    this.pos += 1;
    return tok;
  }

  parseExpr() {
    let value = this.parseTerm();
    while (this.peek() && (this.peek().type === '+' || this.peek().type === '-')) {
      const op = this.take().type;
      const rhs = this.parseTerm();
      value = op === '+' ? value + rhs : value - rhs;
    }
    return value;
  }

  parseTerm() {
    let value = this.parseFactor();
    while (this.peek() && ['*', '/', '//', '%'].includes(this.peek().type)) {
      const op = this.take().type;
      const rhs = this.parseFactor();
      if (rhs === 0 && op !== '*') throw new Error('Division by zero');
      if (op === '*') value *= rhs;
      else if (op === '/') value /= rhs;
      else if (op === '//') value = Math.floor(value / rhs);
      else value = value - Math.floor(value / rhs) * rhs; // Python-style modulo: sign of divisor
    }
    return value;
  }

  parseFactor() {
    if (this.peek() && (this.peek().type === '+' || this.peek().type === '-')) {
      const op = this.take().type;
      const value = this.parseFactor();
      return op === '-' ? -value : value;
    }
    return this.parsePower();
  }

  parsePower() {
    const base = this.parseAtom();
    if (this.peek() && this.peek().type === '**') {
      this.take();
      const exponent = this.parseFactor();
      if (Math.abs(exponent) > MAX_POW_EXP || Math.abs(base) > MAX_POW_BASE) {
        throw new Error('Exponent or base too large');
      }
      return base ** exponent;
    }
    return base;
  }

  parseAtom() {
    const tok = this.peek();
    if (tok && tok.type === 'number') {
      this.take();
      return tok.value;
    }
    if (tok && tok.type === '(') {
      this.take();
      const value = this.parseExpr();
      this.take(')');
      return value;
    }
    throw new Error('Only numbers and arithmetic operators are supported');
  }
}

export function calculate(expression) {
  expression = String(expression).trim();
  if (!expression) throw new Error('Empty expression');
  if (expression.length > MAX_EXPR_LEN) throw new Error('Expression too long');
  if (!ALLOWED_CHARS.test(expression)) {
    throw new Error('Only numbers and the operators + - * / // % ** ( ) are allowed');
  }
  const parser = new Parser(tokenize(expression));
  const value = parser.parseExpr();
  if (parser.pos !== parser.tokens.length) {
    throw new Error('Only numbers and arithmetic operators are supported');
  }
  if (!Number.isFinite(value)) throw new Error('Result is not a finite number');
  return value;
}

export function getCurrentTime() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const offsetMin = -now.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export async function callBuiltin(name, args) {
  if (name === 'get_current_time') return getCurrentTime();
  if (name === 'calculate') return String(calculate(String(args.expression ?? '')));
  if (name === 'access_url') {
    return JSON.stringify(
      await accessUrl(
        String(args.url ?? ''),
        String(args.method ?? 'GET'),
        args.headers && typeof args.headers === 'object' ? args.headers : {},
        args.body != null ? String(args.body) : null,
      ),
    );
  }
  throw new Error(`Unknown builtin tool: ${name}`);
}
