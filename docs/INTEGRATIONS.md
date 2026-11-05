# Integrations

## Job sources

| Source | Type | How it is accessed | Notes |
|---|---|---|---|
| Greenhouse | ATS board (one employer) | Official Job Board API `boards-api.greenhouse.io/v1/boards/<token>/jobs?content=true` | Complete listing → removed jobs are closed after 2 missed runs. |
| Lever | ATS board | Official Postings API `api.lever.co/v0/postings/<company>?mode=json` (EU: `api.eu.lever.co`) | Complete listing. |
| Ashby | ATS board | Official Posting API `api.ashbyhq.com/posting-api/job-board/<org>` | Complete listing; unlisted jobs skipped. |
| SmartRecruiters | ATS board | Official Posting API `api.smartrecruiters.com/v1/companies/<id>/postings` (+ detail per job) | Filtered by query, so absence is not treated as closure. |
| Remotive | Aggregator (remote) | Public API `remotive.com/api/remote-jobs` | Polled at most every 6 h; jobs link back to Remotive as required. |
| Remote OK | Aggregator (remote) | Public API `remoteok.com/api` | Jobs link back to Remote OK as required. |
| Adzuna | Aggregator (India + 15 countries) | Official API, free key | Descriptions are snippets; open the posting for full text. |
| Manual / JSON import | Any | Dashboard or `npm run cli -- import jobs.json` | For LinkedIn, Naukri, Indeed, Wellfound… which do not offer permitted APIs. |

**Add a company:** Settings → Job sources → paste a URL such as `https://jobs.lever.co/acme`, `https://boards.greenhouse.io/acme` or `https://jobs.ashbyhq.com/acme`. Use **Run now** on the source to validate it right away.

**Import format** (array, or `{ "jobs": [...] }`):

```json
[{ "title": "Frontend Developer", "company": "Acme", "location": "Bengaluru", "url": "https://…",
   "description": "Full job description…", "postedAt": "2026-11-01", "source": "linkedin" }]
```

Past applications (so the system never re-applies): Settings → Job sources → *Import* → *Past applications* with `[{ "company": "Acme", "title": "Frontend Engineer", "appliedAt": "2026-10-01" }]`.

## Application adapters

| Adapter | Questions known in advance | Submission | Confirmation evidence |
|---|---|---|---|
| Greenhouse | Yes, via `…/jobs/<id>?questions=true` (custom, EEO, GDPR consent) | Browser fills the hosted form `job-boards.greenhouse.io/<board>/jobs/<id>` | Confirmation page text + URL, full-page screenshot, page HTML |
| Lever | Yes, parsed from the public `…/apply` page (custom cards, EEO, consent) | Browser fills `jobs.lever.co/<company>/<id>/apply` | Thanks page + screenshot + HTML |
| Manual | — | You submit on the site | Your note and/or uploaded screenshot or email |

Browser automation behaviour:

- A normal Chromium. No stealth plugins, no fingerprint spoofing, no CAPTCHA solving.
- Stops on a CAPTCHA challenge (or on any CAPTCHA widget if you choose the stricter policy), on login walls, and on email or identity verification.
- Checks the form for **required fields it has no answer for** and moves the application to *Needs input* instead of submitting.
- Writes a "submit clicked" marker to the database **before** clicking. If the process dies, the attempt becomes "verify submission" and is never retried automatically.
- Only marks an application **Submitted** when a confirmation page or confirmation text is detected.
- Rate-limited: max per run, a delay between applications, and a daily limit.

### Validating against live forms (recommended before going live)

Employers can customise forms. For each ATS, open one real matched job → **Dry run**. Check the screenshot: every field should be filled correctly and nothing submitted. If a field is wrong or missing, the job goes to *Needs review: unsupported form*, and you apply manually with the prepared materials.

## Claude (optional)

With `ANTHROPIC_API_KEY` set, Claude (default `claude-opus-5-5`, effort `medium`; change with `ANTHROPIC_MODEL` / `ANTHROPIC_EFFORT`) is used for:

1. **Profile extraction.** The output is grounded: every skill, bullet, employer and project must appear verbatim in your resume text, otherwise it is dropped.
2. **Bullet and summary rewording** for a job. Each rewrite goes through the fact-checker (no new numbers, tools, named entities or scope-inflating verbs, and similar length). Rejected rewrites keep your original wording and are listed in the dashboard.
3. **Cover letters**, checked the same way. If a check fails, the template letter is used.

Server-side refusal fallback (`fallbacks: "default"`) is enabled. Any API error falls back to the deterministic path.

## Notifications

In-app always. Optional: email (SMTP), Telegram (bot token + chat id), ntfy (phone push, free), and a generic webhook (Slack/Discord-compatible). You choose which events notify you: needs input, needs review / blocked, submitted, failed, daily digest.
