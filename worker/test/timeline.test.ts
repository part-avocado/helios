// The Worker's crediting rules run the same cases as internal/timeline in Go.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { credit, type Rec, union } from '../src/timeline.ts'

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
