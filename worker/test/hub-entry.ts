// The Worker as it deploys, with a UserHub whose day writes the hub tests
// can hold open, fail, or interrupt, to check that no record is lost.
import { UserHub as Hub } from '../src/hub.ts'
export { default } from '../src/index.ts'

export class UserHub extends Hub {
	private gate: Promise<void> | null = null
	private open = () => {}
	private waiting = false
	private failNext = false

	/** holdWrites makes the next day writes wait, until releaseWrites. */
	holdWrites() {
		this.gate = new Promise((r) => (this.open = r))
		this.waiting = false
	}
	/** writing says whether a write is waiting at the hold. */
	writing() {
		return this.waiting
	}
	releaseWrites() {
		this.gate = null
		this.open()
	}
	failNextWrite() {
		this.failNext = true
	}
	/** crash resets the hub, as a deploy or a restart does, whatever it is in the middle of. */
	crash() {
		this.ctx.abort('reset by the test')
	}

	protected override async writeDay(user: number, day: string, lines: string[]) {
		if (this.failNext) {
			this.failNext = false
			throw new Error('R2 is down')
		}
		if (this.gate) {
			this.waiting = true
			await this.gate
		}
		return super.writeDay(user, day, lines)
	}
}
