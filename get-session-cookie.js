#!/usr/bin/env node
/**
 * Authenticates against Azure AD B2C and prints the session cookie to stdout.
 * Pipe the output directly into JMeter — the cookie is never written to disk.
 *
 * Usage:
 *   B2C_USERNAME=you@example.com B2C_PASSWORD=secret node get-session-cookie.js
 *
 * Required env vars:
 *   B2C_USERNAME   Azure AD B2C login email
 *   B2C_PASSWORD   Azure AD B2C login password
 *
 * Optional (env var or user.properties):
 *   COMPLIANCE_HOST  target host (default: dev environment)
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ── Config ─────────────────────────────────────────────────────────────────────

const USERNAME = process.env.B2C_USERNAME
const PASSWORD = process.env.B2C_PASSWORD

if (!USERNAME || !PASSWORD) {
  console.error('Error: B2C_USERNAME and B2C_PASSWORD environment variables are required.')
  process.exit(1)
}

const COMPLIANCE_HOST =
  process.env.COMPLIANCE_HOST ??
  readProperty('COMPLIANCE_HOST') ??
  'waste-packaging-regulators-fe.dev.cdp-int.defra.cloud'

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
  const startUrl = `https://${COMPLIANCE_HOST}/certificates-of-compliance`

  console.error(`→ GET ${startUrl}`)
  const { res: loginRes, url: loginUrl } = await followRedirects(jar, startUrl)

  const isB2c = loginUrl.includes('b2clogin.com') || loginUrl.includes('microsoftonline.com')
  if (!isB2c) {
    const cookie = jar.get('bell-azure-ad-b2c') ?? jar.get('session')
    if (cookie) return cookie
    throw new Error(`Expected B2C redirect but landed at: ${loginUrl}`)
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
