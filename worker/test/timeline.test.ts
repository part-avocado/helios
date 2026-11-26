// The Worker's crediting rules run the same cases as internal/timeline in Go.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { honest, SCRIPTS } from '../scripts/simulate.ts'
import { credit, flags, nextClock, nextOffset, type OffsetPin, splitProjects, capDay, DAY_CAP, type Rec, RULES, union } from '../src/timeline.ts'

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

test('nextClock: a computer starts at 0, and only a reading that holds a day moves its pin, its first one too', () => {
	const M = 60_000, D = 86400_000
	// A new computer ID gets no correction from its first batch: the reading waits a day like any other.
	assert.deepEqual(nextClock(null, 20 * M + 400, 0), { pin: 0, cand: 20 * M, since: 0 })
	assert.deepEqual(nextClock(null, 30_000, 0), { pin: 0 }, 'within a minute of 0 agrees')
	assert.equal(nextClock(null, 2 * 3600_000, 0), null, 'over an hour off is not corrected')
	assert.equal(nextClock(null, null, 0), null)
	const pinned = { pin: 20 * M }
	assert.deepEqual(nextClock(pinned, 20 * M + 50_000, 0), pinned, 'within a minute agrees')
	assert.deepEqual(nextClock(pinned, 7 * 24 * 60 * M, 0), pinned, 'a week-old sent time is ignored')
	// A different reading waits: it moves the pin only once it has held for a day.
	const waiting = nextClock(pinned, 50 * M, 1000)!
	assert.deepEqual(waiting, { pin: 20 * M, cand: 50 * M, since: 1000 })
	assert.deepEqual(nextClock(waiting, 50 * M + 30_000, 1000 + D - 1), waiting)
	assert.deepEqual(nextClock(waiting, 50 * M, 1000 + D), { pin: 50 * M })
	// One that changes again starts its wait over.
	assert.deepEqual(nextClock(waiting, 35 * M, 1000 + D), { pin: 20 * M, cand: 35 * M, since: 1000 + D })
})

test('witnessing corrects a record by its pin, but by 5 minutes at most', () => {
	const M = 60_000
	const at = (t: number, late: number, human: boolean, skew?: number): Rec => ({ t, arrived: t + late, tool: 'x', session: 's', project: 'p', human, ...(skew ? { skew } : {}) })
	const stretch = (late: number, skew?: number) => union(credit([at(0, late, true, skew), at(30_000, late, false, skew), at(60_000, late, true, skew)])).witnessed
	// 8 minutes late: unwitnessed as claimed, witnessed once a 4-minute pin corrects it.
	assert.equal(stretch(8 * M), 0)
	assert.equal(stretch(8 * M, 4 * M), 60_000)
	// A pin of 20 minutes moves it 5 at most: 11 minutes late stays unwitnessed, 10 is on time.
	assert.equal(stretch(11 * M, 20 * M), 0)
	assert.equal(stretch(10 * M, 20 * M), 60_000)
})

test('nextOffset: the calendar moves only when the pinned offset stops being sent and a new one holds', () => {
	const D = 86_400_000
	assert.deepEqual(nextOffset(null, 540, 0), { pin: 540, seen: 0 })
	assert.deepEqual(nextOffset({ pin: 540, seen: 0 }, 840, 0), { pin: 540, seen: 0, cand: 840, since: 0 })
	// A second computer, or flipping between two offsets, keeps the pin however long it goes on.
	let s: OffsetPin = { pin: 540, seen: 0 }
	for (let d = 0; d < 10; d++) s = nextOffset(nextOffset(s, 840, d * D), 540, d * D + 1000)
	assert.equal(s.pin, 540)
	// Travel: the old offset goes quiet, the new one holds.
	const away = nextOffset({ pin: 540, seen: 0, cand: 840, since: D }, 840, 3 * D)
	assert.equal(away.pin, 540, 'not yet: three days since the pin was last sent, but the new offset only two days old')
	assert.deepEqual(nextOffset({ pin: 540, seen: 0, cand: 840, since: 0 }, 840, 3 * D), { pin: 840, seen: 3 * D })
})

test('splitProjects: time on two projects at once is shared, and the projects add up to the whole', () => {
	const m = (n: number) => n * 60_000
	const split = splitProjects(new Map([
		['a', [{ start: 0, end: m(10), witnessed: true }]],
		['b', [{ start: m(5), end: m(15), witnessed: true }]],
	]))
	assert.deepEqual(split.get('a'), { witnessed: m(7.5), unwitnessed: 0 })
	assert.deepEqual(split.get('b'), { witnessed: m(7.5), unwitnessed: 0 })
	// One after the other, each keeps its own.
	const apart = splitProjects(new Map([
		['a', [{ start: 0, end: m(10), witnessed: true }]],
		['b', [{ start: m(10), end: m(20), witnessed: false }]],
	]))
	assert.deepEqual([apart.get('a'), apart.get('b')], [{ witnessed: m(10), unwitnessed: 0 }, { witnessed: 0, unwitnessed: m(10) }])
})

test('capDay: a day is credited at most 16 hours, cutting unwitnessed time first, and projects keep adding up', () => {
	const H = 3600_000
	const t = { witnessed: 12 * H, unwitnessed: 8 * H, prompts: 0, tokens_in: 0, tokens_out: 0, lines_added: 0, lines_removed: 0, projects: { a: { witnessed: 12 * H, unwitnessed: 8 * H, prompts: 0 } } }
	capDay(t, 24 * H)
	assert.deepEqual([t.witnessed, t.unwitnessed, t.projects.a!.witnessed, t.projects.a!.unwitnessed], [12 * H, 4 * H, 12 * H, 4 * H])
	assert.equal(t.witnessed + t.unwitnessed, DAY_CAP)
})

test('nextOffset: a stale candidate is dropped when the pin is sent again, so one batch after a break moves nothing', () => {
	const D = 86_400_000
	let s: OffsetPin = nextOffset({ pin: 540, seen: 0 }, 0, 0)
	for (let d = 1; d <= 30; d++) s = nextOffset(s, 540, d * D)
	assert.equal(nextOffset(s, 0, 34 * D).pin, 540)
})

test('capDay keeps what a cut day held, and a cut day is flagged as a long one', () => {
	const H = 3600_000
	const whole = () => ({ witnessed: 3 * H, unwitnessed: 15 * H, prompts: 0, tokens_in: 0, tokens_out: 0, lines_added: 0, lines_removed: 0, projects: {} })
	assert.equal(capDay(whole(), 24 * H).uncapped, 18 * H)
	assert.equal(capDay({ ...whole(), unwitnessed: 13 * H }, 24 * H).uncapped, undefined, 'a day at the cap is not cut')
	// Witnessed time alone can't pass 16 hours any more, so the flag also reads what the day's records held.
	const cut = flags([], [{ day: '2026-11-20', witnessed_seconds: 3 * 3600, uncapped_seconds: 18 * 3600 }, { day: '2026-11-21', witnessed_seconds: 16 * 3600 }, { day: '2026-11-22', witnessed_seconds: 15 * 3600, uncapped_seconds: null }])
	assert.deepEqual(cut.map((f) => f.kind), ['long-day'])
	assert.match(cut[0]!.text, /on 2026-11-20 \(its records held 18 hours\), 2026-11-21\.$/)
	assert.equal(RULES, 3)
})

test('an interrupted turn earns its gap as watching, up to 3 minutes, and silent prompts can\'t be padded', () => {
	const rec = (s: number, human: boolean, extra: Partial<Rec> = {}): Rec => ({ t: s * 1000, arrived: s * 1000, tool: 'x', session: 's', project: 'p', human, ...extra })
	const earned = (recs: Rec[]) => union(credit(recs)).witnessed / 1000
	assert.equal(earned([rec(0, true), rec(40, true)]), 40)
	assert.equal(earned([rec(0, true), rec(3600, true)]), 180)
	// Real prompts every 5 minutes for an hour with no agent output: 60%, well under 90%.
	assert.equal(earned(Array.from({ length: 13 }, (_, i) => rec(i * 300, true))), 36 * 60)
	// A gibberish prompt in the middle counts as agent output: the watch window once, and no compose time after it.
	const noise = { judged: 10, real: 0, sim: '12345' }
	assert.equal(earned([rec(0, true), rec(299, true, noise), rec(300, true), rec(599, true, noise), rec(600, true)]), 2 * 240 - 1)
	// A first prompt after a skipped one earns nothing.
	assert.equal(earned([rec(0, true, noise), rec(100, true)]), 0)
})
