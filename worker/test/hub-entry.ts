// The Worker as it deploys, with a UserHub whose day writes the hub tests
// can hold open, fail, or interrupt, to check that no record is lost.
import { UserHub as Hub } from '../src/hub.ts'
export { default } from '../src/index.ts'

export class UserHub extends Hub {
	private gate: Promise<void> | null = null
	private open = () => {}
	private waiting = 0
	private failNext = false
	private failRead = false
	private reads: { day: string; go: () => void }[] | null = null
	private held = ''

	/** holdWrites makes the next day writes wait, until releaseWrites. */
	holdWrites() {
		this.gate = new Promise((r) => (this.open = r))
	}
	/** writing counts the writes waiting at the hold. */
	writing() {
		return this.waiting
	}
	releaseWrites() {
		this.gate = null
		this.open()
	}
	/** holdReads makes reads of the sealed day t is on wait once they have what R2 held, until releaseRead lets the oldest go on. */
	holdReads(t: number) {
		this.reads = []
		this.held = new Date(t).toISOString().slice(0, 10)
	}
	/** reading counts the reads waiting at the hold. */
	reading() {
		return this.reads?.length ?? 0
	}
	/** releaseRead lets the oldest waiting read go on, or with all, every read, and stops holding them. */
	releaseRead(all = false) {
		if (all) {
			for (const read of this.reads ?? []) read.go()
			this.reads = null
		} else this.reads?.shift()?.go()
	}
	/**
	 * flushAsReadEnds lets every waiting read go on, stops holding them, and
	 * flushes the moment the oldest one's day counts as loaded: before the
	 * records that waited on that read go on. It returns the days the flush
	 * wrote, which is none when it got in ahead of those records.
	 */
	async flushAsReadEnds() {
		const reads = this.reads ?? []
		this.reads = null
		const day = reads[0]?.day
		if (!day) throw new Error('no read is waiting')
		for (const read of reads) read.go()
		// A microtask at a time, so nothing but the read runs before the flush.
		for (let i = 0; !this.ctx.storage.sql.exec('SELECT 1 FROM loaded WHERE day = ?', day).toArray().length; i++) {
			if (i > 100) throw new Error('the read did not end')
			await null
		}
		return this.flush()
	}
	failNextWrite() {
		this.failNext = true
	}
	failNextRead() {
		this.failRead = true
	}
	/** alarmAt says when the hub's next flush is due, or null; clearAlarm cancels it. */
	alarmAt() {
		return this.ctx.storage.getAlarm()
	}
	clearAlarm() {
		return this.ctx.storage.deleteAlarm()
	}
	/** crash resets the hub, as a deploy or a restart does, whatever it is in the middle of. */
	crash() {
		this.ctx.abort('reset by the test')
	}

	protected override async readDay(user: number, day: string) {
		if (this.failRead) {
			this.failRead = false
			throw new Error('R2 is down')
		}
		const body = await super.readDay(user, day)
		if (this.reads && day === this.held) await new Promise<void>((go) => this.reads!.push({ day, go }))
		return body
	}

	protected override async writeDay(user: number, day: string, lines: string[]) {
		if (this.failNext) {
			this.failNext = false
			throw new Error('R2 is down')
		}
		if (this.gate) {
			this.waiting++
			await this.gate
			this.waiting--
		}
		return super.writeDay(user, day, lines)
	}
}
