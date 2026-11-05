# Job Autopilot

A personal job-search and application system for **Frontend / React** roles, with a separate track for **AI prompting / AI application development** roles where your real skills fit.

It turns your resume into a verified profile, finds current openings, scores each one against your background and preferences, writes a **fact-checked tailored resume** (PDF + DOCX) and cover letter for every good match, applies within the rules you set (review-before-submit or automatic), and reports exactly what happened, in a dashboard and a daily digest.

```
resume upload → profile extraction → (you verify) → job discovery → matching → tailoring → application handling → status reporting
```

> **Your data stays yours.** Resumes, profile, answers and screenshots are encrypted at rest on your own server. Nothing personal is stored in this repository. Never commit `.env` or `data/`.

---

## What works today

| Capability | Status | Notes |
|---|---|---|
| Resume upload (PDF / DOCX / TXT) → editable profile | ✅ Working | Rule-based parser; optional Claude extraction (every extracted item must appear verbatim in your resume). |
| Profile verification gate | ✅ Working | Tailoring uses only verified facts; auto-submit is off until you verify. |
| Job discovery: **Greenhouse, Lever, Ashby, SmartRecruiters** | ✅ Working (official public APIs) | Add any company by pasting its careers URL. Removed postings are detected and closed. |
| Job discovery: **Remotive, Remote OK** | ✅ Working (public APIs) | Remote roles; credited and linked back as their terms require. |
| Job discovery: **Adzuna** (India and other countries, keyword + city) | ✅ Working with a free API key | Best coverage of Indian job boards available through an API. |
| LinkedIn / Naukri / Indeed / Wellfound | ⚠️ Manual import | No public APIs that allow this. Paste a job (Jobs → *Add a job manually*) or import JSON; scoring and tailoring work the same. |
| Duplicate detection across sources and runs | ✅ Working | Company + title + location fingerprint, per-source IDs, past-application import. |
| Fit scoring + explanation + missing requirements + hard eligibility conflicts | ✅ Working | Separate Frontend and AI tracks. ML-research roles are flagged unless your profile shows ML experience. |
| Tailored resume (reorder/emphasis) + change summary + gaps | ✅ Working | Never adds skills, employers, dates, metrics or achievements. Automated fact-checker on every version. |
| AI-assisted rewording + cover letters (Claude) | ✅ Optional | Each rewrite is fact-checked; violations are rejected and the original wording kept. |
| ATS-friendly PDF + editable DOCX + TXT | ✅ Working | Single column, real text, embedded Unicode font (₹, dashes). |
| **Greenhouse** hosted application forms | ✅ Automated (browser) | Questions read up-front via the official API. |
| **Lever** hosted application forms | ✅ Automated (browser) | Questions parsed from the public apply page. |
| Other ATSs (Ashby, SmartRecruiters, Workday, company sites, job boards) | ⚠️ Prepared, you submit | Tailored resume, cover letter and answers ready; one click to mark submitted with evidence. |
| Review-before-submit and automatic modes, dry run, daily limit, pause switch | ✅ Working | Defaults: **review mode, dry run ON**. |
| Sensitive questions (work authorization, sponsorship, salary, legal, EEO) | ✅ Never guessed | Answered only from your saved Answer bank; otherwise **Needs input**. |
| CAPTCHA / login / verification handling | ✅ Stops and notifies | Never solved or bypassed. |
| Duplicate-submission prevention, crash safety, confirmation evidence | ✅ Working | Atomic claim + write-ahead "submit clicked" marker. Unconfirmed submissions are flagged for you to verify and never retried. |
| Dashboard, notifications (email, Telegram, ntfy push, Slack/Discord webhook), daily digest | ✅ Working | "Submitted" is only ever reported with confirmation evidence. |
| Persistent scheduler | ✅ Working | Runs on your server (not in a chat session). Optional GitHub Actions wake-up for sleeping hosts. |
| Data export and **Delete all my data** | ✅ Working | Settings → Data & privacy. |

**Verification:** 86 automated tests. The end-to-end tests drive real Chromium against local mock Greenhouse and Lever forms. They check that dry runs never submit, real submissions save confirmation evidence, applications are never sent twice, possible duplicates are flagged, CAPTCHA and login walls stop the run, submissions without confirmation are marked uncertain and never retried, required fields the system has no answer for go to Needs input, crash recovery works, and the digest counts only confirmed submissions. The live ATS selectors follow the current public form layouts. **Run one dry run per ATS on a real posting before turning dry-run off** (see below).

---

## Quick start (local)

Requirements: **Node.js 22.13+**.

```bash
git clone https://github.com/mahamaharati-lgtm/Job.git && cd Job
npm install
npx playwright install chromium        # browser for automated applications
cp .env.example .env                   # set ADMIN_PASSWORD at least
npm run dev                            # API on :8080, dashboard on http://localhost:5173
```

Production-style run: `npm run build && npm start` → <http://localhost:8080>.

### First-time setup (≈10 minutes)

1. **Resumes → Upload resume.** Use a text-based PDF or DOCX.
2. **Profile & answers → Candidate profile.** Check every field against your real resume. Add LinkedIn if you want it used. Click **Verify profile**.
3. **Profile & answers → Answer bank.** Save your answers for work authorization (per country), sponsorship, notice period, salary expectation (optional), and voluntary EEO questions (e.g. "Decline to self-identify"). Anything you leave empty makes those applications wait in *Needs input*.
4. **Settings → Search preferences.** Cities, remote regions, level, employment type, salary floor, exclusions. These are prefilled from your resume (e.g. Bengaluru, India, INR).
5. **Settings → Job sources.** Paste careers URLs of companies you like (Greenhouse, Lever, Ashby or SmartRecruiters). Add Adzuna keys for India-wide keyword search.
6. **Run now.** Review matches, tailored resumes and fit explanations.
7. Try a **Dry run** on a Greenhouse or Lever job and check the screenshot. When you are happy, go to **Settings → Automation**, choose **Automatic** and turn **Dry run off**.

---

## How automatic mode decides

An application is submitted without asking you **only if all** of these hold:

- automation is not paused, mode is **Automatic**, and dry run is **off**;
- your profile is **verified**;
- the match score is at or above your threshold (default 70), and there are **no hard eligibility conflicts** (seniority, years required, location/remote region, work authorization, employment type, excluded company or keyword, ML-research);
- the job's track is allowed for auto-submit (default: Frontend only);
- **every required question** is answered from your verified profile or saved answers;
- the form is a supported Greenhouse or Lever form, the posting is still open, and no CAPTCHA, login or verification step appears;
- you are under your **daily limit** (default 10), and you have not already applied to the same company and title.

Anything else goes to **Needs review** or **Needs input**, with the reason shown and a notification sent.

Statuses: **Found → Matched → Resume ready → Needs review / Needs input → Submitted**, plus **Failed** (nothing was sent, safe to retry) and **Closed** (posting gone or dismissed). An attempt where submit was clicked but no confirmation appeared is shown as *Needs review: verify submission*. It is never retried automatically.

---

## Configuration

All secrets come from environment variables; see [`.env.example`](.env.example). User preferences live in the dashboard.

| Variable | Required | Purpose |
|---|---|---|
| `ADMIN_PASSWORD` or `ADMIN_PASSWORD_HASH` | **Yes** (prod) | Dashboard login. Hash with `npm run cli -- hash-password '<pw>'`. |
| `DATA_ENCRYPTION_KEY` | **Yes** (prod) | AES-256-GCM key material for data at rest (`openssl rand -base64 32`). Back it up. |
| `PUBLIC_URL` | Recommended | Links in notifications. |
| `APP_TIMEZONE` | Recommended | e.g. `Asia/Kolkata` (digest time, daily limit). |
| `ADZUNA_APP_ID`, `ADZUNA_APP_KEY` | Recommended | Free key, India-wide keyword search. |
| `ANTHROPIC_API_KEY` | Optional | Claude-assisted extraction, rewording and cover letters (default model `claude-opus-5-5`, configurable). |
| `SMTP_*` | Optional | Email notifications and digest. |
| `TELEGRAM_BOT_TOKEN` | Optional | Telegram notifications. |
| `CRON_SECRET` | Optional | Protects `POST /api/internal/tick` for an external scheduler. |

CLI: `npm run cli -- gen-key | hash-password | run [steps] | upload-resume <file> | verify-profile | import <jobs.json> | digest [--send] | delete-all-data --yes`.

---

## Deploy (recurring searches need an always-on server)

The scheduler runs inside the server process, so the server must stay up with a persistent disk. Recommended options:

- **Fly.io** (`fly.toml`, Mumbai region, 1 GB RAM), **Render** (`render.yaml`, paid instance with a disk), **Railway**, or
- **Any VPS** with Docker: `docker compose up -d` behind Caddy/nginx for HTTPS.

Step-by-step instructions: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Integration details: [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md). Security model: [docs/SECURITY.md](docs/SECURITY.md).

---

## Limitations (honest list)

- **No candidate-side submission APIs exist** for Greenhouse/Lever/Ashby (their submit APIs need the employer's key), so automation uses a normal browser on the hosted form. Employers can change their forms. The system stops instead of guessing, but **validate with a dry run** first.
- Sites with **invisible CAPTCHAs** may reject automated submissions. These end up as "verify submission", never as false successes.
- **LinkedIn, Naukri, Indeed, Wellfound and Workday** are not automated. There are no permitted APIs for this, and scraping them breaks their terms. Import those jobs manually and apply yourself with the prepared materials.
- Starter ATS boards in `src/server/sources/registry.ts` are suggestions. If a company changed ATS, its source shows "Board not found". Remove it, or add the right careers URL.
- Your experience entries have no bullet points, so tailoring can only reorder what exists, mostly your project. Add real responsibilities to your resume to improve both matching and tailoring.
- For AI roles, your verified profile currently lists **no LLM or prompt-engineering experience**, so those roles show that gap and score lower. Add it to your resume if you have it. The system will not assume it.

## Development

```bash
npm run typecheck && npm test      # 86 tests (unit + Playwright end-to-end against mock ATS forms)
```

Stack: React 19 + TypeScript + Vite (dashboard) · Fastify 5 + TypeScript (API) · SQLite built into Node 22 · Playwright (applications) · pdfkit/docx (documents) · optional Anthropic SDK.

License: MIT. Bundled Inter font: SIL Open Font License (`assets/fonts/OFL.txt`).
