#!/usr/bin/env node
// Checks fragment files with the vendored validate.mjs, unchanged. Given paths, validate.mjs checks records only, so this
// copies the vendored spec to a temporary folder, adds each fragment to examples/fragments/ and runs the whole check there.
//   node test/validate-fragment.mjs fragment.json ...
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const files = process.argv.slice(2)
if (!files.length) { console.error('usage: node test/validate-fragment.mjs fragment.json ...'); process.exit(2) }
const dir = mkdtempSync(join(tmpdir(), 'awr-spec-'))
cpSync(fileURLToPath(new URL('../vendor/awr-spec', import.meta.url)), dir, { recursive: true })
files.forEach((file, i) => cpSync(file, join(dir, 'examples/fragments', `zz-action-${i}-${basename(file)}`)))
const result = spawnSync(process.execPath, [join(dir, 'validate.mjs')], { encoding: 'utf8' })
process.stdout.write(result.stdout.split('\n').filter(l => /zz-action-|^FAIL|^ {6}|^All checks passed|check\(s\) failed/.test(l)).join('\n') + '\n')
rmSync(dir, { recursive: true, force: true })
process.exit(result.status ?? 1)
