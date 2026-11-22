// The hosting cost model: what the Worker, D1, R2, and the hub Durable
// Objects cost a month for a given load, from Cloudflare's prices of
// 2026-11-22. Run: node scripts/cost-model.ts [prompts per hour]
// Every input below is an assumption until production numbers replace it.

const inputs = {
	people: 15_488,
	engagedHours: 109_759, // a month, across everyone
	promptsPerHour: Number(process.argv[2]) || 20,
	recordsPerTurn: 2.15, // prompt, turn end, and some session and commit records
	bytesPerRecord: 80, // in R2, once a day's lines are compressed together
	computersPerPerson: 1.3,
	flushesPerHour: 6, // the hub writes a changed day at most every 10 minutes
	syncsPerTurn: 0.5, // turn ends that start a sync; queued syncs merge
	reportBytes: 6_000, // one computer's latest report in R2, compressed
	logRowBytes: 600, // an account_log row, which each report sync adds
	logRowsInD1: 400, // per person at most (LOG_KEPT + ARCHIVE in src/log.ts); older rows go to R2
	reportSyncShare: 0.1, // syncs that still send a report: Amp cloud threads and teardrop before 0.7
	keptReportBytes: 40_000, // each such report, kept in R2 for good
	promptDayBytes: 300,
	pageRequests: 4_500_000, // pages, API calls, profiles, and sockets
	submissionsPerPerson: 2,
}

const price = {
	workersBase: 5, requestsIncluded: 10e6, perMillionRequests: 0.3, cpuMsIncluded: 30e6, perMillionCpuMs: 0.02, cpuMsPerRequest: 3,
	d1RowsWrittenIncluded: 50e6, d1PerMillionRows: 1, d1StorageIncludedGB: 5, d1PerGB: 0.75, d1LimitGB: 10,
	r2WritesIncluded: 1e6, r2PerMillionWrites: 4.5, r2ReadsIncluded: 10e6, r2PerMillionReads: 0.36, r2StorageIncludedGB: 10, r2PerGB: 0.015,
	doRequestsIncluded: 1e6, doPerMillion: 0.15,
}

/** month returns the bill in month m (1 = the first month after release). */
function month(m: number) {
	const i = inputs
	const prompts = i.engagedHours * i.promptsPerHour
	const records = prompts * i.recordsPerTurn
	const syncs = prompts * i.syncsPerTurn
	const reportSyncs = syncs * i.reportSyncShare
	const requests = records + syncs + i.pageRequests + i.people * i.submissionsPerPerson
	const workers = price.workersBase + Math.max(0, requests - price.requestsIncluded) / 1e6 * price.perMillionRequests + Math.max(0, requests * price.cpuMsPerRequest - price.cpuMsIncluded) / 1e6 * price.perMillionCpuMs

	const flushes = i.engagedHours * i.flushesPerHour
	const r2Writes = flushes + syncs + i.people * i.submissionsPerPerson
	const recordsGB = (records * i.bytesPerRecord * m) / 1e9 + (reportSyncs * (i.keptReportBytes + i.logRowBytes / 4) * m) / 1e9
	const reportsGB = (i.people * i.computersPerPerson * i.reportBytes) / 1e9
	const r2GB = recordsGB + reportsGB
	const r2 = Math.max(0, r2Writes - price.r2WritesIncluded) / 1e6 * price.r2PerMillionWrites + Math.max(0, r2GB - price.r2StorageIncludedGB) * price.r2PerGB

	// prompt_days: a person row and a computer row per active day, written at each flush.
	const activeDays = i.people * i.computersPerPerson * 10
	const d1Rows = flushes * 3 + reportSyncs * 3
	const logGB = Math.min(reportSyncs * m, i.people * i.logRowsInD1) * i.logRowBytes / 1e9
	const d1GB = (activeDays * 2 * i.promptDayBytes * m) / 1e9 + logGB
	const d1 = Math.max(0, d1Rows - price.d1RowsWrittenIncluded) / 1e6 * price.d1PerMillionRows + Math.max(0, d1GB - price.d1StorageIncludedGB) * price.d1PerGB

	const doRequests = records + flushes + i.pageRequests / 3
	const dos = Math.max(0, doRequests - price.doRequestsIncluded) / 1e6 * price.doPerMillion
	return { workers, d1, d1GB, logGB, r2, r2GB, dos, total: workers + d1 + r2 + dos, requests, r2Writes, d1Rows }
}

const $ = (n: number) => `$${n.toFixed(2)}`
console.log(`${inputs.promptsPerHour} prompts per engaged hour, ${inputs.people.toLocaleString()} people, ${inputs.engagedHours.toLocaleString()} hours a month\n`)
console.log('After      Workers   D1       R2       DOs      Total    D1 size   R2 size')
for (const m of [1, 12, 36, 84]) {
	const c = month(m)
	const label = m === 1 ? '1 month' : `${m / 12} year${m > 12 ? 's' : ''}`
	console.log([label.padEnd(10), $(c.workers).padEnd(9), $(c.d1).padEnd(8), $(c.r2).padEnd(8), $(c.dos).padEnd(8), $(c.total).padEnd(8), `${c.d1GB.toFixed(1)} GB`.padEnd(9), `${c.r2GB.toFixed(1)} GB`].join(' '))
	if (c.d1GB > price.d1LimitGB) console.log(`           D1 is past its ${price.d1LimitGB} GB limit: fold old prompt_days rows into months.`)
}
const c = month(12)
console.log(`\nA month: ${(c.requests / 1e6).toFixed(1)}M requests, ${(c.r2Writes / 1e6).toFixed(2)}M R2 writes, ${(c.d1Rows / 1e6).toFixed(1)}M D1 rows written. The limit is $500.`)
