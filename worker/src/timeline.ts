// The rules that turn prompt records into engaged time, ported from
// internal/timeline/timeline.go and cmd/teardrop/struggle.go. The Go and
// TypeScript versions run the same cases (internal/timeline/testdata/credit.json),
// so they can't drift apart unnoticed.
//
// Time between two records of a session is credited like this: before a
// prompt, the last COMPOSE of the gap (reading the reply, writing the prompt);
// before agent output, the gap while it lies within WATCH of the last prompt.
// Here each credited stretch is also marked witnessed when the site received
// the records at both of its ends within WITNESS of the time they claim.

/** The version of these rules, stamped on what they compute. */
export const RULES = 1
export const COMPOSE = 5 * 60_000
export const WATCH = 10 * 60_000
/** A record that reaches the site within this long of the time it claims was witnessed. */
export const WITNESS = 5 * 60_000

/** How a record counts. Noise, repeat, and autopilot prompts earn nothing and count as agent activity. */
export type Kind = 'agent' | 'human' | 'noise' | 'repeat' | 'autopilot'

/** One record, as the hub keeps it. Times are Unix milliseconds. */
export interface Rec {
	t: number
	/** When the site received it. */
	arrived: number
	tool: string
	session: string
	project: string
	human: boolean
	judged?: number
	real?: number
	/** The prompt's fingerprint, a 64-bit number as decimal text, so it is never rounded. */
	sim?: string
	low?: boolean
	in?: number
	out?: number
	added?: number
	removed?: number
}

export interface Stretch {
	start: number
	end: number
	witnessed: boolean
}

const witnessed = (r: Rec) => r.arrived - r.t <= WITNESS

/** similar says whether two fingerprints are near-repeats: at most 10 of their 64 bits differ. */
export function similar(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b || a === '0' || b === '0') return false
	let x = BigInt(a) ^ BigInt(b)
	let n = 0
	while (x) {
		n += Number(x & 1n)
		x >>= 1n
	}
	return n <= 10
}

/** The repeats of a request, or low-effort prompts in a row, that still count. */
const FREE_PASSES = 2
const REPEAT_WINDOW = 5
const NOISE = 0.5

/**
 * kinds classifies one session's records, in time order: gibberish, the third
 * or later near-repeat of a request, and the third or later low-effort prompt
 * in a row earn nothing.
 */
export function kinds(recs: Rec[]): Kind[] {
	const recent: string[] = []
	let lowRun = 0
	return recs.map((r) => {
		if (!r.human) return 'agent'
		if (!r.sim || r.sim === '0') {
			lowRun = 0
			return 'human'
		}
		let k: Kind = 'human'
		if (r.judged && (r.judged - (r.real ?? 0)) / r.judged > NOISE) k = 'noise'
		else if (r.low) {
			if (++lowRun > FREE_PASSES) k = 'autopilot'
		} else {
			lowRun = 0
			if (recent.filter((h) => similar(h, r.sim)).length >= FREE_PASSES) k = 'repeat'
		}
		recent.push(r.sim)
		if (recent.length > REPEAT_WINDOW) recent.shift()
		return k
	})
}

/** credit returns the stretches of one session in which the person was plausibly engaged. */
export function credit(recs: Rec[]): Stretch[] {
	const ev = [...recs].sort((a, b) => a.t - b.t)
	const k = kinds(ev)
	const out: Stretch[] = []
	let lastHuman = -1
	for (let i = 0; i < ev.length; i++) {
		if (i > 0) {
			const prev = ev[i - 1]!.t
			let start = 0, end = 0
			if (k[i] === 'human') (start = Math.max(prev, ev[i]!.t - COMPOSE)), (end = ev[i]!.t)
			else if (lastHuman >= 0) (start = prev), (end = Math.min(ev[i]!.t, ev[lastHuman]!.t + WATCH))
			if (end > start) out.push({ start, end, witnessed: witnessed(ev[i - 1]!) && witnessed(ev[i]!) })
		}
		if (k[i] === 'human') lastHuman = i
	}
	return out
}

/**
 * union merges stretches, with witnessed time winning where they overlap, and
 * returns witnessed and unwitnessed milliseconds and the merged witnessed list.
 */
export function union(stretches: Stretch[]): { witnessed: number; unwitnessed: number } {
	const merge = (list: Stretch[]) => {
		const s = [...list].sort((a, b) => a.start - b.start)
		const out: { start: number; end: number }[] = []
		for (const x of s) {
			const last = out.at(-1)
			if (last && x.start <= last.end) last.end = Math.max(last.end, x.end)
			else out.push({ start: x.start, end: x.end })
		}
		return out
	}
	const total = (l: { start: number; end: number }[]) => l.reduce((n, x) => n + x.end - x.start, 0)
	const all = total(merge(stretches))
	const seen = total(merge(stretches.filter((s) => s.witnessed)))
	return { witnessed: seen, unwitnessed: all - seen }
}

/** Totals for one stretch of time: witnessed and unwitnessed milliseconds, prompts, tokens, and lines, per project too. */
export interface Totals {
	witnessed: number
	unwitnessed: number
	prompts: number
	tokens_in: number
	tokens_out: number
	lines_added: number
	lines_removed: number
	projects: Record<string, { witnessed: number; unwitnessed: number; prompts: number }>
}

/**
 * totals credits records by session, clips the stretches to [from, to), and
 * adds them up. Time on two projects or tools at once counts once in the
 * total and once in each project.
 */
export function totals(recs: Rec[], from: number, to: number): Totals {
	const sessions = new Map<string, Rec[]>()
	for (const r of recs) {
		const key = `${r.tool}\0${r.session}`
		sessions.set(key, [...(sessions.get(key) ?? []), r])
	}
	const t: Totals = { witnessed: 0, unwitnessed: 0, prompts: 0, tokens_in: 0, tokens_out: 0, lines_added: 0, lines_removed: 0, projects: {} }
	const all: Stretch[] = []
	const byProject = new Map<string, Stretch[]>()
	for (const list of sessions.values()) {
		const sorted = [...list].sort((a, b) => a.t - b.t)
		const k = kinds(sorted)
		const project = sorted.find((r) => r.project)?.project ?? ''
		const clipped = credit(sorted)
			.map((s) => ({ ...s, start: Math.max(s.start, from), end: Math.min(s.end, to) }))
			.filter((s) => s.end > s.start)
		all.push(...clipped)
		byProject.set(project, [...(byProject.get(project) ?? []), ...clipped])
		const p = (t.projects[project] ??= { witnessed: 0, unwitnessed: 0, prompts: 0 })
		sorted.forEach((r, i) => {
			if (r.t < from || r.t >= to) return
			if (k[i] === 'human') t.prompts++, p.prompts++
			t.tokens_in += r.in ?? 0
			t.tokens_out += r.out ?? 0
			t.lines_added += r.added ?? 0
			t.lines_removed += r.removed ?? 0
		})
	}
	Object.assign(t, union(all))
	for (const [project, list] of byProject) Object.assign(t.projects[project]!, union(list))
	return t
}
