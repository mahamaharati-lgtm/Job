# Security & privacy

- **This repository contains no personal data.** Your resume, profile, answers, tailored resumes, screenshots and settings live only in `DATA_DIR` on your server, which is gitignored.
- **Encryption at rest:** AES-256-GCM (authenticated) for original and tailored resumes, cover letters, the profile, saved answers, per-application answers, evidence screenshots/HTML, and notification settings (chat IDs, webhook URLs). The key comes from `DATA_ENCRYPTION_KEY` (scrypt-derived). In development a key is generated in `DATA_DIR/.encryption-key`; production refuses to start without the variable.
- **Secrets** (`ADMIN_PASSWORD`, API keys, SMTP and Telegram credentials) are read only from environment variables. They are never stored in the database, sent to the browser or written to logs.
- **Logs** redact emails, phone numbers, long tokens, `key=value` secrets and every configured secret value. The code never logs resume content or answers.
- **Dashboard access:** single-user password (scrypt hash supported) → random session token in an `HttpOnly; SameSite=Strict` cookie (`Secure` behind HTTPS); only a SHA-256 hash of the token is stored. Login is rate-limited.
- **CSRF:** all state-changing API calls require a custom header (cross-site requests cannot add it), plus SameSite=Strict cookies.
- **Headers:** strict Content-Security-Policy, `X-Frame-Options: SAMEORIGIN`, `nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` on the API.
- **No third-party account credentials are stored.** If an employer site requires login, the system stops and asks you to apply manually.
- **Deletion:** Settings → Data & privacy → *Delete all my data* (or `npm run cli -- delete-all-data --yes`) wipes every table and every stored file. *Export* downloads your data as JSON first if you want a copy.
- **Sensitive answers are never guessed:** work authorization, sponsorship, salary and compensation, notice period, start date, relocation, years of experience, legal declarations and consent, background checks, and voluntary demographic questions are answered only from your Answer bank or what you type for a specific application.
