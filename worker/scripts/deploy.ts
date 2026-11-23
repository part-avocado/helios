// npm run deploy: applies the D1 migrations before the new code goes live,
// so it never runs against tables it doesn't have yet. Every migration only
// adds, so the code still live works on the new tables. A site's first
// deploy creates the database, so then the migrations come after it.
import { execFileSync } from 'node:child_process'

const wrangler = (...args: string[]) => execFileSync('npx', ['wrangler', ...args], { stdio: 'inherit', shell: process.platform === 'win32' })
let exists = true
try {
	execFileSync('npx', ['wrangler', 'd1', 'info', 'teardrop'], { stdio: 'ignore', shell: process.platform === 'win32' })
} catch {
	exists = false
}
if (exists) wrangler('d1', 'migrations', 'apply', 'DB', '--remote')
wrangler('deploy')
if (!exists) wrangler('d1', 'migrations', 'apply', 'DB', '--remote')
