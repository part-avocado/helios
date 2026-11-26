# Running a server

The site is one Cloudflare Worker with a D1 database for summaries, an R2 bucket for every report and per-prompt record, and a Durable Object per account that takes records as they arrive and pushes them to open dashboards.

<a id="cloudflare"></a>
## The website, on Cloudflare

The Worker is in the `worker` folder of the [repository](https://github.com/part-avocado/helios) and serves the pages in `site`. You need a Cloudflare account and Node.js 22 or later.

To try it on your computer first:

```
cd worker
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

`.dev.vars` signs every visitor in as the Slack user ID in `DEV_LOGIN`, which only works on localhost. Open the address it prints and follow the setup steps on the dashboard.

To put it online, connect the repository to Cloudflare. Nothing needs to be installed or signed in on your computer.

1. In the Cloudflare dashboard, open Workers & Pages, then Create, then Import a repository. Choose your fork of the [repository](https://github.com/part-avocado/helios).
2. Name the Worker `helios`, set the root directory to `worker`, the build command to `npm ci`, and the deploy command to `npm run deploy`. Save and deploy. The first deploy creates the D1 database, its tables, and an R2 bucket that keeps every report for reviewers. It runs without the secrets, and the site says it is not set up yet.
3. Create a Hack Club Auth app as in [Set up sign-in](#hca-app) below, with the `openid`, `profile`, and `slack_id` scopes and `https://<worker>.<your-subdomain>.workers.dev/auth/callback` as its redirect URI. Cloudflare shows the address under the Worker's Settings, Domains & Routes.
4. Under the Worker's Settings, Variables and Secrets, add these as secrets: `SESSION_SECRET` (any long random text), `HCA_CLIENT_ID`, `HCA_CLIENT_SECRET`, and `ADMINS`. Deploying again, which a push to the branch does, keeps them.

The bucket needs R2 turned on for your Cloudflare account, which you do once under R2 in the dashboard. If the build fails on permissions for D1 or R2, open the Worker's Settings, Builds, and give its API token D1 Edit and Workers R2 Storage Edit access.

To deploy from your computer instead, run `npx wrangler login` in `worker`, then `npm run deploy`, and add the secrets in the dashboard or with `npx wrangler secret put <NAME>`.

Deploy with `npm run deploy`, not `npx wrangler deploy` alone: it applies the D1 migrations before the new code goes live. The code reads columns that migrations add, so the order matters. Migration `0026_capped_days.sql` adds `prompt_days.uncapped_seconds`, which every flush of a day's records writes; code deployed before it is applied fails each flush until it is, and the records wait in the meantime. If you deploy by hand, run `npx wrangler d1 migrations apply DB --remote` first.

| Setting | Meaning |
| --- | --- |
| `SESSION_SECRET` | Signs sign-in cookies. Changing it signs everyone out. |
| `HCA_CLIENT_ID`, `HCA_CLIENT_SECRET` | Your Hack Club Auth app. |
| `ADMINS` | Slack user IDs of the superadmins, separated by commas. They add everyone else who reviews, in [the review app](#review-app). |
| `GITHUB_TOKEN` | Optional secret. Lets the hourly check ask GitHub which claimed commits exist, when GitHub dates them, and whose they are. Without it, commits are linked but not checked, and the review app says so. |
| `MIN_VERSION` | Optional variable, such as `v0.6.0`. Older helios versions, and ones too old to say their version, are told to run `helios update` and can't sync until they do. Their records wait on their computers and arrive late, so late that their time isn't credited, so raise it only for a fix that needs it. Empty answers every version. |
| `UPLOAD_BURST`, `RECENT_RECORDS_PER_DAY`, `OLD_RECORDS_PER_DAY` | What one account may send: 1,000 uploads at once, which come back one a second; 30,000 records a day dated in the last two days; and 100,000 older ones a day, for a first sync of a year (set `OLD_RECORDS_PER_DAY` higher if you need to import more). Past one, the site answers 429 and helios keeps the records to send later. The defaults are about ten times the heaviest honest use. Records held back more than 5 minutes arrive late and aren't credited, so lower them with care. |
| `REPORT_BYTES_PER_DAY` | Optional variable: how many bytes of signed reports one account may upload a day, 256 MB when empty. Past it, the site answers 429. Only each account's newest 20 reports that failed their signature check are kept in full. |

To change a secret later, edit it in the dashboard. For your own domain, add a [custom domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) to the Worker and use it in the redirect URI. Cloudflare accepts uploads of up to 100 MB.

<a id="review-app"></a>
## The review app

Reviewing has its own app at `/review/`, apart from the rest of the site. Reviewers get a Review link in the top bar. What a reviewer can do depends on their level:

| Level | Who | What they can do |
| --- | --- | --- |
| Superadmin | The Slack IDs in `ADMINS`. | Everything below, and add or remove neoadmins. |
| Neoadmin | Added by a superadmin. | Read every account: its computers, its projects, and a log of every report it sent. Each log entry shows what the report held and which days and projects changed, and links to the report itself, kept as it arrived. Add and remove reviewers. Ban people. |
| Reviewer | Added by a neoadmin or superadmin. | Look a person up by Slack ID and read their total for each project, with each project's graphs, and their time through the [Stats API](#stats-api). Nothing else of theirs. |

To add someone, look up their Slack ID in the app and choose a level in the Access panel of their account view. They can be added before they first sign in. No one can add, remove, or ban someone at their own level or above, so a neoadmin can't touch another neoadmin.

Each person's page has a Project activity panel. For one project at a time it draws engaged time and lines added and removed per day, when in the week they work, and every work block's length against the share of it that was engaged. It also checks the blocks for what to ask about: time counted on two computers at once, long blocks without breaks, lines changed without a prompt, very many lines per hour, and days over 14 hours. A check that stands out is a reason to ask, not proof.

Levels and bans are set on a person's account view, in its Access and Bans panels. A Slack ID that has never signed in opens a view with only those two, so a person can be added or banned before their first sign-in. The Reviewers and Bans pages list who holds each level and every ban, and link to each account view.

A ban has no length: it lasts until someone lifts it, and always has a reason, which only reviewers see. While it holds, the site takes nothing new from the person: no syncs, uploads, or cloud events. `helios sync`, their dashboard, and their settings say plainly that they are banned until a reviewer lifts it, but not why. They can still sign in and see what they had. The review app marks a banned person in red wherever they appear. A banned reviewer can't review. Someone below the level of whoever issued a ban can't lift or replace it.

Any reviewer can make API keys, under API keys in the app, for a script or a bot. A key acts as the person who made it, at the level they hold when it is used, and stops working when they are removed or banned. The key is shown once, in a popup to copy it from; the site keeps only its hash. Send it as a bearer token:

```
curl -H "Authorization: Bearer tdr_..." "https://your-site/api/review/person?slack=U012ABCDEF"
```

<a id="stats-api"></a>
## Stats API

Programs that credit hours, such as a You Ship, We Ship, read people's time here instead of taking submissions. It is protected: call it with a review key, made under API keys in the review app by someone with a place there. A reviewer's key sees project names only; a neoadmin's or superadmin's also sees each project's key, such as `github.com/you/site`.

```
curl -H "Authorization: Bearer tdr_..." "https://your-site/api/review/stats?slack=U012ABCDEF&start=2026-01-01&end=2026-03-31"
```

| Parameter | Meaning |
| --- | --- |
| `slack` | The person's Slack ID. Neoadmins and superadmins may send `id`, the account number, instead. |
| `start`, `end` | Optional. Days, such as `2026-01-31`, on the person's own clock, both included. Without them, all of their time. |
| `project` | Optional. Project names, separated by commas, or keys for neoadmins and superadmins. Without it, every project. |
| `flags` | Optional. `true` reads the records behind the answer, at most 400 days of them, and lists flags for someone to look at. |

The answer has `person` (`slack_id`, `name`, `created_at`, `deleted_at`), `ban` (`reason` and `at`, or `null`), `witnessed_seconds`, `unwitnessed_seconds`, and `prompts`; `projects`, most witnessed time first, each with `name`, `key`, the same three counts, `first_day`, and `last_day`; `days`, each `date` with the same three counts; and `flags` when asked, each with `kind` and `text`. Time on two projects at once counts once in the totals, and is split equally between those projects, so a person's projects add up to their total. The answer is up to the moment. Which time to credit, whether to count unwitnessed time, and how to treat a ban or a flag are the program's to decide.

<a id="public-api"></a>
## Public API

Anyone with an account can read their own stats from a script, or let another site read them, for example to list your projects when you sign in there. Make a read key under Settings, API. It starts with `tdp_`, is shown once, and can only read: it can't upload, change, or delete anything. Your sync key doesn't work here, and a read key doesn't sync. While your account is banned, your read keys read nothing.

```
curl -H "Authorization: Bearer tdp_..." "https://your-site/api/public/v1/projects"
```

| Call | What it returns |
| --- | --- |
| `GET /api/public/v1/me` | `name`, `slack_id`, `created_at`, `engaged_seconds` in the past year, and `synced_at`. |
| `GET /api/public/v1/projects` | `projects`, most time first, each with `name`, `repo` (such as `github.com/you/site`, or `null` for a project that is only a folder), `engaged_seconds`, `first_active`, and `last_active`. |
| `GET /api/public/v1/days?since=2026-01-01` | `days`: each date with its `engaged_seconds`. `since` is optional. |
| `GET /api/public/v1/users/{handle}` | Anyone's [public profile](dashboard.md#profile), with no key: `handle`, `joined` (YYYY-MM), `engaged_seconds` in the past year, `days`, `projects` (each with `name`, `repo`, and `engaged_seconds`), and `other_projects` (`count` and `engaged_seconds`). A private, banned, or unknown profile answers 404. Answers may be cached for a minute. |
| `GET /api/public/v1/users/{handle}/badge.svg` | A badge of the profile's hours for a README, with no key. Add `?project=` and a repository or project name the profile names for one project's hours. It shows only what the profile shows: a private, banned, or unknown profile, or a project the profile doesn't name, answers 404. Answers may be cached for 5 minutes. |

Times are Unix milliseconds. Answers are JSON; a refusal is plain text with its reason. Any site may call the API from the browser, since it takes only the key and no cookies. Folders on your computer are never shown, only repositories.

<a id="sign-in-with-helios"></a>
## Sign in with helios

A site can get a read key without anyone pasting one. Send the person to:

```
https://your-site/authorize?redirect_uri=https://example.com/callback&state=RANDOM&name=My+portfolio
```

They sign in if they need to, see the site's address and what it will read, and choose Allow. They come back to `redirect_uri` with `code` and your `state`, or with `error=access_denied` if they cancel. Check that `state` is the one you sent, then trade the code within 5 minutes, from your server or the browser:

```
curl -X POST https://your-site/api/public/v1/token \
  -d '{"code":"tdc_...","redirect_uri":"https://example.com/callback"}'
```

The answer is `{"key": "tdp_...", "token_type": "Bearer", "name": ..., "slack_id": ...}`. Use the key with the calls above. A code works once, for the `redirect_uri` it was made for; trading it a second time also revokes the key it became. `redirect_uri` must use https, except on `localhost`. A site without a server should add PKCE: send `code_challenge`, the base64url SHA-256 of a random verifier, and send `code_verifier` with the code. The key shows under the person's Settings, API, named after your site, where they can revoke it. Each site keeps at most 5 keys per person; signing in again after that revokes the oldest. Banned accounts can't sign in.

<a id="hca-app"></a>
## Set up sign-in

1. Open Developer Apps on [auth.hackclub.com](https://auth.hackclub.com) and create an app with the `openid`, `profile`, and `slack_id` scopes.
2. Add `https://your-site/auth/callback` as its redirect URI.
3. Copy the app's client ID and client secret into the Worker's secrets.
4. Collect the Slack user ID of each superadmin for `ADMINS`: in Slack, open their profile, choose ⋮, then Copy member ID.

<a id="hosting-cost"></a>
## Hosting cost

`node worker/scripts/cost-model.ts [prompts per hour]` prints the monthly bill from named inputs, with Cloudflare's prices of 2026-11-22. For 15,488 people logging 109,759 engaged hours a month at 20 prompts an hour, it comes to about $10 a month after a year and $13 after three ($27 and $35 at 60 prompts an hour), against a $500 limit. Every record, every report, and the account log's older rows are kept in R2 for good; D1 keeps each person's newest few hundred log rows and the day totals, which pass D1's 10 GB limit in about year 6 unless old days are folded into months. The inputs are assumptions until measured against a real deploy.
