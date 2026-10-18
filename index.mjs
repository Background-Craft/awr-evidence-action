#!/usr/bin/env node
// awr-evidence-action: emits one Agent Work Record v0 evidence fragment (kind ci_run) for the current GitHub Actions
// run, writes it to a file and, given an endpoint, POSTs it there. Node's standard library only.
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const here = dirname(fileURLToPath(import.meta.url))
export const schema = JSON.parse(readFileSync(join(here, 'vendor/awr-spec/agent-work-record-v0.schema.json'), 'utf8'))

const results = { pass: 'pass', fail: 'fail', pending: 'pending', neutral: 'neutral', success: 'pass', failure: 'fail', cancelled: 'neutral', skipped: 'neutral' }
const RETRY_CAP_SECONDS = 60
const RETRY_DEFAULT_SECONDS = 5
const TIMEOUT_MS = 30_000

class ConfigError extends Error {}
class SendError extends Error {}

// GitHub passes inputs as INPUT_<NAME> with the name upper-cased and spaces as underscores; hyphens stay.
export const input = (env, name) => (env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] ?? '').trim()

export function mapResult(value) {
  if (!value) throw new ConfigError('result is required: pass, fail, pending or neutral, or a job status (success, failure, cancelled, skipped).')
  const mapped = results[value.toLowerCase()]
  if (!mapped) throw new ConfigError(`result "${value}" is not one of pass, fail, pending, neutral, success, failure, cancelled, skipped.`)
  return mapped
}

// The commit the run checked: the pull request's head on pull_request events (GITHUB_SHA is the merge commit there).
export function headCommit(env) {
  if (['pull_request', 'pull_request_target'].includes(env.GITHUB_EVENT_NAME) && env.GITHUB_EVENT_PATH && existsSync(env.GITHUB_EVENT_PATH)) {
    const sha = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))?.pull_request?.head?.sha
    if (sha) return sha
  }
  return env.GITHUB_SHA || undefined
}

export function runIds(env) {
  for (const name of ['GITHUB_SERVER_URL', 'GITHUB_REPOSITORY', 'GITHUB_RUN_ID']) if (!env[name]) throw new ConfigError(`${name} is not set; run this inside GitHub Actions.`)
  const run = `${env.GITHUB_SERVER_URL.replace(/\/+$/, '')}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
  return { id: `${run}/attempts/${env.GITHUB_RUN_ATTEMPT || '1'}`, uri: run }
}

export function buildFragment(env, now = new Date()) {
  const required = name => { const v = input(env, name); if (!v) throw new ConfigError(`${name} is required.`); return v }
  const { id, uri } = runIds(env)
  const evidence = { id, kind: 'ci_run', uri, claim: input(env, 'claim') || 'ready_for_review', by: required('by'), at: now.toISOString() }
  const sha = headCommit(env)
  if (sha) evidence.subject = { gitCommit: sha.toLowerCase() }
  evidence.result = mapResult(input(env, 'result'))
  const note = input(env, 'note')
  if (note) evidence.note = note
  return { spec: 'agent-work-record/v0', workspace: required('workspace'), work: required('work'), evidence }
}

// A thin check of the vendored schema's evidence_fragment part, covering the keyword subset vendor/awr-spec/validate.mjs
// enforces. validate.mjs given a path checks records only, so fragments are checked here; CI also runs validate.mjs itself
// over every fragment this action writes.
const typeOf = v => v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v
const formats = {
  uri: v => /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/.test(v),
  'date-time': dateTime,
}
// As in validate.mjs: RFC 3339, and the fields must survive a round trip through Date.UTC.
function dateTime(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(v)
  if (!m) return false
  const [y, mo, d, h, mi, sec] = m.slice(1, 7).map(Number)
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, sec))
  const same = t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d && t.getUTCHours() === h && t.getUTCMinutes() === mi && t.getUTCSeconds() === sec
  return same && (m[8] === 'Z' || (Number(m[9]) <= 23 && Number(m[10]) <= 59))
}
function check(value, node, path, errors) {
  if (node.$ref) return check(value, schema.$defs[node.$ref.slice('#/$defs/'.length)], path, errors)
  if (node.type && !(typeOf(value) === node.type || (node.type === 'number' && typeOf(value) === 'integer'))) { errors.push(`${path}: expected ${node.type}`); return errors }
  if ('const' in node && !isDeepStrictEqual(value, node.const)) errors.push(`${path}: must be ${JSON.stringify(node.const)}`)
  if (node.enum && !node.enum.some(e => isDeepStrictEqual(e, value))) errors.push(`${path}: must be one of ${node.enum.join(', ')}`)
  if (typeof value === 'string') {
    if (node.minLength !== undefined && [...value].length < node.minLength) errors.push(`${path}: too short`)
    if (node.pattern && !new RegExp(node.pattern, 'u').test(value)) errors.push(`${path}: does not match ${node.pattern}`)
    if (node.format && !formats[node.format](value)) errors.push(`${path}: not a valid ${node.format}`)
  }
  if (typeof value === 'number' && node.minimum !== undefined && value < node.minimum) errors.push(`${path}: below ${node.minimum}`)
  if (Array.isArray(value)) {
    if (node.minItems !== undefined && value.length < node.minItems) errors.push(`${path}: needs at least ${node.minItems} item(s)`)
    if (node.items) value.forEach((item, i) => check(item, node.items, `${path}[${i}]`, errors))
  }
  if (typeOf(value) === 'object') {
    for (const key of node.required ?? []) if (!(key in value)) errors.push(`${path}: missing required property "${key}"`)
    for (const [key, item] of Object.entries(value)) {
      if (node.properties?.[key]) check(item, node.properties[key], `${path}.${key}`, errors)
      else if (node.additionalProperties === false) errors.push(`${path}: unknown property "${key}"`)
    }
  }
  if (node.anyOf && !node.anyOf.some(sub => check(value, sub, path, []).length === 0)) errors.push(`${path}: matches none of the allowed forms`)
  if (node.if && check(value, node.if, path, []).length === 0 && node.then) check(value, node.then, path, errors)
  return errors
}
export const fragmentErrors = fragment => check(fragment, schema.$defs.evidence_fragment, '$', [])

// UUID v5 (RFC 9562) in the URL namespace. Hydrant keys receipts by sender and request id, so the request id covers the
// work item and the run attempt: the same pair always gets the same id, and one attempt can report to several issues.
export const requestIdOf = fragment => requestIdFor(`${fragment.work}\n${fragment.evidence.id}`)
export function requestIdFor(name, namespace = '6ba7b811-9dad-11d1-80b4-00c04fd430c8') {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex')
  const h = createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest().subarray(0, 16)
  h[6] = (h[6] & 0x0f) | 0x50
  h[8] = (h[8] & 0x3f) | 0x80
  const x = h.toString('hex')
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`
}

export function bodyFor(mode, fragment) {
  if (mode === 'fragment') return fragment
  if (mode === 'hydrant') return { requestId: requestIdOf(fragment), fragment }
  throw new ConfigError(`body "${mode}" is not fragment or hydrant.`)
}

// Retry-After is seconds or an HTTP date. Capped, so a tracker cannot hold the job for long.
export function retryDelaySeconds(header, now = Date.now()) {
  if (!header) return RETRY_DEFAULT_SECONDS
  const seconds = /^\d+$/.test(header.trim()) ? Number(header) : (Date.parse(header) - now) / 1000
  if (!Number.isFinite(seconds)) return RETRY_DEFAULT_SECONDS
  return Math.min(Math.max(seconds, 0), RETRY_CAP_SECONDS)
}

async function messageOf(response) {
  const text = (await response.text().catch(() => '')).trim()
  try { const json = JSON.parse(text); if (typeof (json?.error ?? json?.message) === 'string') return json.error ?? json.message } catch {}
  return text.slice(0, 500) || response.statusText || 'no message'
}

// One POST with one retry on 429, 5xx or a network error. Redirects are not followed, so the token goes only to endpoint.
export async function send(endpoint, token, body, { log = () => {}, sleep = s => new Promise(r => setTimeout(r, s * 1000)) } = {}) {
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'awr-evidence-action' }
  if (token) headers.Authorization = `Bearer ${token}`
  const payload = JSON.stringify(body)
  for (let attempt = 1; ; attempt++) {
    let response, failure
    try { response = await fetch(endpoint, { method: 'POST', headers, body: payload, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) }) } catch (error) { failure = error }
    const retryable = failure || response.status === 429 || response.status >= 500
    if (!retryable) {
      if (response.status >= 200 && response.status < 300) return { status: response.status, text: await response.text() }
      throw Object.assign(new SendError(`${endpoint} answered ${response.status}: ${await messageOf(response)}`), { status: response.status })
    }
    const why = failure ? `network error (${failure.cause?.code ?? failure.name})` : `${response.status}: ${await messageOf(response)}`
    if (attempt > 1) throw Object.assign(new SendError(`${endpoint} failed after a retry: ${why}`), { status: response?.status })
    const wait = response?.status === 429 ? retryDelaySeconds(response.headers.get('retry-after')) : 2
    log(`Send failed with ${escapeData(why)}; retrying once in ${wait}s.`)
    await sleep(wait)
  }
}

// The workflow-command and output plumbing, kept here so @actions/core is not needed.
const escapeData = s => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
function setOutput(env, name, value) {
  if (!env.GITHUB_OUTPUT) return
  const delimiter = `awr_${randomUUID()}`
  appendFileSync(env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${value}\n${delimiter}\n`)
}

export async function main(env = process.env, out = s => process.stdout.write(`${s}\n`)) {
  const token = input(env, 'token')
  const redact = s => token ? String(s).split(token).join('***') : String(s)
  const say = s => out(redact(s))
  if (token) out(`::add-mask::${token}`)
  try {
    const endpoint = input(env, 'endpoint')
    const mode = input(env, 'body') || 'fragment'
    const failOnError = !/^false$/i.test(input(env, 'fail-on-error') || 'true')
    if (!['fragment', 'hydrant'].includes(mode)) throw new ConfigError(`body "${mode}" is not fragment or hydrant.`)
    if (endpoint) {
      let url
      try { url = new URL(endpoint) } catch { throw new ConfigError(`endpoint "${endpoint}" is not a URL.`) }
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new ConfigError('endpoint must use https (plain http is allowed only for localhost).')
    }
    const fragment = buildFragment(env)
    const file = input(env, 'output-file') || (endpoint ? '' : join(env.RUNNER_TEMP || '.', `awr-evidence-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT || '1'}.json`))
    const errors = fragmentErrors(fragment)
    if (errors.length) throw new ConfigError(`The fragment does not match the Agent Work Record v0 schema:\n  ${errors.join('\n  ')}`)
    setOutput(env, 'evidence-id', fragment.evidence.id)
    say(`Evidence ${fragment.evidence.id} (${fragment.evidence.result}) for ${fragment.work}`)
    if (file) {
      writeFileSync(file, `${JSON.stringify(fragment, null, 2)}\n`)
      setOutput(env, 'fragment-file', resolve(file))
      say(`Wrote the fragment to ${file}.`)
    }
    if (!endpoint) return 0
    try {
      const { status, text } = await send(endpoint, token, bodyFor(mode, fragment), { log: say })
      setOutput(env, 'status', String(status))
      say(`Sent to ${endpoint}: ${status}.`)
      if (text.trim()) say(`Response: ${escapeData(text.trim().slice(0, 2000))}`)
      return 0
    } catch (error) {
      if (!(error instanceof SendError)) throw error
      if (error.status) setOutput(env, 'status', String(error.status))
      if (failOnError) { say(`::error::${escapeData(redact(error.message))}`); return 1 }
      say(`::warning::${escapeData(redact(error.message))}`)
      return 0
    }
  } catch (error) {
    say(`::error::${escapeData(redact(error instanceof ConfigError ? error.message : error.stack ?? error))}`)
    return 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main()
