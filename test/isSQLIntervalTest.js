const assert = require('assert')
const { isSQLInterval } = require('../src/boss')

const valid = [
  '30s',
  '1m',
  '2h',
  '7d',
  '60 seconds',
  '60 second',
  '30 minutes',
  '30 minute',
  '2 hours',
  '2 hour',
  '1 days',
  '1 day',
  '500 ms',
  '21600 seconds',
  '  30s  ' // trimmed
]

const invalid = [
  null,
  undefined,
  42,
  true,
  0,
  '0',
  '30', // if we give a number, we need units to avoid accidental milliseconds
  '',
  'abc',
  '1x',
  '1 week',
  '1 year',
  '1s; DROP TABLE jobs',
  "1' OR '1'='1",
  '1s 2m',
  '-1s',
  '1.5s'
]

let passed = 0
let failed = 0

function test (name, fn) {
  try {
    fn()
    process.stdout.write(`  ✓ ${name}\n`)
    passed++
  } catch (e) {
    process.stdout.write(`  ✗ ${name}: ${e.message}\n`)
    failed++
  }
}

for (const v of valid) { test(`accepts ${JSON.stringify(v)}`, () => assert.strictEqual(isSQLInterval(v), true)) }
for (const v of invalid) { test(`rejects ${JSON.stringify(v)}`, () => assert.strictEqual(isSQLInterval(v), false)) }

process.stdout.write(`\n${passed} passing, ${failed} failing\n`)
if (failed) process.exit(1)
