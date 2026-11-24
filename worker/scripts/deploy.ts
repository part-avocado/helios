// npm run deploy: applies the D1 migrations before the new code goes live,
// so it never runs against tables it doesn't have yet. Every migration only
// adds, so the code still live works on the new tables. A site's first
// deploy creates the database, so then the migrations come after it.
import { execFileSync, spawnSync } from 'node:child_process'

const shell = process.platform === 'win32' // npx is a .cmd there
const wrangler = (...args: string[]) => execFileSync('npx', ['wrangler', ...args], { stdio: 'inherit', shell })

const info = spawnSync('npx', ['wrangler', 'd1', 'info', 'teardrop'], { encoding: 'utf8', shell })
// Only wrangler saying there is no such database means a first deploy. Any
// other failure, such as no network, stops here rather than deploy first.
const exists = info.status === 0
if (!exists && !/Couldn't find a D1 DB/.test(`${info.stdout}${info.stderr}`)) {
	process.stderr.write(`${info.stdout ?? ''}${info.stderr ?? ''}${info.error ? `Could not run npx: ${info.error.message}\n` : ''}`)
	console.error('Could not tell whether the D1 database exists, so nothing was deployed. Fix the error above and run npm run deploy again.')
	process.exit(1)
}
if (exists) wrangler('d1', 'migrations', 'apply', 'DB', '--remote')
wrangler('deploy')
if (!exists) wrangler('d1', 'migrations', 'apply', 'DB', '--remote')
