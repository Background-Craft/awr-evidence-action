import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bodyFor, buildFragment, fragmentErrors, headCommit, mapResult, requestIdFor, retryDelaySeconds, runIds, send } from '../index.mjs'
import { receiver } from './mock-receiver.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const entry = join(root, 'index.mjs')
const TOKEN = 'hyd_secret_TOKEN_value_5f1c2e'
const sha = 'a'.repeat(40)
const prHead = 'b'.repeat(40)
const github = (extra = {}) => ({
  GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'acme/app', GITHUB_RUN_ID: '123456', GITHUB_RUN_ATTEMPT: '2',
  GITHUB_SHA: sha, GITHUB_EVENT_NAME: 'push',
  INPUT_WORKSPACE: 'https://tracker.example.com/w/acme', INPUT_WORK: 'https://tracker.example.com/w/acme/issues/42',
  INPUT_BY: 'https://tracker.example.com/w/acme/agents/builder', INPUT_RESULT: 'success', ...extra,
})
const temp = () => mkdtempSync(join(tmpdir(), 'awr-action-'))

// Runs the action's entry script as GitHub would: inputs in INPUT_*, outputs appended to GITHUB_OUTPUT.
function run(env) {
  const dir = temp()
  const outputs = join(dir, 'outputs')
  writeFileSync(outputs, '')
  return new Promise(done => {
    const child = spawn(process.execPath, [entry], { env: { PATH: process.env.PATH, RUNNER_TEMP: dir, GITHUB_OUTPUT: outputs, ...env } })
    let stdout = '', stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('close', code => {
      const parsed = {}
      for (const m of readFileSync(outputs, 'utf8').matchAll(/^([\w-]+)<<(\S+)\n([\s\S]*?)\n\2$/gm)) parsed[m[1]] = m[3]
      done({ code, stdout, stderr, outputs: parsed, dir })
    })
  })
}
async function serve(handler) {
  const server = createServer(handler)
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) }
}
const reply = (status, body, headers = {}) => (req, res) => { req.resume(); req.on('end', () => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)) }) }
// The add-mask command is how a token is registered for masking; the runner consumes that line. Nothing else may carry it.
const withoutMask = s => s.split('\n').filter(l => l !== `::add-mask::${TOKEN}`).join('\n')

test('the evidence id is the run attempt URL and the uri is the run URL', () => {
  assert.deepEqual(runIds(github()), { id: 'https://github.com/acme/app/actions/runs/123456/attempts/2', uri: 'https://github.com/acme/app/actions/runs/123456' })
  assert.equal(runIds(github({ GITHUB_RUN_ATTEMPT: '' })).id, 'https://github.com/acme/app/actions/runs/123456/attempts/1')
  assert.equal(runIds(github({ GITHUB_SERVER_URL: 'https://ghe.example.com/' })).uri, 'https://ghe.example.com/acme/app/actions/runs/123456')
  assert.throws(() => runIds({}), /GITHUB_SERVER_URL is not set/)
})

test('subject is the pull request head on pull_request events and GITHUB_SHA otherwise', () => {
  const dir = temp()
  const event = join(dir, 'event.json')
  writeFileSync(event, JSON.stringify({ pull_request: { head: { sha: prHead } } }))
  assert.equal(headCommit(github({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event })), prHead)
  assert.equal(headCommit(github({ GITHUB_EVENT_NAME: 'pull_request_target', GITHUB_EVENT_PATH: event })), prHead)
  assert.equal(headCommit(github({ GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: event })), sha)
  assert.equal(buildFragment(github({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event })).evidence.subject.gitCommit, prHead)
  assert.equal(buildFragment(github()).evidence.subject.gitCommit, sha)
})

test('result maps job statuses and refuses anything else', () => {
  const expected = { pass: 'pass', fail: 'fail', pending: 'pending', neutral: 'neutral', success: 'pass', failure: 'fail', cancelled: 'neutral', skipped: 'neutral', SUCCESS: 'pass' }
  for (const [given, mapped] of Object.entries(expected)) assert.equal(mapResult(given), mapped, given)
  assert.throws(() => mapResult(''), /result is required/)
  assert.throws(() => mapResult('green'), /result "green" is not one of/)
})

test('the fragment carries the inputs and passes the shape check', () => {
  const now = new Date('2026-10-17T12:00:00.000Z')
  const fragment = buildFragment(github({ INPUT_NOTE: 'Unit tests at head.', INPUT_CLAIM: 'done' }), now)
  assert.deepEqual(fragment, {
    spec: 'agent-work-record/v0', workspace: 'https://tracker.example.com/w/acme', work: 'https://tracker.example.com/w/acme/issues/42',
    evidence: {
      id: 'https://github.com/acme/app/actions/runs/123456/attempts/2', kind: 'ci_run', uri: 'https://github.com/acme/app/actions/runs/123456',
      claim: 'done', by: 'https://tracker.example.com/w/acme/agents/builder', at: '2026-10-17T12:00:00.000Z', subject: { gitCommit: sha }, result: 'pass', note: 'Unit tests at head.',
    },
  })
  assert.deepEqual(fragmentErrors(fragment), [])
  assert.equal('note' in buildFragment(github()).evidence, false, 'an empty note is left out')
  assert.match(fragmentErrors(buildFragment(github({ INPUT_WORK: 'not a uri' }))).join(), /\$\.work: not a valid uri/)
  assert.throws(() => buildFragment(github({ INPUT_BY: '' })), /by is required/)
})

test('the shape check agrees with the vendored examples', () => {
  const read = path => JSON.parse(readFileSync(join(root, 'vendor/awr-spec/examples/fragments', path), 'utf8'))
  assert.deepEqual(fragmentErrors(read('evidence.json')), [])
  assert.match(fragmentErrors(read('invalid/evidence-claim-not-a-string.json')).join(), /\$\.evidence\.claim: matches none of the allowed forms/)
  const bad = read('evidence.json')
  bad.evidence.at = '2026-02-30T10:00:00Z'
  assert.match(fragmentErrors(bad).join(), /not a valid date-time/)
})

test('the vendored validator accepts the fragment the action writes', async () => {
  const result = await run(github({ 'INPUT_OUTPUT-FILE': join(temp(), 'fragment.json') }))
  assert.equal(result.code, 0, result.stdout)
  const validated = spawnSync(process.execPath, [join(root, 'test/validate-fragment.mjs'), result.outputs['fragment-file']], { encoding: 'utf8' })
  assert.equal(validated.status, 0, validated.stdout)
  assert.match(validated.stdout, /ok {4}examples\/fragments\/zz-action-0-fragment\.json is valid/)
})

test('requestId is a deterministic UUID v5 of the evidence id', () => {
  // RFC 9562 test vector: v5 of www.example.com in the DNS namespace.
  assert.equal(requestIdFor('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'), '2ed6657d-e927-568b-95e1-2665a8aea6a2')
  const first = runIds(github()).id
  assert.equal(requestIdFor(first), requestIdFor(first))
  assert.match(requestIdFor(first), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.notEqual(requestIdFor(runIds(github({ GITHUB_RUN_ATTEMPT: '3' })).id), requestIdFor(first))
})

test('both body shapes', () => {
  const fragment = buildFragment(github())
  assert.equal(bodyFor('fragment', fragment), fragment)
  assert.deepEqual(bodyFor('hydrant', fragment), { requestId: requestIdFor(fragment.evidence.id), fragment })
  assert.throws(() => bodyFor('envelope', fragment), /body "envelope"/)
})

test('post mode: both body shapes retry a 429 after Retry-After, then succeed', async () => {
  const mock = receiver(TOKEN)
  await new Promise(r => mock.server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${mock.server.address().port}`
  try {
    for (const shape of ['bare', 'hydrant']) {
      const started = Date.now()
      const result = await run(github({ INPUT_ENDPOINT: `${url}/${shape}`, INPUT_TOKEN: TOKEN, INPUT_BODY: shape === 'bare' ? 'fragment' : 'hydrant' }))
      assert.equal(result.code, 0, result.stdout)
      assert.ok(Date.now() - started >= 1000, 'waited for Retry-After')
      assert.match(result.stdout, /Send failed with 429: Slow down\.; retrying once in 1s\./)
      assert.equal(result.outputs.status, '200')
      assert.equal(result.outputs['evidence-id'], 'https://github.com/acme/app/actions/runs/123456/attempts/2')
      assert.equal(result.outputs['fragment-file'], undefined, 'no file without output-file when sending')
    }
    assert.deepEqual(mock.problems, [])
    assert.deepEqual(mock.seen, { bare: [429, 200], hydrant: [429, 200] })
  } finally { mock.server.close() }
})

test('a 4xx fails the step with the tracker message', async () => {
  const server = await serve(reply(403, { error: 'The fragment must come from the agent the key belongs to.' }))
  try {
    const result = await run(github({ INPUT_ENDPOINT: server.url, INPUT_TOKEN: TOKEN }))
    assert.equal(result.code, 1)
    assert.match(result.stdout, /::error::http:\/\/127\.0\.0\.1:\d+ answered 403: The fragment must come from the agent the key belongs to\./)
    assert.equal(result.outputs.status, '403')
  } finally { await server.close() }
})

test('fail-on-error false turns a send failure into a warning', async () => {
  const server = await serve(reply(409, { error: 'This request ID was already used for another command.' }))
  try {
    const result = await run(github({ INPUT_ENDPOINT: server.url, 'INPUT_FAIL-ON-ERROR': 'false' }))
    assert.equal(result.code, 0)
    assert.match(result.stdout, /::warning::.*answered 409: This request ID was already used for another command\./)
    assert.doesNotMatch(result.stdout, /::error::/)
  } finally { await server.close() }
})

test('fail-on-error false does not hide a configuration error', async () => {
  const result = await run(github({ INPUT_RESULT: 'green', 'INPUT_FAIL-ON-ERROR': 'false' }))
  assert.equal(result.code, 1)
  assert.match(result.stdout, /::error::result "green"/)
})

test('the token never appears in stdout or stderr, even when the tracker echoes it', async () => {
  const server = await serve((req, res) => { req.resume(); req.on('end', () => { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: `Unknown key ${req.headers.authorization}` })) }) })
  try {
    const result = await run(github({ INPUT_ENDPOINT: server.url, INPUT_TOKEN: TOKEN, INPUT_NOTE: 'note' }))
    assert.equal(result.code, 1)
    assert.match(result.stdout, /^::add-mask::/m)
    assert.match(result.stdout, /answered 401: Unknown key Bearer \*\*\*/)
    assert.equal(withoutMask(result.stdout).includes(TOKEN), false)
    assert.equal(result.stderr.includes(TOKEN), false)
  } finally { await server.close() }
})

test('one retry on 5xx and on a network error, then a clear failure', async () => {
  const fragment = buildFragment(github())
  const waits = []
  const sleep = s => { waits.push(s); return Promise.resolve() }
  let calls = 0
  const flaky = await serve((req, res) => { req.resume(); req.on('end', () => { calls++; res.writeHead(calls === 1 ? 503 : 200); res.end('{}') }) })
  try { assert.equal((await send(flaky.url, TOKEN, fragment, { sleep })).status, 200) } finally { await flaky.close() }
  assert.equal(calls, 2)
  const down = await serve(reply(500, { error: 'Down.' }))
  try { await assert.rejects(send(down.url, TOKEN, fragment, { sleep }), /failed after a retry: 500: Down\./) } finally { await down.close() }
  await assert.rejects(send('http://127.0.0.1:1/', TOKEN, fragment, { sleep }), /failed after a retry: network error/)
  assert.deepEqual(waits, [2, 2, 2])
})

test('Retry-After is honored in seconds or as a date, and capped', () => {
  assert.equal(retryDelaySeconds('3'), 3)
  assert.equal(retryDelaySeconds('3600'), 60)
  assert.equal(retryDelaySeconds(new Date(Date.parse('2026-10-17T12:00:10Z')).toUTCString(), Date.parse('2026-10-17T12:00:00Z')), 10)
  assert.equal(retryDelaySeconds(null), 5)
  assert.equal(retryDelaySeconds('soon'), 5)
})

test('redirects are not followed, so the token stays with the endpoint', async () => {
  let followed = false
  const elsewhere = await serve((req, res) => { followed = true; reply(200, {})(req, res) })
  const server = await serve(reply(307, {}, { Location: elsewhere.url }))
  try {
    const result = await run(github({ INPUT_ENDPOINT: server.url, INPUT_TOKEN: TOKEN }))
    assert.equal(result.code, 1)
    assert.match(result.stdout, /answered 307/)
    assert.equal(followed, false)
  } finally { await server.close(); await elsewhere.close() }
})

test('plain http is refused except for localhost', async () => {
  const result = await run(github({ INPUT_ENDPOINT: 'http://tracker.example.com/fragments', INPUT_TOKEN: TOKEN }))
  assert.equal(result.code, 1)
  assert.match(result.stdout, /endpoint must use https/)
})

test('file mode writes the fragment, and a rerun of the step in the same attempt resends it unchanged', async () => {
  const file = join(temp(), 'fragment.json')
  const first = await run(github({ 'INPUT_OUTPUT-FILE': file }))
  assert.equal(first.code, 0, first.stdout)
  assert.equal(first.outputs['fragment-file'], file)
  const written = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(fragmentErrors(written), [])
  await new Promise(r => setTimeout(r, 20))
  const again = await run(github({ 'INPUT_OUTPUT-FILE': file }))
  assert.match(again.stdout, /Reusing the fragment already in/)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), written)
  const changed = await run(github({ 'INPUT_OUTPUT-FILE': file, INPUT_RESULT: 'failure' }))
  assert.doesNotMatch(changed.stdout, /Reusing/)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).evidence.result, 'fail')
})

test('without endpoint or output-file the fragment goes to RUNNER_TEMP', async () => {
  const result = await run(github())
  assert.equal(result.code, 0, result.stdout)
  assert.equal(result.outputs['fragment-file'], join(result.dir, 'awr-evidence-123456-2.json'))
  assert.equal(result.outputs.status, undefined)
})
