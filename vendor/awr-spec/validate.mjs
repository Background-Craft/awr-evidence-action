#!/usr/bin/env node
// Validates the agent work record v0 and v0.1 examples with no dependencies: node docs/spec/validate.mjs
// Given paths (node docs/spec/validate.mjs record.json ...), it checks only those records, against the schema and rules.
//
// It enforces a declared subset of JSON Schema draft 2020-12 and refuses any schema keyword outside it, so the schema
// can never rely on a rule this script skips. It then applies the record rules JSON Schema cannot express (references
// resolve, the audit trail is ordered and complete, agents act only under a live grant). Records are in examples/ and
// examples/v0.1/, fragments in examples/fragments/. A record that uses a v0.1 addition must say agent-work-record/v0.1,
// and every v0 rule still applies to a record that says v0. Every file in an invalid/ folder must fail with its expected message, which proves
// the checks bite. Strict on purpose: this is the writer conformance check.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const here = dirname(fileURLToPath(import.meta.url))
const read = path => JSON.parse(readFileSync(join(here, path), 'utf8'))
const schema = read('agent-work-record-v0.schema.json')

const annotations = new Set(['$schema', '$id', '$defs', '$comment', 'title', 'description'])
const assertions = new Set(['$ref', 'type', 'const', 'enum', 'pattern', 'format', 'required', 'properties', 'additionalProperties', 'items', 'minItems', 'minLength', 'minimum', 'anyOf', 'if', 'then'])
// RFC 3339 date-time. The fields must survive a round trip through Date.UTC, so 2026-02-30 and 24:00 fail.
// Leap seconds (:60) are refused too, which v0 accepts as a simplification.
function dateTime(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(v)
  if (!m) return false
  const [y, mo, d, h, mi, sec] = m.slice(1, 7).map(Number)
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, sec))
  const same = t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d && t.getUTCHours() === h && t.getUTCMinutes() === mi && t.getUTCSeconds() === sec
  return same && (m[8] === 'Z' || (Number(m[9]) <= 23 && Number(m[10]) <= 59))
}
const formats = {
  // Only checks for a scheme and no whitespace, not full RFC 3986 syntax.
  uri: v => /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/.test(v),
  'date-time': dateTime,
}

function checkSubset(node, path) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return
  // validate() follows $ref and ignores its siblings, so a sibling assertion would be silently skipped.
  if (node.$ref && Object.keys(node).some(key => key !== '$ref' && assertions.has(key))) throw new Error(`schema: no assertion keywords beside $ref at ${path}`)
  for (const [key, value] of Object.entries(node)) {
    if (!annotations.has(key) && !assertions.has(key)) throw new Error(`schema uses unsupported keyword ${key} at ${path}`)
    if (key === 'additionalProperties' && value !== false) throw new Error(`schema: only additionalProperties false is supported at ${path}`)
    if (key === 'format' && !formats[value]) throw new Error(`schema: unsupported format ${value} at ${path}`)
    if (key === '$ref' && !/^#\/\$defs\/[a-z_]+$/.test(value)) throw new Error(`schema: only local $defs references are supported at ${path}`)
    if (key === 'properties' || key === '$defs') for (const [name, sub] of Object.entries(value)) checkSubset(sub, `${path}/${key}/${name}`)
    else if (key === 'anyOf') value.forEach((sub, i) => checkSubset(sub, `${path}/anyOf/${i}`))
    else if (['items', 'if', 'then'].includes(key)) checkSubset(value, `${path}/${key}`)
  }
}

const typeOf = v => v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v
function validate(value, node, path, errors) {
  if (node.$ref) return validate(value, schema.$defs[node.$ref.slice('#/$defs/'.length)], path, errors)
  if (node.type && !(typeOf(value) === node.type || (node.type === 'number' && typeOf(value) === 'integer'))) {
    errors.push(`${path}: expected ${node.type}`)
    return errors
  }
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
    if (node.items) value.forEach((item, i) => validate(item, node.items, `${path}[${i}]`, errors))
  }
  if (typeOf(value) === 'object') {
    for (const key of node.required ?? []) if (!(key in value)) errors.push(`${path}: missing required property "${key}"`)
    for (const [key, item] of Object.entries(value)) {
      if (node.properties?.[key]) validate(item, node.properties[key], `${path}.${key}`, errors)
      else if (node.additionalProperties === false) errors.push(`${path}: unknown property "${key}"`)
    }
  }
  if (node.anyOf && !node.anyOf.some(sub => validate(value, sub, path, []).length === 0)) errors.push(`${path}: matches none of the allowed forms`)
  if (node.if && validate(value, node.if, path, []).length === 0 && node.then) validate(value, node.then, path, errors)
  return errors
}

// Rules a record must meet beyond its shape. Returns a list of messages; empty means the record holds together.
function checkRecord(r) {
  const errors = []
  // v0.1 adds people[], and on a sign-off sign_off_grant and unlisted_evidence. A v0 record carries none of them.
  const v01 = r.spec === 'agent-work-record/v0.1'
  if (!v01) {
    if ('people' in r) errors.push('people needs spec agent-work-record/v0.1')
    for (const s of r.signoffs) for (const key of ['sign_off_grant', 'unlisted_evidence']) if (key in s) errors.push(`signoff ${s.id}: ${key} needs spec agent-work-record/v0.1`)
  }
  const ids = new Map(), objects = new Map()
  const own = (kind, o) => { if (ids.has(o.id)) errors.push(`duplicate id ${o.id}`); ids.set(o.id, kind); objects.set(o.id, o) }
  own('work', r.work)
  r.agents.forEach(a => own('agent', a))
  r.grants.forEach(g => own('grant', g))
  r.evidence.forEach(e => own('evidence', e))
  r.signoffs.forEach(s => own('signoff', s))
  const people = new Set([...r.agents.map(a => a.on_behalf_of.id), ...r.grants.map(g => g.granted_by.id), ...r.signoffs.map(s => s.by.id)])
  for (const p of people) if (ids.get(p) === 'agent') errors.push(`${p} is both a person and an agent`)
  // v0.1: people[] names those who only acted (role actor), so it never repeats someone the record already names.
  const actors = new Set()
  for (const p of r.people ?? []) {
    if (actors.has(p.id)) errors.push(`${p.id} is listed in people more than once`)
    if (ids.get(p.id) === 'agent') errors.push(`${p.id} is both a person and an agent`)
    if (people.has(p.id)) errors.push(`${p.id} is listed in people but the record already names them as an agent's person, a grantor or a decider`)
    actors.add(p.id)
  }
  const isAgent = id => ids.get(id) === 'agent'
  const known = id => people.has(id) || isAgent(id)

  for (const g of r.grants) {
    if (!isAgent(g.agent)) errors.push(`grant ${g.id}: agent ${g.agent} is not in agents`)
    if (g.work && g.work !== r.work.id) errors.push(`grant ${g.id}: work ${g.work} is not this record's work`)
    if (g.expires_at && Date.parse(g.expires_at) <= Date.parse(g.issued_at)) errors.push(`grant ${g.id}: expires before it is issued`)
  }
  for (const e of r.evidence) if (!known(e.by)) errors.push(`evidence ${e.id}: by ${e.by} is not a known person or agent`)
  for (const s of r.signoffs) {
    // v0.1: cited evidence no longer listed is kept on the sign-off as its snapshot, and cited by its id.
    const snapshots = new Set()
    for (const e of s.unlisted_evidence ?? []) {
      if (snapshots.has(e.id)) errors.push(`signoff ${s.id}: unlisted evidence ${e.id} appears twice`)
      snapshots.add(e.id)
      if (ids.has(e.id)) errors.push(`signoff ${s.id}: unlisted evidence ${e.id} is also an object in this record`)
      if (!s.evidence.includes(e.id)) errors.push(`signoff ${s.id}: unlisted evidence ${e.id} is not cited in its evidence`)
    }
    for (const ref of s.evidence) if (ids.get(ref) !== 'evidence' && !snapshots.has(ref)) errors.push(`signoff ${s.id}: evidence ${ref} is not in evidence`)
    if (s.via !== undefined && !isAgent(s.via)) errors.push(`signoff ${s.id}: via ${s.via} is not in agents`)
    if (s.sign_off_grant === false && s.via === undefined) errors.push(`signoff ${s.id}: sign_off_grant false needs via`)
  }

  // The audit trail: seq counts up from 1 with no gaps, time never goes backwards, every reference resolves.
  const revokedGrants = new Map(), revokedAgents = new Map()
  r.events.forEach((ev, i) => {
    if (ev.seq !== i + 1) errors.push(`event ${i + 1}: seq is ${ev.seq}; events must be numbered 1, 2, 3 in order`)
    if (i > 0 && Date.parse(ev.at) < Date.parse(r.events[i - 1].at)) errors.push(`event ${ev.seq}: earlier than the event before it`)
    if (actors.has(ev.actor)) {
      if (ev.type !== 'work.status_changed' && ev.type !== 'claim.made') errors.push(`event ${ev.seq}: ${ev.actor} is listed in people as an actor, who makes only work.status_changed and claim.made events`)
    } else if (!known(ev.actor)) errors.push(`event ${ev.seq}: actor ${ev.actor} is not a known person or agent`)
    if (!ids.has(ev.ref)) errors.push(`event ${ev.seq}: ref ${ev.ref} is not in this record`)
    if (ev.type === 'grant.revoked') revokedGrants.set(ev.ref, Date.parse(ev.at))
    if (ev.type === 'agent.revoked') revokedAgents.set(ev.ref, Date.parse(ev.at))
  })
  for (const p of actors) if (!r.events.some(ev => ev.actor === p)) errors.push(`${p} is listed in people but makes no event`)
  const expected = [['agent', 'agent.connected'], ['grant', 'grant.issued'], ['evidence', 'evidence.added'], ['signoff', 'signoff.recorded']]
  for (const [kind, type] of expected) for (const [id, k] of ids) {
    if (k === kind && !r.events.some(ev => ev.type === type && ev.ref === id)) errors.push(`${kind} ${id}: no ${type} event in the audit trail`)
  }
  // Each event type names one kind of object, and a creating event is made by whoever the object says made it.
  const refKind = { 'agent.connected': 'agent', 'agent.revoked': 'agent', 'grant.issued': 'grant', 'grant.revoked': 'grant', 'work.status_changed': 'work', 'evidence.added': 'evidence', 'claim.made': 'work', 'signoff.recorded': 'signoff' }
  const creators = {
    'agent.connected': a => [a.on_behalf_of.id],
    'grant.issued': g => [g.granted_by.id],
    'evidence.added': e => [e.by],
    'signoff.recorded': s => [s.by.id, s.via].filter(Boolean),
  }
  for (const ev of r.events) {
    if (ids.has(ev.ref) && ids.get(ev.ref) !== refKind[ev.type]) errors.push(`event ${ev.seq}: ${ev.type} needs a ${refKind[ev.type]} ref, but ${ev.ref} is kind ${ids.get(ev.ref)}`)
    else if (creators[ev.type] && ids.has(ev.ref) && !creators[ev.type](objects.get(ev.ref)).includes(ev.actor)) errors.push(`event ${ev.seq}: ${ev.type} actor ${ev.actor} is not who the ${refKind[ev.type]} says made it`)
  }

  // Agents act only under a grant that was issued, unexpired and unrevoked at that moment, and only while connected.
  const live = (agent, at, action, person) => r.grants.some(g => g.agent === agent
    && Date.parse(g.issued_at) <= at && (!g.expires_at || at < Date.parse(g.expires_at))
    && !(revokedGrants.get(g.id) <= at)
    && (!action || g.actions.includes(action)) && (!person || g.granted_by.id === person))
  for (const ev of r.events) {
    if (!isAgent(ev.actor)) continue
    const at = Date.parse(ev.at)
    if (revokedAgents.get(ev.actor) <= at) errors.push(`event ${ev.seq}: agent ${ev.actor} acted after it was revoked`)
    if (!live(ev.actor, at)) errors.push(`event ${ev.seq}: agent ${ev.actor} had no live grant at ${ev.at}`)
  }
  // An agent records a sign-off only for the person who granted it sign_off; the decision stays that person's. v0.1
  // keeps one recorded without that grant when it says so with sign_off_grant: false, and only then.
  for (const s of r.signoffs) if (s.via) {
    const granted = live(s.via, Date.parse(s.at), 'sign_off', s.by.id)
    if (!granted && !(v01 && s.sign_off_grant === false)) errors.push(`signoff ${s.id}: ${s.via} recorded it without a live sign_off grant from ${s.by.id}${v01 ? ' and without sign_off_grant: false' : ''}`)
    if (granted && s.sign_off_grant === false) errors.push(`signoff ${s.id}: says sign_off_grant false, but ${s.via} had a live sign_off grant from ${s.by.id}`)
  }
  return errors
}

const recordErrors = value => {
  const errors = validate(value, schema.$defs.record, '$', [])
  return errors.length ? errors : checkRecord(value)
}
// A fragment is checked on its own shape only. Ids, creating events and grants are checked once a tracker merges it.
const fragmentErrors = value => validate(value, schema.$defs[typeOf(value) === 'object' && 'evidence' in value ? 'evidence_fragment' : 'event_fragment'], '$', [])

// Invalid examples and the message each must produce.
const expectedFailures = {
  'bad-timestamp.json': 'not a valid date-time',
  'impossible-date.json': 'not a valid date-time',
  'signoff-recorded-by-agent-without-via.json': 'is not who the signoff says made it',
  'event-names-wrong-object.json': 'grant.revoked needs a grant ref',
  'reject-without-note.json': 'missing required property "note"',
  'unknown-field.json': 'unknown property "confidence"',
  'agent-without-grant.json': 'had no live grant',
  'delegated-signoff-without-grant.json': 'without a live sign_off grant from https://tracker.example.com/w/acme/people/dana and without sign_off_grant: false',
  'reordered-audit-trail.json': 'events must be numbered 1, 2, 3 in order',
  'event-with-seq-and-at.json': 'unknown property "seq"',
  'evidence-claim-not-a-string.json': '$.evidence.claim: matches none of the allowed forms',
}

let failed = 0
const pass = msg => console.log(`ok    ${msg}`)
const fail = msg => { failed++; console.log(`FAIL  ${msg}`) }

checkSubset(schema, '#')
pass('schema uses only the enforced keyword subset')

const given = process.argv.slice(2)
for (const path of given) {
  let errors
  try { errors = recordErrors(JSON.parse(readFileSync(resolve(path), 'utf8'))) } catch (error) { errors = [error.message] }
  if (errors.length) fail(`${path}\n      ${errors.join('\n      ')}`)
  else pass(`${path} is valid`)
}
if (given.length) {
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed')
  process.exit(failed ? 1 : 0)
}

const jsonFiles = dir => readdirSync(join(here, dir)).filter(f => f.endsWith('.json')).sort()
// examples/hydrant holds records Hydrant exported from seeded issues (test/work-record-export.test.ts keeps them current).
// examples/v0.1 holds one record for each v0.1 addition.
for (const [dir, check] of [['examples', recordErrors], ['examples/v0.1', recordErrors], ['examples/hydrant', recordErrors], ['examples/fragments', fragmentErrors]]) {
  for (const file of jsonFiles(dir)) {
    const errors = check(read(join(dir, file)))
    if (errors.length) fail(`${dir}/${file}\n      ${errors.join('\n      ')}`)
    else pass(`${dir}/${file} is valid`)
  }
  const invalid = `${dir}/invalid`
  if (!existsSync(join(here, invalid))) continue
  for (const file of jsonFiles(invalid)) {
    const errors = check(read(join(invalid, file)))
    const expected = expectedFailures[file]
    if (!expected) fail(`${invalid}/${file} has no expected message in validate.mjs`)
    else if (!errors.length) fail(`${invalid}/${file} was accepted`)
    else if (!errors.some(e => e.includes(expected))) fail(`${invalid}/${file} failed for another reason: ${errors.join('; ')}`)
    else pass(`${invalid}/${file} rejected: ${errors.find(e => e.includes(expected))}`)
  }
}
const invalidFiles = [...jsonFiles('examples/invalid'), ...jsonFiles('examples/fragments/invalid')]
for (const name of Object.keys(expectedFailures)) if (!invalidFiles.includes(name)) fail(`invalid example ${name} is missing`)

// Every JSON block in the spec that follows <!-- validate: NAME --> must validate against that $defs entry, as a whole
// record for "record", or as a fragment for "fragment". "same-as=PATH" must also equal that file, so the spec cannot drift.
const spec = readFileSync(join(here, 'agent-work-record-v0.md'), 'utf8')
const blocks = [...spec.matchAll(/<!-- validate: ([a-z_]+)(?: same-as=(\S+))? -->\s*```json\n([\s\S]*?)\n```/g)]
if (!blocks.length) fail('agent-work-record-v0.md has no validated examples')
for (const [, name, sameAs, body] of blocks) {
  let value
  try { value = JSON.parse(body) } catch (error) { fail(`spec example "${name}" is not JSON: ${error.message}`); continue }
  const errors = name === 'record' ? recordErrors(value) : name === 'fragment' ? fragmentErrors(value) : schema.$defs[name] ? validate(value, schema.$defs[name], name, []) : [`no $defs entry named ${name}`]
  if (sameAs && !isDeepStrictEqual(value, read(sameAs))) errors.push(`differs from ${sameAs}`)
  if (errors.length) fail(`spec example "${name}"\n      ${errors.join('\n      ')}`)
  else pass(`spec example "${name}" is valid${sameAs ? ` and matches ${sameAs}` : ''}`)
}

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed')
process.exitCode = failed ? 1 : 0
