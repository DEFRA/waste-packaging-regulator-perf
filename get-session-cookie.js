#!/usr/bin/env node
/**
 * Authenticates against the compliance app and prints the session cookie to
 * stdout. Pipe the output directly into JMeter — the cookie is never written
 * to disk.
 *
 * Against a real Azure AD B2C-backed environment (dev, perf-test, ...) this
 * performs a full B2C login and requires credentials:
 *   B2C_USERNAME=you@example.com B2C_PASSWORD=secret node get-session-cookie.js
 *
 * Against a local `npm run dev` instance (MOCK_AUTH=true), the app bypasses
 * B2C entirely and signs any visitor in as a fixed mock user, so no
 * credentials are needed at all — just run:
 *   node get-session-cookie.js
 * with user.properties (or PROTOCOL/COMPLIANCE_HOST/COMPLIANCE_PORT env vars)
 * pointed at localhost.
 *
 * Optional (env var or user.properties):
 *   PROTOCOL         http or https (default: https)
 *   COMPLIANCE_HOST  target host (default: perf-test environment)
 *   COMPLIANCE_PORT  target port (default: 443 for https, 80 for http)
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ── Config ─────────────────────────────────────────────────────────────────────

const USERNAME = process.env.B2C_USERNAME
const PASSWORD = process.env.B2C_PASSWORD

const PROTOCOL = process.env.PROTOCOL ?? readProperty('PROTOCOL') ?? 'https'

const COMPLIANCE_HOST =
  process.env.COMPLIANCE_HOST ??
  readProperty('COMPLIANCE_HOST') ??
  'regulators-waste-proxy.perf-test.cdp-int.defra.cloud'

const COMPLIANCE_PORT = process.env.COMPLIANCE_PORT ?? readProperty('COMPLIANCE_PORT')

const DEFAULT_PORT_FOR_PROTOCOL = { http: '80', https: '443' }
const COMPLIANCE_ORIGIN =
  COMPLIANCE_PORT && COMPLIANCE_PORT !== DEFAULT_PORT_FOR_PROTOCOL[PROTOCOL]
    ? `${PROTOCOL}://${COMPLIANCE_HOST}:${COMPLIANCE_PORT}`
    : `${PROTOCOL}://${COMPLIANCE_HOST}`

// Local `npm run dev` serves HTTPS with a self-signed cert (certs/localhost-*.pem),
// which Node's fetch() would otherwise reject as untrusted.
if (['localhost', '127.0.0.1'].includes(COMPLIANCE_HOST)) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
}

function readProperty(key) {
  const propsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'user.properties')
  if (!fs.existsSync(propsPath)) return undefined
  const line = fs.readFileSync(propsPath, 'utf8').split('\n').find(l => l.startsWith(`${key}=`))
  return line ? line.slice(key.length + 1).trim() || undefined : undefined
}

// ── Cookie jar (domain-aware) ──────────────────────────────────────────────────
// Prevents app cookies leaking to B2C endpoints and vice versa during the OAuth flow.

class CookieJar {
  #store = []  // [{ name, value, domain, path }]

  ingest(setCookieHeaders, requestUrl) {
    const requestHost = new URL(requestUrl).hostname

    for (const h of [setCookieHeaders].flat().filter(Boolean)) {
      const [nameVal, ...attrs] = h.split(';').map(s => s.trim())
      const eq = nameVal.indexOf('=')
      if (eq === -1) continue

      const name = nameVal.slice(0, eq).trim()
      const value = nameVal.slice(eq + 1).trim()
      let domain = requestHost, cookiePath = '/'

      for (const attr of attrs) {
        const sep = attr.indexOf('=')
        if (sep === -1) continue
        const k = attr.slice(0, sep).trim().toLowerCase()
        const v = attr.slice(sep + 1).trim()
        if (k === 'domain') domain = v.replace(/^\./, '')
        if (k === 'path') cookiePath = v
      }

      const idx = this.#store.findIndex(
        c => c.name === name && c.domain === domain && c.path === cookiePath
      )
      if (idx >= 0) this.#store[idx].value = value
      else this.#store.push({ name, value, domain, path: cookiePath })
    }
  }

  header(requestUrl) {
    const { hostname } = new URL(requestUrl)
    return this.#store
      .filter(c => c.value && (hostname === c.domain || hostname.endsWith(`.${c.domain}`)))
      .map(c => `${c.name}=${c.value}`)
      .join('; ')
  }

  get(name) {
    return this.#store.find(c => c.name === name && c.value)?.value
  }

  names() {
    return this.#store.filter(c => c.value).map(c => `${c.name}@${c.domain}`)
  }
}

// ── HTTP helpers ───────────────────────────────────────────────────────────────

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
}

async function request(jar, url, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(url, {
    method, body, redirect: 'manual',
    headers: { ...BROWSER_HEADERS, Cookie: jar.header(url), ...headers },
  })
  jar.ingest(res.headers.getSetCookie?.() ?? [], url)
  return res
}

async function followRedirects(jar, startUrl, initOpts = {}) {
  let url = startUrl, res, opts = initOpts
  for (let i = 0; i < 20; i++) {
    res = await request(jar, url, opts)
    if (res.status < 300 || res.status >= 400) break
    const location = res.headers.get('location')
    if (!location) break
    url = new URL(location, url).href
    opts = {}
  }
  return { res, url }
}

// ── B2C auth flow ──────────────────────────────────────────────────────────────

function parseSettings(html) {
  const match = html.match(/var\s+SETTINGS\s*=\s*(\{[\s\S]*?\});/)
  if (!match) throw new Error('SETTINGS not found in B2C login page — page structure may have changed')
  return JSON.parse(match[1])
}

async function authenticate() {
  const jar = new CookieJar()
  const startUrl = `${COMPLIANCE_ORIGIN}/certificates-of-compliance`

  console.error(`→ GET ${startUrl}`)
  const { res: loginRes, url: loginUrl } = await followRedirects(jar, startUrl)

  const isB2c = loginUrl.includes('b2clogin.com') || loginUrl.includes('microsoftonline.com')
  if (!isB2c) {
    // Mock auth (local dev) signs the visitor in via a redirect through
    // /signin-oidc with no credentials required — the app never reaches B2C.
    const cookie = jar.get('bell-azure-ad-b2c') ?? jar.get('session')
    if (cookie) return cookie
    throw new Error(`Expected an authenticated session but landed at: ${loginUrl}`)
  }

  if (!USERNAME || !PASSWORD) {
    throw new Error(
      `Landed on a B2C login page (${loginUrl}) but B2C_USERNAME and B2C_PASSWORD are not set.`
    )
  }

  console.error(`→ B2C login page: ${loginUrl}`)

  const settings = parseSettings(await loginRes.text())
  const { csrf, transId, hosts } = settings
  if (!csrf || !transId || !hosts) {
    throw new Error(`Missing fields in B2C SETTINGS: ${JSON.stringify(settings)}`)
  }

  const b2cOrigin = new URL(loginUrl).origin
  const emailField = settings.config?.operatingMode === 'Email' ? 'email' : 'signInName'

  const selfAssertedUrl =
    `${b2cOrigin}${hosts.tenant}/SelfAsserted` +
    `?tx=${encodeURIComponent(transId)}&p=${encodeURIComponent(hosts.policy)}`

  console.error(`→ POST credentials (field: ${emailField})`)
  const credRes = await request(jar, selfAssertedUrl, {
    method: 'POST',
    body: new URLSearchParams({ request_type: 'RESPONSE', [emailField]: USERNAME, password: PASSWORD }),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-CSRF-TOKEN': csrf,
      'X-Requested-With': 'XMLHttpRequest',
      Referer: loginUrl,
    },
  })

  const credJson = await credRes.json().catch(() => null)
  if (!credJson || credJson.status !== '200') {
    throw new Error(`Credential submission failed — check username/password.\nB2C: ${JSON.stringify(credJson)}`)
  }

  const confirmedUrl =
    `${b2cOrigin}${hosts.tenant}/api/CombinedSigninAndSignup/confirmed` +
    `?csrf_token=${encodeURIComponent(csrf)}` +
    `&tx=${encodeURIComponent(transId)}` +
    `&p=${encodeURIComponent(hosts.policy)}`

  console.error('→ Following redirect chain back to app')
  const { url: finalUrl } = await followRedirects(jar, confirmedUrl)
  console.error(`→ Landed at: ${finalUrl}`)

  const cookie = jar.get('bell-azure-ad-b2c') ?? jar.get('session')
  if (!cookie) {
    throw new Error(`Auth completed but no session cookie found. Available: ${jar.names().join(', ')}`)
  }
  return cookie
}

// ── Entry point ────────────────────────────────────────────────────────────────

const cookie = await authenticate()
console.error(`✓ Session cookie obtained (${cookie.length} chars)`)
process.stdout.write(cookie)
