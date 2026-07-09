const assert = require('assert')
const { isSQLInterval } = require('../src/boss')

const valid = [
  '60 seconds',
  '21600 seconds',
  '60 second',
  '30 minutes',
  '30 minute',
  '2 hours',
  '2 hour',
  '3hour',
  '1 days',
  '1 day',
  '3day',
  '1 week',
  '30s',
  '2h',
  '20min',
  '500 ms',
  '500ms',
  '  30s  ', // trimmed
  '1m',
  '7d',
  '1 year',
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
  '1s; DROP TABLE jobs',
  "1' OR '1'='1",
  '1s 2m',
  '-1s',
  '1.5s',
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

console.log('isSQLInterval')
for (const v of valid) {
  test(`accepts ${JSON.stringify(v)}`, () => assert.strictEqual(isSQLInterval(v), true))
}
for (const v of invalid) {
  test(`rejects ${JSON.stringify(v)}`, () => assert.strictEqual(isSQLInterval(v), false))
}

process.stdout.write(`\n${passed} passing, ${failed} failing\n`)
if (failed) process.exit(1)
