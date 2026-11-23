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
	/** A commit's, on a commit record, which earns no time. */
	sha?: string
	/** The event's name; a `usage` record carries a turn's tokens and lines from its transcript and earns no time. */
	event?: string
	/** It claimed more tokens or lines than one record can hold, and was cut to the most (hub.ts). */
	clamped?: boolean
	/** How far its computer's clock ran behind the site's, in ms, as pinned for that computer (hub.ts); ahead is negative. */
	skew?: number
}

export interface Stretch {
	start: number
	end: number
	witnessed: boolean
}

/** Witnessed against the time the record claims, corrected by its computer's pinned clock skew. */
const witnessed = (r: Rec) => r.arrived - (r.t + (r.skew ?? 0)) <= WITNESS
/** timed says whether a record is a prompt or agent output, which time is credited between. */
export const timed = (r: Rec) => !r.sha && r.event !== 'usage'

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
	const ev = recs.filter(timed).sort((a, b) => a.t - b.t)
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
export function totals(all_: Rec[], from: number, to: number): Totals {
	const recs = all_.filter((r) => !r.sha)
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

/** The most a computer's clock is corrected by; a reading further off is ignored. */
const MAX_SKEW = 3600_000
/** A reading within this of the pin agrees with it. */
const SKEW_AGREE = 60_000
/** How long a different reading must hold before it replaces the pin. */
const SKEW_HOLD = 86400_000

/**
 * A computer's clock correction: the pin, and a different reading waiting to
 * replace it. The pin is set from a computer's first reading and changes only
 * when another reading holds for a day, so a batch can't pick its own skew:
 * one that says it was sent last week is ignored, and its records stay late.
 */
export interface Clock {
	pin: number
	cand?: number
	since?: number
}

/** nextClock folds one reading, now minus the time the computer said it sent the batch, into its clock. */
export function nextClock(clock: Clock | null, reading: number | null, now: number): Clock | null {
	if (reading == null || !Number.isFinite(reading) || Math.abs(reading) > MAX_SKEW) return clock
	const r = Math.round(reading / 1000) * 1000
	if (!clock) return { pin: r }
	if (Math.abs(r - clock.pin) <= SKEW_AGREE) return { pin: clock.pin }
	if (clock.cand != null && clock.since != null && Math.abs(r - clock.cand) <= SKEW_AGREE) {
		return now - clock.since >= SKEW_HOLD ? { pin: clock.cand } : clock
	}
	return { pin: clock.pin, cand: r, since: now }
}

/** A day with more witnessed time than this, across a person's computers, is worth a look. */
const LONG_DAY = 16 * 3600
/** A prompt sent this soon after the agent's reply was sent before the reply could be read. */
const QUICK = 15_000
/** No break this long in an active stretch this long is a stretch no one works. */
const BREAK = 2 * 3600_000
const MARATHON = 16 * 3600_000
/** More credited time than this in any 24 hours. */
const ROLLING_DAY = 14 * 3600_000

/** Reasons a reviewer should look at a submission first. None changes what is credited. */
export interface Flag {
	kind: 'long-day' | 'steady-gaps' | 'even-gaps' | 'no-turn-ends' | 'no-tokens' | 'clamped' | 'quick-replies' | 'unanswered' | 'no-break' | 'rolling-day' | 'clock-skew'
	text: string
}

const pct = (n: number) => `${Math.round(n * 100)}%`
const hours = (ms: number) => `${Math.round((ms / 3600_000) * 10) / 10} hours`

/** sessionsOf groups timed records by tool and session, each in time order. */
function sessionsOf(recs: Rec[]): Rec[][] {
	const by = new Map<string, Rec[]>()
	for (const r of recs) {
		const k = `${r.tool}\0${r.session}`
		by.set(k, [...(by.get(k) ?? []), r])
	}
	return [...by.values()].map((l) => l.sort((a, b) => a.t - b.t))
}

/** mostIn returns the most credited time in any 24 hours, from merged, sorted spans. */
function mostIn(spans: { start: number; end: number }[], window: number): number {
	let most = 0
	for (let i = 0; i < spans.length; i++) {
		const until = spans[i]!.start + window
		let sum = 0
		for (let j = i; j < spans.length && spans[j]!.start < until; j++) sum += Math.min(spans[j]!.end, until) - spans[j]!.start
		most = Math.max(most, sum)
	}
	return most
}

/** flags looks for what a script that sends records live would leave behind. */
export function flags(all: (Rec & { event: string })[], dayTotals: { day: string; witnessed_seconds: number }[]): Flag[] {
	const recs = all.filter(timed)
	const out: Flag[] = []
	const long = dayTotals.filter((d) => d.witnessed_seconds > LONG_DAY)
	if (long.length) out.push({ kind: 'long-day', text: `More than 16 witnessed hours in a day across their computers, on ${long.map((d) => d.day).join(', ')}.` })
	const prompts = recs.filter((r) => r.human).sort((a, b) => a.t - b.t)
	const gaps = prompts.slice(1).map((r, i) => r.t - prompts[i]!.t).filter((g) => g < 30 * 60_000)
	if (gaps.length >= 10) {
		const mean = gaps.reduce((n, g) => n + g, 0) / gaps.length
		const sd = Math.sqrt(gaps.reduce((n, g) => n + (g - mean) ** 2, 0) / gaps.length)
		if (sd / mean < 0.05) out.push({ kind: 'steady-gaps', text: `The gaps between ${gaps.length + 1} prompts barely vary (about ${Math.round(mean / 1000)} seconds each).` })
		// People's gaps vary by their whole length or more; a script with some jitter still varies little.
		else if (gaps.length >= 20 && sd / mean < 0.15) out.push({ kind: 'even-gaps', text: `The gaps between ${gaps.length + 1} prompts vary little: about ${Math.round(mean / 1000)} seconds, give or take ${Math.round(sd / 1000)}.` })
	}
	// Turns: a prompt that follows the agent's reply, in one session.
	let turns = 0, quick = 0, asked = 0, unanswered = 0
	for (const list of sessionsOf(recs)) {
		list.forEach((r, i) => {
			if (!r.human) return
			asked++
			const prev = list[i - 1], next = list[i + 1]
			if (prev && !prev.human) {
				turns++
				if (r.t - prev.t < QUICK) quick++
			}
			// The session's last prompt may still be running; one followed by another prompt went unanswered.
			if (next?.human) unanswered++
		})
	}
	if (turns >= 30 && quick / turns > 0.3) out.push({ kind: 'quick-replies', text: `${pct(quick / turns)} of ${turns} prompts came within 15 seconds of the agent's reply, before it could be read.` })
	if (asked >= 20 && unanswered < asked && unanswered / asked > 0.25) out.push({ kind: 'unanswered', text: `${pct(unanswered / asked)} of ${asked} prompts were followed by another prompt before the agent answered.` })
	// Activity across every session: stretches with no 2-hour break, and credited time in any 24 hours.
	const times = recs.map((r) => r.t).sort((a, b) => a - b)
	let longest = 0
	for (let i = 1, from = times[0] ?? 0; i <= times.length; i++) {
		if (i === times.length || times[i]! - times[i - 1]! >= BREAK) {
			longest = Math.max(longest, times[i - 1]! - from)
			from = times[i] ?? 0
		}
	}
	if (longest > MARATHON) out.push({ kind: 'no-break', text: `Active for ${hours(longest)} with no break of 2 hours.` })
	const spans: { start: number; end: number }[] = []
	for (const st of sessionsOf(recs).flatMap((l) => credit(l)).sort((a, b) => a.start - b.start)) {
		const last = spans.at(-1)
		if (last && st.start <= last.end) last.end = Math.max(last.end, st.end)
		else spans.push({ start: st.start, end: st.end })
	}
	const most = mostIn(spans, 24 * 3600_000)
	if (most > ROLLING_DAY) out.push({ kind: 'rolling-day', text: `${hours(most)} credited within 24 hours.` })
	if (prompts.length >= 5 && !recs.some((r) => !r.human)) out.push({ kind: 'no-turn-ends', text: `${prompts.length} prompts and no turn ends: the agent never answered.` })
	// Amp's plugins report tokens with every turn end.
	const silent = recs.filter((r) => !r.human && r.tool === 'amp' && r.event === 'agent.end' && !r.in && !r.out)
	if (silent.length >= 3) out.push({ kind: 'no-tokens', text: `${silent.length} Amp turns ended with no tokens, which Amp always reports.` })
	// Counted from all of them: commit and usage records carry lines and tokens too.
	// Records witnessed only because their computer's clock was corrected by more than the witness window allows.
	const skewed = recs.filter((r) => Math.abs(r.skew ?? 0) > WITNESS)
	if (skewed.length) {
		const most = Math.max(...skewed.map((r) => Math.abs(r.skew!)))
		out.push({ kind: 'clock-skew', text: `${skewed.length} record${skewed.length === 1 ? '' : 's'} came from a computer whose clock was off by more than 5 minutes (up to ${Math.round(most / 60_000)} minutes), and ${skewed.length === 1 ? 'was' : 'were'} counted at the corrected time.` })
	}
	const clamped = all.filter((r) => r.clamped).length
	if (clamped) out.push({ kind: 'clamped', text: `${clamped} record${clamped === 1 ? '' : 's'} claimed more than 200 million tokens or a million lines, and ${clamped === 1 ? 'was' : 'were'} cut to that.` })
	return out
}

/** Engaged stretches closer than this are shown as one work block. */
export const BLOCK_GAP = 15 * 60_000

/** A work block, as the hub keeps it per day: like a report's block, in numbers. */
export interface Block {
	project: string
	start: number
	end: number
	engaged: number
	prompts: number
	in: number
	out: number
	added: number
	removed: number
	tools: string[]
}

/**
 * blocks groups the credited time of records in [from, to) into work blocks
 * per project, as teardrop's reports do, and puts each record's prompts,
 * tokens, and lines in the block it falls in.
 */
export function blocks(all: Rec[], from: number, to: number): Block[] {
	const recs = all.filter((r) => !r.sha)
	const sessions = new Map<string, Rec[]>()
	for (const r of recs) {
		const key = `${r.tool}\0${r.session}`
		sessions.set(key, [...(sessions.get(key) ?? []), r])
	}
	const byProject = new Map<string, { s: { start: number; end: number; tool: string }[]; recs: [Rec, Kind][] }>()
	for (const list of sessions.values()) {
		const sorted = [...list].sort((a, b) => a.t - b.t)
		const project = sorted.find((r) => r.project)?.project ?? ''
		const p = byProject.get(project) ?? { s: [], recs: [] }
		byProject.set(project, p)
		for (const st of credit(sorted)) {
			const start = Math.max(st.start, from), end = Math.min(st.end, to)
			if (end > start) p.s.push({ start, end, tool: sorted[0]!.tool })
		}
		const timedRecs = sorted.filter(timed)
		const k = kinds(timedRecs)
		const kindOf = new Map(timedRecs.map((r, i) => [r, k[i]!]))
		for (const r of sorted) if (r.t >= from && r.t < to) p.recs.push([r, kindOf.get(r) ?? 'agent'])
	}
	const out: Block[] = []
	for (const [project, { s, recs: rs }] of byProject) {
		s.sort((a, b) => a.start - b.start)
		const mine: Block[] = []
		let covered = 0
		for (const x of s) {
			const b = mine.at(-1)
			if (b && x.start - b.end < BLOCK_GAP) {
				// Time two sessions share counts once.
				if (x.end > covered) b.engaged += x.end - Math.max(x.start, covered)
				b.end = Math.max(b.end, x.end)
				if (!b.tools.includes(x.tool)) b.tools.push(x.tool)
			} else {
				mine.push({ project, start: x.start, end: x.end, engaged: x.end - x.start, prompts: 0, in: 0, out: 0, added: 0, removed: 0, tools: [x.tool] })
			}
			covered = Math.max(covered, x.end)
		}
		for (const [r, kind] of rs) {
			const b = mine.find((b) => r.t >= b.start && r.t <= b.end + BLOCK_GAP) ?? mine.findLast((b) => b.start <= r.t)
			if (!b) continue
			if (kind === 'human') b.prompts++
			b.in += r.in ?? 0
			b.out += r.out ?? 0
			b.added += r.added ?? 0
			b.removed += r.removed ?? 0
		}
		out.push(...mine)
	}
	return out.sort((a, b) => a.start - b.start)
}

const DAY_MS = 86400_000

/**
 * capSpans keeps the parts of spans that fit the daily and weekly caps, in
 * milliseconds, counting `used` first. Days are the person's own, offset
 * minutes ahead of UTC, and weeks start on Monday. Within a day, earlier
 * time is kept first.
 */
export function capSpans(spans: [number, number][], used: [number, number][], offset: number, daily: number, weekly: number): [number, number][] {
	const shift = offset * 60_000
	const dayOf = (t: number) => Math.floor((t + shift) / DAY_MS)
	// Day 0, 1970-01-01, was a Thursday.
	const weekOf = (day: number) => Math.floor((day + 3) / 7)
	const pieces = (list: [number, number][]) =>
		list.flatMap(([s, e]) => {
			const out: [number, number][] = []
			while (s < e) {
				const end = Math.min(e, (dayOf(s) + 1) * DAY_MS - shift)
				out.push([s, end])
				s = end
			}
			return out
		})
	const byDay = new Map<number, number>(), byWeek = new Map<number, number>()
	const add = (s: number, ms: number) => {
		const d = dayOf(s)
		byDay.set(d, (byDay.get(d) ?? 0) + ms)
		byWeek.set(weekOf(d), (byWeek.get(weekOf(d)) ?? 0) + ms)
	}
	for (const [s, e] of pieces(used)) add(s, e - s)
	const kept: [number, number][] = []
	for (const [s, e] of pieces(spans).sort((a, b) => a[0] - b[0])) {
		const d = dayOf(s)
		const room = Math.min(daily - (byDay.get(d) ?? 0), weekly - (byWeek.get(weekOf(d)) ?? 0))
		const take = Math.max(0, Math.min(e - s, room))
		if (!take) continue
		kept.push([s, s + take])
		add(s, take)
	}
	return kept
}
