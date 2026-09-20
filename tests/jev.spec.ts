import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MODEL,
  JevClient,
  SYSTEM_ONE_URL,
  buildJevRequest,
  noulAnswer,
  parseJevResponse,
  questionsFor,
} from '../src/jev.ts'

describe('questionsFor', () => {
  it('asks the two noul questions with fast-jev wording', () => {
    const questions = questionsFor({ index: 3, name: 'bash', result: { chars: 4213 } })
    expect(Object.keys(questions)).toEqual(['call_t3', 'result_t3'])
    expect(questions['call_t3']).toEqual({
      type: 'noul',
      instructions: 'Tool call t3 (bash) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next',
    })
    expect(questions['result_t3']).toEqual({
      type: 'noul',
      instructions: 'The full output of tool call t3 (bash, 4213 chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do',
    })
  })
})

describe('buildJevRequest', () => {
  it('posts the model, state, and questions to System One', () => {
    const request = buildJevRequest(
      { apiKey: 'tsk-test' },
      { context: 'ctx', goal: 'g', history: [] },
      questionsFor({ index: 1, name: 'bash', result: { chars: 10 } }),
    )
    expect(request.url).toBe(SYSTEM_ONE_URL)
    expect(request.method).toBe('POST')
    expect(request.headers['authorization']).toBe('Bearer tsk-test')
    expect(request.headers['content-type']).toBe('application/json')
    const body = JSON.parse(request.body) as Record<string, unknown>
    expect(body.model).toBe(DEFAULT_MODEL)
    expect(body.state).toEqual({ context: 'ctx', goal: 'g', history: [] })
    expect(Object.keys(body.questions as Record<string, unknown>)).toEqual(['call_t1', 'result_t1'])
  })

  it('honors model and baseUrl overrides', () => {
    const request = buildJevRequest(
      { apiKey: 'k', model: 'jev-2', baseUrl: 'https://example.test/jev' },
      {},
      {},
    )
    expect(request.url).toBe('https://example.test/jev')
    expect((JSON.parse(request.body) as Record<string, unknown>).model).toBe('jev-2')
  })
})

describe('parseJevResponse', () => {
  it('accepts an answers object', () => {
    const response = parseJevResponse(200, true, '{"answers":{"call_t1":{"noul":0.8}}}')
    expect(response.answers['call_t1']?.noul).toBe(0.8)
  })

  it('throws on a non-2xx status', () => {
    expect(() => parseJevResponse(401, false, 'denied')).toThrow(/Jev request failed \(401\)/)
  })

  it('throws on malformed JSON', () => {
    expect(() => parseJevResponse(200, true, 'not json')).toThrow(/malformed JSON/)
  })

  it('throws when answers are missing', () => {
    expect(() => parseJevResponse(200, true, '{"model":"jev-latest"}')).toThrow(/missing answers/)
  })
})

describe('noulAnswer', () => {
  it('returns the probability', () => {
    expect(noulAnswer({ a: { noul: 0.25 } }, 'a')).toBe(0.25)
  })

  it('throws when the answer is missing or malformed', () => {
    expect(() => noulAnswer({}, 'a')).toThrow(/Invalid Jev answer/)
    expect(() => noulAnswer({ a: { noul: 'high' } as unknown as { noul: number } }, 'a')).toThrow(/Invalid Jev answer/)
  })
})

describe('JevClient', () => {
  it('refuses to ask without a key', async () => {
    const client = new JevClient({ apiKey: '' })
    await expect(client.ask({}, {})).rejects.toThrow(/TYPESAFE_API_KEY is not configured/)
  })

  it('asks through the injected fetch', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const client = new JevClient({
      apiKey: 'tsk-test',
      model: 'jev-test',
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return new Response('{"answers":{"call_t1":{"noul":1}}}', { status: 200 })
      }) as typeof fetch,
    })
    const response = await client.ask({ context: 'c' }, questionsFor({ index: 1, name: 'bash', result: { chars: 5 } }))
    expect(response.answers['call_t1']?.noul).toBe(1)
    expect(calls.length).toBe(1)
    expect(calls[0]!.url).toBe(SYSTEM_ONE_URL)
    expect((calls[0]!.init.headers as Record<string, string>)['authorization']).toBe('Bearer tsk-test')
    expect(JSON.parse(calls[0]!.init.body as string).model).toBe('jev-test')
  })
})
