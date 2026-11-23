// The Worker's crediting rules run the same cases as internal/timeline in Go.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
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
