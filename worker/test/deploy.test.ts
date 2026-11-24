// npm run deploy (scripts/deploy.ts), with a stand-in for npx that logs what
// it is asked to run and answers `wrangler d1 info` as told.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

function deploy(info: string): { status: number | null; ran: string[] } {
	const dir = mkdtempSync(join(tmpdir(), 'deploy-'))
	try {
		writeFileSync(join(dir, 'npx'), `#!/bin/sh\necho "$*" >> "${dir}/log"\nif [ "$3" = info ]; then ${info}; fi\nexit 0\n`, { mode: 0o755 })
		const res = spawnSync(process.execPath, [new URL('../scripts/deploy.ts', import.meta.url).pathname], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8' })
		let ran: string[] = []
		try {
			ran = readFileSync(join(dir, 'log'), 'utf8').trim().split('\n')
		} catch {}
		return { status: res.status, ran }
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

test('deploy migrates first, after only on a first deploy, and stops when it cannot tell', { skip: process.platform === 'win32' }, () => {
	const info = 'wrangler d1 info teardrop', migrate = 'wrangler d1 migrations apply DB --remote', ship = 'wrangler deploy'
	assert.deepEqual(deploy('exit 0'), { status: 0, ran: [info, migrate, ship] })
	// No database yet: the first deploy creates it.
	assert.deepEqual(deploy(`echo "✘ [ERROR] Couldn't find a D1 DB named 'teardrop'" >&2; exit 1`), { status: 0, ran: [info, ship, migrate] })
	// Anything else, such as no network, deploys nothing: the code must not go live before its tables.
	const failed = deploy('echo "fetch failed" >&2; exit 1')
	assert.notEqual(failed.status, 0)
	assert.deepEqual(failed.ran, [info])
})
