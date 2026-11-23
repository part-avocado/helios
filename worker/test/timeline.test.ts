// The Worker's crediting rules run the same cases as internal/timeline in Go.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { honest, SCRIPTS } from '../scripts/simulate.ts'
import { credit, flags, type Rec, union } from '../src/timeline.ts'

const cases = JSON.parse(readFileSync(new URL('../../internal/timeline/testdata/credit.json', import.meta.url), 'utf8')) as { name: string; events: [number, string][]; engaged: number }[]

test('the shared crediting cases give the same engaged time as in Go', () => {
	for (const c of cases) {
		const recs: Rec[] = c.events.map(([s, k]) => ({ t: s * 1000, arrived: s * 1000, tool: 'x', session: 's', project: 'p', human: k === 'h' }))
		const { witnessed, unwitnessed } = union(credit(recs))
		assert.deepEqual([witnessed / 1000, unwitnessed], [c.engaged, 0], c.name)
	}
})

test('a stretch is witnessed only when both of its records arrived on time', () => {
	const late = (t: number, human: boolean, arrived = t): Rec => ({ t, arrived, tool: 'x', session: 's', project: 'p', human })
	const { witnessed, unwitnessed } = union(credit([late(0, true), late(60_000, false, 3600_000), late(120_000, true)]))
	assert.deepEqual([witnessed, unwitnessed], [0, 120_000])
})

test('flags: what live fakery leaves behind', async () => {
	const t0 = Date.parse('2026-11-20T10:00:00Z')
	const rec = (t: number, human: boolean, extra: object = {}) => ({ t, arrived: t, tool: 'amp', session: 's', project: 'p', human, computer: 'td-1', event: human ? 'agent.start' : 'agent.end', ...extra })
	// Ordinary: uneven gaps, answered turns with tokens, a normal day.
	const gaps = [70, 200, 45, 310, 90, 130, 260, 55, 180, 75, 400]
	const ordinary = gaps.flatMap((g, i) => {
		const t = t0 + gaps.slice(0, i).reduce((n, x) => n + x, 0) * 1000
		return [rec(t, true), rec(t + 30_000, false, { in: 100, out: 10 })]
	})
	assert.deepEqual(flags(ordinary, [{ day: '2026-11-20', witnessed_seconds: 4 * 3600 }]), [])
	// A script: prompts every 60 seconds exactly, never answered, on a 17-hour day.
	const script = Array.from({ length: 12 }, (_, i) => rec(t0 + i * 60_000, true))
	assert.deepEqual(flags(script, [{ day: '2026-11-20', witnessed_seconds: 17 * 3600 }]).map((f) => f.kind), ['long-day', 'steady-gaps', 'no-turn-ends'])
	const tokenless = [rec(t0, true), rec(t0 + 1, false), rec(t0 + 2, false), rec(t0 + 3, false)]
	assert.deepEqual(flags(tokenless, []).map((f) => f.kind), ['no-tokens'])
	assert.deepEqual(flags([{ ...ordinary[0]!, clamped: true }], []).map((f) => f.kind), ['clamped'])
})

test('flags: each scripted stream trips its flag, and honest streams trip none', () => {
	for (const [kind, make] of Object.entries(SCRIPTS)) {
		for (const seed of [1, 2, 3]) assert.ok(flags(make(seed), []).some((f) => f.kind === kind), `${kind}, seed ${seed}`)
	}
	for (let seed = 1; seed <= 100; seed++) assert.deepEqual(flags(honest(seed, 7), []), [], `honest, seed ${seed}`)
	// A script trips what it is, not every flag: a jittered one is not called unanswered or a marathon.
	assert.deepEqual(flags(SCRIPTS['even-gaps'](1), []).map((f) => f.kind), ['even-gaps'])
	assert.deepEqual(flags(SCRIPTS.unanswered(1), []).map((f) => f.kind), ['unanswered'])
	assert.deepEqual(flags(SCRIPTS['rolling-day'](1), []).map((f) => f.kind), ['rolling-day'])
})

test('flags: the new thresholds, on both sides', () => {
	const t0 = Date.parse('2026-11-20T10:00:00Z')
	const rec = (t: number, human: boolean) => ({ t, arrived: t, tool: 'x', session: 's', project: 'p', human, event: human ? 'prompt' : 'turn_end' })
	// Steady prompt gaps are flagged too; these cases are about the others.
	const kinds = (recs: ReturnType<typeof rec>[]) => flags(recs, []).map((f) => f.kind).filter((k) => k !== 'even-gaps' && k !== 'steady-gaps')

	// 30 turns, each answered after 20 seconds: 9 sent within 15 seconds of the reply (30%) is not over the line; 10 is.
	const quick = (n: number) => {
		const out = [rec(t0, true)]
		let t = t0
		for (let i = 0; i < 30; i++) {
			out.push(rec((t += 20_000), false))
			out.push(rec((t += i < n ? 10_000 : 100_000 + i * 7_000), true))
		}
		return out
	}
	assert.deepEqual(kinds(quick(9)), [])
	assert.deepEqual(kinds(quick(10)), ['quick-replies'])

	// 20 prompts: 5 followed by another prompt before any answer (25%) is not over the line; 6 is.
	const answered = (skip: number) => Array.from({ length: 20 }, (_, i) => [rec(t0 + i * 300_000, true), ...(i < skip ? [] : [rec(t0 + i * 300_000 + 60_000, false)])]).flat()
	assert.deepEqual(kinds(answered(5)), [])
	assert.deepEqual(kinds(answered(6)), ['unanswered'])

	// A prompt every 30 minutes for 16 hours is not a marathon; a minute more is, unless a 2-hour break splits it.
	const every30 = (extra: number, breakAfter = Infinity) => [...Array.from({ length: 33 }, (_, i) => t0 + i * 1800_000), t0 + 16 * 3600_000 + extra].map((t, i) => rec(t + (i > breakAfter ? 2 * 3600_000 : 0), true))
	assert.ok(!kinds(every30(0)).includes('no-break'))
	assert.ok(kinds(every30(60_000)).includes('no-break'))
	assert.ok(!kinds(every30(60_000, 10)).includes('no-break'))
})
