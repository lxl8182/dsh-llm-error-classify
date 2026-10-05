/**
 * Keep the provider's own failure text visible, instead of letting the UI
 * replace it with a canned message.
 *
 * The pi-ai adapter classifies a terminal failure from provider *text* alone
 * (`llm-pi-ai/src/stream.ts`, `classifyPiAiError`), and its very first rule is
 * `if (/\b(?:401|403)\b/.test(message)) return 'AUTH'`. That rule runs before
 * every more specific one, so *any* 401/403 reaches the UI tagged `AUTH`: an
 * exhausted balance, a disabled channel, a token not allowed to use the model,
 * an IP allowlist rejection, and a genuinely wrong key all arrive alike.
 *
 * `AUTH` is the one code the UI refuses to render verbatim. `displayFailure`
 * blanks the message (`ui-chat/.../conversation-nodes/event-projection.ts`,
 * and again in `ui-trajectory/.../trajectory-event-projection.ts` — both
 * surfaces), and `failureMessage` substitutes a canned string, which reads as
 * "API 密钥无效" and sends the user off to rotate a credential that was never
 * the problem.
 *
 * This plugin relabels those failures with a code the UI does not special-case,
 * so the provider's text reaches the user unchanged.
 *
 * Extension point: the `llm/stream` waterfall wraps the raw adapter chunk
 * iterator, so a listener sees the terminal `finish` chunk before the agent
 * loop persists it. Rewriting the failure there fixes both the durable session
 * record and what the UI renders.
 *
 * Trade-off: the upstream blanking doubles as a credential guard — a provider
 * AUTH message can echo a masked or partial key. Relabelling removes that
 * guard, so credential-shaped substrings are scrubbed before the text is
 * passed on.
 *
 * @module dsh-llm-error-classify
 */

/**
 * Replacement code for a relabelled `AUTH` failure. Deliberately outside the
 * set the UI special-cases (`AUTH`, `QUOTA`, `ACCOUNT_QUOTA`,
 * `ACCOUNT_SIGNED_OUT`, `ACCOUNT_SIGN_IN_REQUIRED`), so `failureMessage` falls
 * through to the provider text, and outside the default retryable set
 * (`EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`), so the
 * retry policy behaves exactly as it did under `AUTH`.
 */
export const PROVIDER_ERROR_CODE = 'PROVIDER_ERROR'

/**
 * Credential-shaped substrings a provider message can echo back. The real key
 * is not available here — `GenerateOptions` carries no credential, since the
 * adapter resolves it privately — so this matches by shape rather than by
 * value, and therefore cannot catch a key no vendor prefix identifies.
 */
const CREDENTIAL_SHAPED = new RegExp([
  // Vendor-prefixed keys: sk-…, sk-proj-…, ghp_…, github_pat_…, xoxb-…
  // The tail also admits `*` and `.` so a key the provider already masked
  // (`sk-proj-abc***xyz`, `sk-abc...xyz`) is consumed whole rather than
  // leaving the masked remainder behind.
  String.raw`\b(?:sk|rk|pk|ghp|gho|ghs|ghr|github_pat|xox[baprs])[-_][A-Za-z0-9_*.-]{8,}`,
  // An Authorization header echoed into the message body.
  String.raw`\bBearer\s+[A-Za-z0-9._~+/=-]{8,}`,
].join('|'), 'gi')

/**
 * Blank credential-shaped substrings in a provider message.
 * @param message - the provider failure text.
 * @returns the text with credential-shaped runs replaced by `[redacted]`.
 */
export function scrubCredentials(message) {
  return message.replace(CREDENTIAL_SHAPED, '[redacted]')
}

/**
 * Relabel one terminal `finish` chunk whose failure was mislabelled `AUTH`.
 * @param chunk - one stream chunk from the adapter.
 * @returns the original chunk, or a copy carrying a code the UI will render.
 */
export function reclassifyChunk(chunk) {
  if (chunk === null || typeof chunk !== 'object' || chunk.type !== 'finish') return chunk
  const reason = chunk.reason
  if (reason === null || typeof reason !== 'object') return chunk
  if (reason.kind !== 'error' && reason.kind !== 'aborted') return chunk
  const failure = reason.failure
  if (failure === null || typeof failure !== 'object') return chunk
  // Only ever override the one code that reaches the UI as a canned string;
  // every other code already renders its own message and is left untouched.
  if (failure.code !== 'AUTH') return chunk
  return {
    ...chunk,
    reason: {
      ...reason,
      failure: {
        ...failure,
        code: PROVIDER_ERROR_CODE,
        // The provider text names the real cause; keep it so the notice is
        // actionable rather than generic. A quota payload keeps the amounts
        // involved, a channel error keeps the channel name.
        message: typeof failure.message === 'string'
          ? scrubCredentials(failure.message)
          : failure.message,
      },
    },
  }
}

export const name = 'llm-error-classify'
export const inject = ['llm']

/**
 * Register the relabelling listener on the per-call stream waterfall.
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  ctx.on('llm/stream', (options, next) => {
    const upstream = next()
    return {
      [Symbol.asyncIterator]() {
        const iterator = upstream[Symbol.asyncIterator]()
        return {
          async next() {
            const result = await iterator.next()
            if (result.done === true) return result
            return { done: false, value: reclassifyChunk(result.value) }
          },
          async return(value) {
            // Delegate so the adapter's own finally-block teardown still runs;
            // swallowing the return would leak the aborted stream.
            return iterator.return === undefined ? { done: true, value } : iterator.return(value)
          },
        }
      },
    }
  })
}
