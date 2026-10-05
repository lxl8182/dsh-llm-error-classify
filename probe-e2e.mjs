/**
 * End-to-end probe: reclassification must survive the real `llm/stream`
 * waterfall, not just the pure functions.
 *
 * This plugin has no node_modules of its own, so the host packages are resolved
 * out of an existing dsh checkout rather than imported by bare specifier:
 *
 *     DSH_REPO=/path/to/dsh-checkout node probe-e2e.mjs
 *
 * DSH_REPO defaults to the current working directory, so running it from the
 * checkout root needs no variable.
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const repo = process.env.DSH_REPO ?? process.cwd()
const resolveFrom = join(repo, 'packages/llm/llm/package.json')
const require = createRequire(pathToFileURL(resolveFrom).href)
const load = specifier => import(pathToFileURL(require.resolve(specifier)).href)

const { Context } = await load('@deepseek-ai/cordis')
const { default: LlmRuntime, LlmAdapter, LlmError } = await load('@deepseek-ai/dsh-llm')

const PLUGIN = new URL('./index.js', import.meta.url).href

class ThrowingAdapter extends LlmAdapter {
  constructor(message, code) { super(); this.message = message; this.code = code }
  stream() { throw new LlmError(this.message, this.code) }
}

let failed = 0

async function run(label, message, code, expected, mustContain) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['probe'], new ThrowingAdapter(message, code))
  await ctx.plugin(await import(PLUGIN))

  const chunks = []
  try {
    for await (const c of ctx.llm.stream({ provider: 'probe', model: 'm', messages: [] })) chunks.push(c)
  } catch { /* a failing turn may throw instead of yielding a finish chunk */ }

  const failure = chunks.find(c => c.type === 'finish')?.reason?.failure
  const ok = failure?.code === expected
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${label.padEnd(26)} ${code} -> ${failure?.code}`)

  if (mustContain !== undefined && ok) {
    const kept = typeof failure.message === 'string' && failure.message.includes(mustContain)
    if (!kept) failed++
    console.log(`${kept ? 'PASS' : 'FAIL'} | ${''.padEnd(26)} text survives: ${JSON.stringify(String(failure.message).slice(0, 56))}`)
  }
}

await run('gateway no-channel 403', 'OpenAI API error (403): {"message":"当前分组下没有可用渠道","code":"channel_not_found"}', 'AUTH', 'PROVIDER_ERROR', '没有可用渠道')
await run('genuine bad key 401', 'OpenAI API error (401): Incorrect API key provided: sk-proj-abc***xyz', 'AUTH', 'PROVIDER_ERROR', 'Incorrect API key')
await run('non-AUTH untouched', 'HTTP 500: upstream error', 'SERVER', 'SERVER')
await run('QUOTA untouched', 'quota exhausted', 'QUOTA', 'QUOTA')

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
