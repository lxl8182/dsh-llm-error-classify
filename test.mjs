/**
 * Relabelling checks. Run: node test.mjs
 *
 * The negative cases matter most: a non-AUTH code must stay untouched, or the
 * plugin would override failures the UI already renders correctly.
 */
import { reclassifyChunk, scrubCredentials, PROVIDER_ERROR_CODE } from './index.js'

// The payloads that motivated this: a gateway reporting a non-credential
// problem over 401/403, all of which the adapter tags AUTH and the UI blanks.
const QUOTA = 'OpenAI API error (403): {"message":"预扣费额度失败, 用户剩余额度: ¥0.029168, 需要预扣费额度: ¥0.311748 (request id: 202609280654339099149708268d9d6arKheSRt)","type":"new_api_error","param":"","code":"insufficient_user_quota"}'
const NO_CHANNEL = 'OpenAI API error (403): {"message":"当前分组下没有可用渠道","type":"new_api_error","code":"channel_not_found"}'
const MODEL_DENIED = 'OpenAI API error (403): {"message":"该令牌无权使用模型 gpt-4o","type":"new_api_error","code":"token_model_denied"}'
const BAD_KEY = 'OpenAI API error (401): Incorrect API key provided: sk-proj-abc***xyz. You can find your API key at https://platform.openai.com/account/api-keys.'

const finish = (message, code = 'AUTH') => ({ type: 'finish', reason: { kind: 'error', failure: { message, code } } })

const cases = [
  // [label, message, input code, expected output code]
  ['gateway quota 403', QUOTA, 'AUTH', PROVIDER_ERROR_CODE],
  ['gateway no-channel 403', NO_CHANNEL, 'AUTH', PROVIDER_ERROR_CODE],
  ['gateway model-denied 403', MODEL_DENIED, 'AUTH', PROVIDER_ERROR_CODE],
  ['genuine bad key 401', BAD_KEY, 'AUTH', PROVIDER_ERROR_CODE],
  ['credentials at onboarding error', 'HTTP 401: token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 rejected', 'AUTH', PROVIDER_ERROR_CODE],
  ['non-AUTH code untouched', QUOTA, 'RATE_LIMIT', 'RATE_LIMIT'],
  ['QUOTA untouched', QUOTA, 'QUOTA', 'QUOTA'],
  ['SERVER untouched', 'HTTP 500: upstream error', 'SERVER', 'SERVER'],
]

let failed = 0
for (const [label, message, inCode, want] of cases) {
  const got = reclassifyChunk(finish(message, inCode)).reason.failure.code
  const pass = got === want
  if (!pass) failed++
  console.log(`${pass ? 'PASS' : 'FAIL'} | ${label.padEnd(32)} ${inCode} -> ${got}`)
}

// The provider text must survive so the notice stays actionable.
const kept = reclassifyChunk(finish(NO_CHANNEL))
const textKept = kept.reason.failure.message.includes('没有可用渠道')
if (!textKept) failed++
console.log(`${textKept ? 'PASS' : 'FAIL'} | provider text preserved in full`)

// Relabelling removes the upstream credential guard, so scrubbing must hold.
// The masked tail must go too — a leaked `***xyz` still narrows the key.
const scrubbed = reclassifyChunk(finish(BAD_KEY)).reason.failure.message
const leaked = /sk-proj|abc\*|xyz/.test(scrubbed)
if (leaked) failed++
console.log(`${!leaked ? 'PASS' : 'FAIL'} | echoed credential scrubbed whole`)

// A credential the vendor prefix does not identify still must not survive
// verbatim once it appears beside a Bearer header.
const bearer = scrubCredentials('HTTP 401: {"error":"invalid api key","authorization":"Bearer abc123def456ghi789"}')
const bearerGone = !bearer.includes('abc123def456ghi789')
if (!bearerGone) failed++
console.log(`${bearerGone ? 'PASS' : 'FAIL'} | bearer token scrubbed`)

// Non-finish chunks pass through by identity (no needless copies).
const delta = { type: 'text-delta', index: 0, text: 'hi' }
const same = reclassifyChunk(delta) === delta
if (!same) failed++
console.log(`${same ? 'PASS' : 'FAIL'} | non-finish chunk untouched`)

// Aborted finishes carry the same misclassification and must also be relabelled.
const aborted = reclassifyChunk({ type: 'finish', reason: { kind: 'aborted', failure: { message: NO_CHANNEL, code: 'AUTH' } } })
const abortedOk = aborted.reason.failure.code === PROVIDER_ERROR_CODE
if (!abortedOk) failed++
console.log(`${abortedOk ? 'PASS' : 'FAIL'} | aborted finish corrected`)

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
