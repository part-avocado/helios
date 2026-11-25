// The docs page is written from the Markdown in ../docs by scripts/docs.ts,
// and committed, since the Go binary embeds it.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

test('site/docs.html is what the Markdown pages in docs/ make', () => {
	const run = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/docs.ts', import.meta.url)), '--check'], { encoding: 'utf8' })
	assert.equal(run.status, 0, `${run.stdout}${run.stderr}`)
})
