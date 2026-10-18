#!/usr/bin/env node
// A stand-in tracker for CI. It accepts POST /bare (a bare fragment) and POST /hydrant ({ requestId, fragment }),
// checks the bearer header and the body, and answers 429 with Retry-After once per path before 200.
//   node test/mock-receiver.mjs serve <port>   (token in MOCK_TOKEN)
//   node test/mock-receiver.mjs check <port>   exits 1 unless each path saw 429 then 200 and nothing was refused
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fragmentErrors, requestIdFor } from '../index.mjs'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function receiver(token) {
  const seen = { bare: [], hydrant: [] }
  const problems = []
  const first = {}
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      const answer = (status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)) }
      if (req.method === 'GET' && req.url === '/report') return answer(200, { seen, problems })
      const path = req.url.slice(1)
      if (req.method !== 'POST' || !(path in seen)) return answer(404, { error: 'Not found.' })
      const refuse = message => { problems.push(`${path}: ${message}`); answer(400, { error: message }) }
      if (req.headers.authorization !== `Bearer ${token}`) return refuse('wrong or missing bearer token')
      if (req.headers['content-type'] !== 'application/json') return refuse('content-type is not application/json')
      let body
      try { body = JSON.parse(raw) } catch { return refuse('body is not JSON') }
      let fragment = body
      if (path === 'hydrant') {
        if (Object.keys(body).sort().join() !== 'fragment,requestId') return refuse('hydrant body must be exactly { requestId, fragment }')
        if (!uuid.test(body.requestId)) return refuse('requestId is not a UUID')
        if (body.requestId !== requestIdFor(body.fragment?.evidence?.id ?? '')) return refuse('requestId is not derived from the evidence id')
        fragment = body.fragment
      } else if ('requestId' in body) return refuse('bare body must be the fragment itself')
      const errors = fragmentErrors(fragment)
      if (errors.length) return refuse(`fragment shape: ${errors.join('; ')}`)
      if (fragment.evidence.kind !== 'ci_run') return refuse('kind is not ci_run')
      if (!/\/actions\/runs\/\d+\/attempts\/\d+$/.test(fragment.evidence.id)) return refuse('evidence id is not a run attempt URL')
      if (!fragment.evidence.id.startsWith(`${fragment.evidence.uri}/attempts/`)) return refuse('uri is not the run URL')
      if (seen[path].length === 0) { first[path] = raw; seen[path].push(429); return answer(429, { error: 'Slow down.' }, { 'Retry-After': '1' }) }
      if (raw !== first[path]) return refuse('the retry sent a different body')
      seen[path].push(200)
      answer(200, { evidence: fragment.evidence.id, received: true })
    })
  })
  return { server, seen, problems }
}

const direct = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
const [mode, port] = direct ? process.argv.slice(2) : []
if (mode === 'serve') {
  if (!process.env.MOCK_TOKEN) { console.error('MOCK_TOKEN is required'); process.exit(2) }
  receiver(process.env.MOCK_TOKEN).server.listen(Number(port), '127.0.0.1', () => console.log(`mock receiver on ${port}`))
} else if (mode === 'check') {
  const { seen, problems } = await (await fetch(`http://127.0.0.1:${port}/report`)).json()
  console.log(JSON.stringify({ seen, problems }, null, 2))
  const ok = problems.length === 0 && ['bare', 'hydrant'].every(p => JSON.stringify(seen[p]) === '[429,200]')
  console.log(ok ? 'mock receiver: each body shape got 429 then 200, nothing refused' : 'mock receiver: expectations not met')
  process.exit(ok ? 0 : 1)
}
