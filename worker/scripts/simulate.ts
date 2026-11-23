// The record simulator: made-up record streams, as the site keeps them, of
// honest work and of the scripts the review flags look for. The tests in
// test/timeline.test.ts use it; run alone, it measures how often each flag in
// src/timeline.ts fires on honest streams and checks that each script trips
// the flag meant for it.
//
//   node scripts/simulate.ts               # 200 honest streams of 5 days each
//   node scripts/simulate.ts --seeds 1000 --days 10
//
// Honest streams follow a simple model of a person working with an agent,
// not real records, so a flag that stays quiet here can still fire on real
// people. Before relying on a flag, run it over real records too.
import { parseArgs } from 'node:util'
import { flags, type Rec } from '../src/timeline.ts'

export type Record = Rec & { event: string }

/** rng is a small seeded generator (mulberry32), so a stream is the same every run. */
export function rng(seed: number) {
	let a = seed >>> 0
	const next = () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
	return {
		next,
		between: (lo: number, hi: number) => lo + next() * (hi - lo),
		/** A log-normal draw with this median, spread by sigma: most short, some long. */
		lognormal: (median: number, sigma: number) => median * Math.exp(sigma * Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next())),
	}
}

const START = Date.parse('2026-11-02T00:00:00Z')
const prompt = (t: number, session: string): Record => ({ t, arrived: t + 800, tool: 'claude-code', session, project: 'github.com/kid/app', human: true, event: 'UserPromptSubmit', judged: 8, real: 8 })
const reply = (t: number, session: string): Record => ({ t, arrived: t + 800, tool: 'claude-code', session, project: 'github.com/kid/app', human: false, event: 'Stop', in: 12000, out: 600 })

/**
 * honest is days of a person's work: on each day one to four sessions, from
 * a morning start, with breaks between them. In a session, the agent answers
 * each prompt after a while; the person reads and writes the next one, now
 * and then at once ("yes, go on"), and now and then interrupts the agent with
 * another prompt before it answers.
 */
export function honest(seed: number, days = 5): Record[] {
	const r = rng(seed)
	const out: Record[] = []
	for (let d = 0; d < days; d++) {
		if (r.next() < 0.25) continue // a day off
		let t = START + d * 86400_000 + r.between(8, 11) * 3600_000
		const sessions = 1 + Math.floor(r.next() * 4)
		for (let s = 0; s < sessions; s++) {
			const session = `s${seed}-${d}-${s}`
			const turns = 5 + Math.floor(r.next() * 50)
			for (let i = 0; i < turns; i++) {
				out.push(prompt(t, session))
				if (r.next() < 0.07) {
					// Interrupted: the next prompt comes before any answer.
					t += r.between(5, 60) * 1000
					continue
				}
				t += Math.min(r.lognormal(40_000, 0.9), 15 * 60_000)
				out.push(reply(t, session))
				t += r.next() < 0.12 ? r.between(3, 15) * 1000 : Math.min(r.lognormal(90_000, 0.9), 40 * 60_000)
			}
			t += r.between(0.3, 2.5) * 3600_000
		}
	}
	return out
}

type Rand = ReturnType<typeof rng>

/** The scripts the flags look for, by the flag each should trip. */
export const SCRIPTS = {
	/** A prompt every minute on the dot: 20 seconds' answer, 40 seconds' pause. */
	'steady-gaps': (seed: number) => turns(seed, 200, () => 40_000),
	/** A prompt every two minutes, give or take 20%. */
	'even-gaps': (seed: number) => turns(seed, 200, (r) => r.between(76_000, 124_000)),
	/** A prompt within seconds of most replies, before anyone could read them. */
	'quick-replies': (seed: number) => turns(seed, 200, (r) => (r.next() < 0.6 ? r.between(1000, 8000) : r.lognormal(60_000, 0.8))),
	/** A third of the prompts never answered. */
	unanswered: (seed: number) => turns(seed, 200, (r) => r.lognormal(90_000, 0.8), { unanswered: 0.35 }),
	/** Eighteen hours of turns, with a 20-minute rest every 90 minutes and never a 2-hour break. */
	'no-break': (seed: number) => turns(seed, 1000, (r) => r.lognormal(30_000, 0.6), { rest: 90 * 60_000, until: 18 * 3600_000 }),
	/** Two long sessions in one day, 15 hours credited around a 2.5-hour break. */
	'rolling-day': (seed: number) => [
		...turns(seed, 1000, (r) => r.lognormal(30_000, 0.6), { until: 7.5 * 3600_000 }),
		...turns(seed + 1, 1000, (r) => r.lognormal(30_000, 0.6), { until: 7.5 * 3600_000, offset: 10 * 3600_000 }),
	],
} satisfies { [K in string]: (seed: number) => Record[] }

/**
 * turns is one session of up to n turns, from 9:00 plus offset, for at most
 * `until`: each prompt is answered 20 seconds later, unless it goes
 * unanswered, and the next prompt comes pause() after that. With rest, a
 * 20-minute rest follows every `rest` of work.
 */
function turns(seed: number, n: number, pause: (r: Rand) => number, o: { unanswered?: number; rest?: number; until?: number; offset?: number } = {}): Record[] {
	const r = rng(seed)
	const session = `script-${seed}-${o.offset ?? 0}`
	const out: Record[] = []
	const start = START + 9 * 3600_000 + (o.offset ?? 0)
	let t = start, since = start
	for (let i = 0; i < n && t - start < (o.until ?? Infinity); i++) {
		out.push(prompt(t, session))
		if (r.next() >= (o.unanswered ?? 0)) {
			t += 20_000
			out.push(reply(t, session))
		}
		t += pause(r)
		if (o.rest && t - since > o.rest) (t += 20 * 60_000), (since = t)
	}
	return out
}

/** calibrate counts, per flag, the honest streams it fires on, and which flags each script trips. */
export function calibrate(seeds: number, days: number) {
	const honestHits: { [kind: string]: number } = {}
	for (let s = 1; s <= seeds; s++) for (const f of flags(honest(s, days), [])) honestHits[f.kind] = (honestHits[f.kind] ?? 0) + 1
	const scripts = Object.fromEntries(Object.entries(SCRIPTS).map(([want, make]) => [want, flags(make(7), []).map((f) => f.kind)]))
	return { honestHits, scripts }
}

if (import.meta.main) {
	const { values: opt } = parseArgs({ options: { seeds: { type: 'string', default: '200' }, days: { type: 'string', default: '5' } } })
	const seeds = Number(opt.seeds), days = Number(opt.days)
	const { honestHits, scripts } = calibrate(seeds, days)
	console.log(`Honest streams: ${seeds} of ${days} days each.`)
	const kinds = Object.keys(honestHits)
	console.log(kinds.length ? kinds.map((k) => `  ${k}: fired on ${honestHits[k]} (${((honestHits[k]! / seeds) * 100).toFixed(1)}%)`).join('\n') : '  No flag fired.')
	let missed = 0
	console.log('Scripts:')
	for (const [want, got] of Object.entries(scripts)) {
		const ok = got.includes(want as never)
		if (!ok) missed++
		console.log(`  ${ok ? 'ok    ' : 'MISSED'} ${want}: ${got.join(', ') || 'no flags'}`)
	}
	process.exit(missed || kinds.length ? 1 : 0)
}
