/**
 * Credentials that pages publish by mistake: a SonarQube token pasted in a Confluence table, a Nexus npm
 * token in a README, a Logic App URL with its `sig=`, a client secret in a curl example. Sync copies them
 * into kb/ verbatim and, without this, search and fetch_document hand them to every MCP client.
 *
 * `redactSecrets` replaces the value (never the key or the surrounding text, so an example still reads as
 * an example) with `[REDACTED:<rule>]`. It runs in `cleanBody`, so the index, the embeddings and
 * fetch_document never see the value, and once more on retrieved chunks for an index built before it
 * existed. The rules are deliberately narrow: known token formats, and `key = value` pairs whose key names a
 * secret and whose value looks random. A placeholder (`<token>`, `${TOKEN}`, `xxxx`, `your-secret`) is
 * left alone. `npm run secrets` lists what was found, for the owners who have to rotate it.
 */

export interface SecretFinding {
  rule: string;
  /** 1-based line of the match in the text that was scanned. */
  line: number;
  /** The first characters of the value and its length, enough to recognise it, not to use it. */
  preview: string;
}

interface Rule {
  name: string;
  re: RegExp;
  /** Index of the capture group holding the secret; 0 = the whole match, -1 = the first group that matched. */
  group: number;
  /** Extra check on the captured value, for the generic rules. */
  accept?: (value: string) => boolean;
}

const PLACEHOLDER_WORDS =
  /^(?:your|my|the|some|example|sample|dummy|fake|test|changeme|change_me|placeholder|redacted|secret|password|passwd|token|value|string|null|undefined|none|true|false|insert|replace|todo|tbd)(?:[^a-z]|$)/;

/** Values that are obviously not a real credential: `<token>`, `${TOKEN}`, `{{x}}`, `xxxx`, `your-secret`. */
function isPlaceholder(value: string): boolean {
  const v = value.trim();
  return (
    !v ||
    /^(?:<|-|\$\{|\$\(|\{\{|\{[A-Za-z_][\w.]*\}$|%[A-Za-z_]|#|@[A-Za-z]|\[|\(|\*|\.\.\.|…)/.test(v) ||
    /x{4,}|X{4,}|\*{3,}|\.{3}|…|<[^>]*>/.test(v) ||
    PLACEHOLDER_WORDS.test(v.toLowerCase())
  );
}

/** An expression rather than a literal: `process.env.X`, `settings.token`, `envalid.str(`, `HASURA_SECRET`. */
function isCode(value: string): boolean {
  const v = value.trim();
  return (
    /^(?:process|env|os|settings|config|cfg|conf|opts|options|data|req|res|ctx|deps|this|self|args|params|props|window|secrets|vault|envalid|system|environment|import|require)\b/i.test(v) ||
    /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+/.test(v) || // property access
    /^[A-Za-z_$][\w$]*\s*\(/.test(v) || // a call
    /^[A-Z][A-Z0-9_]{3,}$/.test(v) || // an env var name
    /^[a-z]{2,}(?:[A-Z][a-z]{2,})+$/.test(v) || // a camelCase identifier
    /^[a-z]{3,}(?:[_-][a-z0-9]+)+$/.test(v) || // a snake/kebab name: expires_in_30d, integration-test-bus
    /os\.environ|process\.env|getenv|Environment\./.test(v)
  );
}

/**
 * A value that looks generated: no spaces, not a placeholder or an expression, and at least three of
 * lower case / upper case / digits / symbols, or digits with one other class. A word, a kebab name
 * ("gitlab-token") or a phrase with slashes ("missing/invalid") is not.
 */
function looksRandom(value: string, minLength = 12): boolean {
  const v = value.trim();
  if (v.length < minLength || /\s/.test(v) || isPlaceholder(v) || isCode(v)) return false;
  if (/^(https?:|\/|\.\/|\.\.\/)/.test(v)) return false; // a URL or path is not the secret itself
  const lower = /[a-z]/.test(v);
  const upper = /[A-Z]/.test(v);
  const digit = /\d/.test(v);
  const symbol = /[^A-Za-z0-9]/.test(v);
  const classes = [lower, upper, digit, symbol].filter(Boolean).length;
  return (classes >= 3 || (digit && classes >= 2)) && new Set(v).size >= Math.min(8, minLength);
}

/** Key names that hold a credential. Connection strings are left to the rules for their parts. */
const SECRET_KEY =
  "(?:client[_-]?secret|signing[_-]?secret|webhook[_-]?secret|app[_-]?secret|api[_-]?secret|secret[_-]?key|api[_-]?key|apikey|" +
  "access[_-]?key|secret[_-]?access[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|task[_-]?token|" +
  "bearer[_-]?token|private[_-]?key|passw(?:or)?d|pwd|sas[_-]?token|secret)";

/** The well-known Azurite/Storage Emulator account key, published by Microsoft. */
const PUBLIC_VALUES = [/^Eby8vdM02xNOcqFl/];

const RULES: Rule[] = [
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{100,}?-----END [A-Z ]*PRIVATE KEY-----/g, group: 0 },
  // header.payload.signature; the header is matched loosely because a page that masks only the header
  // ("xxxxJIUzI1NiIs…") still publishes a replayable payload and signature.
  { name: "jwt", re: /\b[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/g, group: 0 },
  { name: "sonarqube-token", re: /\b(sq[apu]_[0-9a-f]{40})\b/g, group: 1 },
  { name: "gitlab-token", re: /\b(glpat-[0-9A-Za-z_-]{20,})/g, group: 1 },
  { name: "github-token", re: /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g, group: 1 },
  { name: "npm-token", re: /\b(npm_[A-Za-z0-9]{36})\b/g, group: 1 },
  { name: "nexus-npm-token", re: /\b(NpmToken\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi, group: 1 },
  { name: "aws-access-key", re: /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/g, group: 1 },
  { name: "slack-token", re: /\b(xox[abposr]-[0-9A-Za-z-]{10,})/g, group: 1 },
  // .npmrc / .yarnrc: //registry/:_authToken=VALUE, _auth=, _password=
  { name: "npmrc-auth", re: /(?:_authToken|_auth|_password)\s*[=:]\s*["']?([^\s"'`]{12,})/g, group: 1, accept: (v) => !isPlaceholder(v) && !isCode(v) },
  // Azure SAS, Logic App / Teams webhook signatures, S3 pre-signed URLs: keep the URL, drop the signature.
  { name: "url-signature", re: /[?&](?:sig|signature|X-Amz-Signature)=([A-Za-z0-9%/+=_-]{20,})/g, group: 1 },
  { name: "azure-account-key", re: /\b(?:AccountKey|SharedAccessKey)=([A-Za-z0-9+/]{30,}={0,2})/g, group: 1, accept: (v) => !PUBLIC_VALUES.some((re) => re.test(v)) },
  // Password=…; inside an ADO.NET / ODBC connection string
  { name: "connection-string-password", re: /\b(?:Password|Pwd)=([^;"'`\s]{6,})/g, group: 1, accept: (v) => looksRandom(v, 6) },
  // user:password@host in a URL (not user@host, not a ${VAR}, not postgres:postgres)
  { name: "url-password", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s@/]{6,})@/gi, group: 1, accept: (v) => looksRandom(v, 6) },
  // A captured request's Cookie header: the whole value, once one of its cookies looks like a session id.
  {
    name: "cookie",
    re: /\b(?:set-)?cookie\\?["']?\s*:\s*\\?["']?([^"\\\n]{16,})/gi,
    group: 1,
    accept: (v) => /=[A-Za-z0-9%._~+/-]{16,}/.test(v),
  },
  // Authorization: Basic <b64> / Bearer <opaque> with a real-looking value
  { name: "basic-auth", re: /\bBasic\s+([A-Za-z0-9+/]{16,}={0,2})(?![A-Za-z0-9+/=])/g, group: 1, accept: (v) => looksRandom(v) },
  { name: "bearer-token", re: /\bBearer\s+([A-Za-z0-9._~+/-]{24,}=*)/g, group: 1, accept: (v) => looksRandom(v) },
  // client_secret: "…", "password": "…", SIGNING_SECRET=…, X-Api-Key: …
  {
    name: "secret-assignment",
    re: new RegExp(`["']?\\b[\\w.-]*${SECRET_KEY}["']?\\s*(?:[:=]|=>)\\s*(?:"([^"\\n]{12,}?)"|'([^'\\n]{12,}?)'|\`([^\`\\n]{12,}?)\`|([^\\s"'\`,;]{12,}))`, "gi"),
    group: -1,
    accept: (v) => looksRandom(v),
  },
];

function mask(value: string): string {
  return `${value.slice(0, 4)}… (${value.length} chars)`;
}

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Replace every credential in `text`; `findings` says what was replaced and where. */
export function redactSecrets(text: string): { text: string; findings: SecretFinding[] } {
  if (!text) return { text, findings: [] };
  const findings: SecretFinding[] = [];
  let out = text;
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    out = out.replace(rule.re, (match: string, ...rest: unknown[]) => {
      const offset = rest[rest.length - 2] as number;
      const groups = rest.slice(0, -2) as (string | undefined)[];
      const value =
        rule.group === 0 ? match : rule.group === -1 ? groups.find((g) => typeof g === "string") : groups[rule.group - 1];
      if (!value || value.startsWith("[REDACTED")) return match;
      if (rule.accept && !rule.accept(value)) return match;
      findings.push({ rule: rule.name, line: lineOf(out, offset), preview: mask(value) });
      const at = rule.group === 0 ? 0 : match.lastIndexOf(value);
      return `${match.slice(0, at)}[REDACTED:${rule.name}]${match.slice(at + value.length)}`;
    });
  }
  return { text: out, findings };
}

/** Just the redacted text. */
export function redact(text: string): string {
  return redactSecrets(text).text;
}
