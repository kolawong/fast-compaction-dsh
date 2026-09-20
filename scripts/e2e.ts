/**
 * Live end-to-end check: run FastCompactionEngine's verdict path against the
 * real TypeSafe System One endpoint with a synthetic region, and print what
 * the engine returns. Requires TYPESAFE_API_KEY in the environment.
 *
 *   TYPESAFE_API_KEY=tsk-... node scripts/e2e.ts
 */
import { Context } from '@deepseek-ai/cordis'
import {
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { FastCompactionEngine } from '../src/index.ts'

if ((process.env.TYPESAFE_API_KEY ?? '').length === 0) {
  console.error('TYPESAFE_API_KEY is not set')
  process.exit(1)
}

const user = (text: string): Message => createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

const assistant = (text: string, calls: Array<{ id: string; name: string; args: string }> = []): Message => (
  createAssistantMessage({
    content: [
      ...(text.length === 0 ? [] : [{ type: 'text' as const, text }]),
      ...calls.map(call => ({
        type: 'tool-call' as const,
        id: ToolCallId(call.id),
        name: call.name,
        arguments: call.args,
      })),
    ],
    source: { provider: 'deepseek', model: 'deepseek-chat' },
  })
)

const result = (id: string, text: string): Message => createToolResultMessage({
  callId: ToolCallId(id),
  content: [{ type: 'text', text }],
  isError: false,
})

const bigFile = Array.from({ length: 60 }, (_, i) => `line ${i + 1}: const value${i} = compute(${i}); // src/math.ts content`).join('\n')
const bigTestOutput = Array.from({ length: 50 }, (_, i) => `  ✓ case ${i + 1} passed (12ms)`).join('\n') + '\n  ✗ case 51 failed: add is not defined\n  1 failing, 50 passing\n'

const messages: Message[] = [
  createSystemMessage('You are a coding agent.', 'test'),
  user('Fix the failing test in src/math.test.ts. Never edit src/generated.'),
  assistant('Let me read the source file first.', [
    { id: 'call_read', name: 'read', args: '{"file_path":"src/math.ts"}' },
  ]),
  result('call_read', bigFile),
  assistant('Now running the test suite to see the failure.', [
    { id: 'call_test', name: 'bash', args: '{"command":"pnpm vitest run src/math.test.ts"}' },
    { id: 'call_ls', name: 'bash', args: '{"command":"ls src/generated"}' },
  ]),
  result('call_test', bigTestOutput),
  result('call_ls', 'index.ts\nhelpers.ts\napi.ts\n'),
  user('The error says add is not defined.'),
]

const ctx = new Context()
const engine = new FastCompactionEngine(ctx, { preserveRecentMessages: 1 })
const agent = { session: { requestHeader: () => undefined, id: 'e2e' }, options: {} } as unknown as Agent

const started = Date.now()
// summarize is protected at the type level; runtime access is intentional here.
const summary = await engine.summarize({ messages }, agent)
console.log(`\n=== result (${Date.now() - started}ms) ===`)
console.log('provider:', summary.provider, '| model:', summary.model, '| llmStreamCall:', summary.llmStreamCall)
console.log('usage:', summary.usage)
console.log('\n=== replacement transcript ===')
for (const block of summary.summary) {
  if (block.type === 'text') console.log(block.text)
}
