/**
 * The Jev transport, ported from fast-jev-compaction's `request.ts` and
 * `client.ts`: one POST per batch of `noul` questions against the TypeSafe
 * System One endpoint, authenticated with `TYPESAFE_API_KEY`.
 *
 * The `state` sent with every request is the whole fitted conversation; the
 * questions name each candidate call twice — should the call stay, should the
 * full result stay verbatim.
 *
 * @module fast-compaction-dsh/jev
 */

/** The default System One endpoint. */
export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone'

/** The default Jev model. */
export const DEFAULT_MODEL = 'jev-latest'

/** One `noul` question: a yes/no probability ask. */
export interface NoulQuestion {
  readonly type: 'noul'
  readonly instructions: string
  readonly criteria?: { true?: string; false?: string }
}

/** The question map of one Jev request, keyed by answer name. */
export type JevQuestions = Record<string, NoulQuestion>

/** The answer of one `noul` question. */
export interface NoulAnswer {
  readonly type?: 'noul'
  readonly noul: number
}

/** A Jev response body. */
export interface JevResponse {
  readonly model?: string
  readonly answers: Record<string, NoulAnswer>
  readonly usage?: { input_tokens?: number; output_tokens?: number }
  readonly [key: string]: unknown
}

/** The `state` of a Jev request: any JSON-serialisable object. */
export type JevState = object

/** Anything that can answer Jev questions: {@link JevClient}, or a test double. */
export interface JevAsker {
  ask(state: JevState, questions: JevQuestions, signal?: AbortSignal): Promise<JevResponse>
}

/** The paired shape one candidate call needs to build its questions. */
export interface QuestionCall {
  /** Stable 1-based region order (`t1`, `t2`, …). */
  readonly index: number
  /** Tool name. */
  readonly name: string
  /** The paired result, when present in the region. */
  readonly result?: { readonly chars: number }
}

/**
 * The two `noul` questions asked about one call, ported verbatim from
 * fast-jev-compaction's `questionsFor`: should the call stay, and should its
 * full result stay verbatim.
 * @param call - the candidate call.
 * @returns the question map for this call.
 */
export function questionsFor(call: QuestionCall): JevQuestions {
  const resultChars = call.result?.chars ?? 0
  return {
    [`call_t${call.index}`]: {
      type: 'noul',
      instructions: `Tool call t${call.index} (${call.name}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
    },
    [`result_t${call.index}`]: {
      type: 'noul',
      instructions: `The full output of tool call t${call.index} (${call.name}, ${resultChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
    },
  }
}

/** Options of {@link JevClient}. */
export interface JevClientOptions {
  /** TypeSafe API key; defaults to `process.env.TYPESAFE_API_KEY`. */
  readonly apiKey?: string
  /** Model name; defaults to `jev-latest`. */
  readonly model?: string
  /** Endpoint; defaults to the System One URL. */
  readonly baseUrl?: string
  /** Injectable fetch implementation for tests. */
  readonly fetch?: typeof fetch
}

/** One built HTTP request, for any fetch-like transport. */
export interface JevRequest {
  readonly url: string
  readonly method: 'POST'
  readonly headers: Record<string, string>
  readonly body: string
}

/**
 * Build the HTTP request for one Jev call, ported verbatim from
 * fast-jev-compaction so the wire format stays identical.
 * @param params - apiKey, model, baseUrl.
 * @param state - the fitted conversation state.
 * @param questions - the batch's questions.
 * @returns the request for a fetch-like transport.
 */
export function buildJevRequest(
  params: { apiKey: string; model?: string; baseUrl?: string },
  state: JevState,
  questions: JevQuestions,
): JevRequest {
  return {
    url: params.baseUrl ?? SYSTEM_ONE_URL,
    method: 'POST',
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: params.model ?? DEFAULT_MODEL,
      state,
      questions,
    }),
  }
}

/**
 * Validate a Jev response body; throws on anything but an `answers` object.
 * @param status - HTTP status.
 * @param ok - whether the transport considered the response successful.
 * @param text - the response body text.
 * @returns the validated response.
 */
export function parseJevResponse(status: number, ok: boolean, text: string): JevResponse {
  if (!ok) {
    throw new Error(`Jev request failed (${status}): ${text.slice(0, 200)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Jev returned malformed JSON')
  }
  if (
    parsed === null
    || typeof parsed !== 'object'
    || !('answers' in parsed)
    || (parsed as Record<string, unknown>).answers === null
    || typeof (parsed as Record<string, unknown>).answers !== 'object'
  ) {
    throw new Error('Jev response is missing answers')
  }
  return parsed as JevResponse
}

/**
 * The `noul` probability of one answer; throws when it is not there.
 * @param answers - the response's answer map.
 * @param name - the question name.
 * @returns the probability in [0, 1] as Jev reported it.
 */
export function noulAnswer(answers: Record<string, NoulAnswer>, name: string): number {
  const answer = answers[name]
  if (
    answer === undefined || answer === null
    || !('noul' in answer)
    || typeof answer.noul !== 'number'
    || !Number.isFinite(answer.noul)
  ) {
    throw new Error(`Invalid Jev answer for ${name}`)
  }
  return answer.noul
}

/** Asks Jev over HTTP with the global `fetch` (or an injected one). */
export class JevClient implements JevAsker {
  private readonly apiKey: string
  private readonly model: string | undefined
  private readonly baseUrl: string | undefined
  private readonly fetcher: typeof fetch

  constructor(options: JevClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY ?? ''
    this.model = options.model
    this.baseUrl = options.baseUrl
    this.fetcher = options.fetch ?? fetch
  }

  /** Whether the client can ask at all (a key is configured). */
  get configured(): boolean {
    return this.apiKey.length > 0
  }

  async ask(state: JevState, questions: JevQuestions, signal?: AbortSignal): Promise<JevResponse> {
    if (!this.configured) throw new Error('TYPESAFE_API_KEY is not configured')
    const request = buildJevRequest(
      { apiKey: this.apiKey, model: this.model, baseUrl: this.baseUrl },
      state,
      questions,
    )
    const response = await this.fetcher(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      ...signal === undefined ? {} : { signal },
    })
    return parseJevResponse(response.status, response.ok, await response.text())
  }
}
