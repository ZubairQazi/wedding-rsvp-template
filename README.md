# Wedding website and private RSVP template

A customizable, static wedding website with a Cloudflare Worker and D1 backend.
It includes a home page, multi-event schedule, invite-code RSVP flow, protected
admin dashboard, guest import tools, and optional Twilio invitations.

This repository contains only fictional example content and placeholder artwork.
Create a new repository from it so your real guest data never shares Git history
with the public template.

## What is included

```text
site/                 Static HTML, CSS, JavaScript, and admin dashboard
worker/               Cloudflare Worker API written in TypeScript
scripts/              Guest-token, D1 import, and optional Twilio SMS tools
schema.sql            Cloudflare D1 schema
.github/workflows/    GitHub Pages deployment for the frontend
```

The public API supports invite lookup and RSVP submission. Admin routes support
dashboard reporting, response updates, household and guest management, and RSVP
code regeneration. Raw invite codes are never stored in D1; only SHA-256 hashes
are stored.

## Prerequisites

- Node.js 20 or newer
- A Cloudflare account for Workers and D1
- A GitHub repository if you want GitHub Pages hosting
- A Twilio account only if you want to send invitation texts

## 1. Make your private working copy

Do not add real guest information to a public repository. Create a private repo
from this template, then clone that private copy.

```bash
git clone https://github.com/YOURUSERNAME/YOUR-PRIVATE-WEDDING-REPO.git
cd YOUR-PRIVATE-WEDDING-REPO
```

The `.gitignore` excludes known PII-bearing and generated files. Keep those
rules in your private copy.

## 2. Customize the frontend

Replace the fictional values in these files:

| File | Update |
| --- | --- |
| `site/index.html` | names, dates, location, photo captions |
| `site/schedule/index.html` | event names, dates, times, descriptions |
| `site/rsvp/index.html` | names, dates, RSVP copy |
| `site/js/home.js` | `WEDDING_DATE` |
| `site/js/rsvp.js` | `API_BASE`, `EVENT_META`, `EVENT_ORDER`, demo data |
| `site/dashboard/index.html` | `API_BASE`, `PUBLIC_RSVP_URL`, event/source labels, SMS copy |
| `worker/src/index.ts` | matching allowed event keys and optional source labels |
| `worker/wrangler.toml` | Worker name, D1 ID, allowed origins, date |

Replace the SVGs in `site/assets/` with your own licensed artwork and photos, or
remove the corresponding image elements. Do not commit private photos to the
public template repository.

Event keys must match in the frontend, dashboard, Worker, guest CSV, and D1
records. The example keys are `welcome`, `ceremony`, and `farewell`. Source codes
`A` and `B` are optional planning labels for the two sides of the guest list.

Preview the static site:

```bash
python3 -m http.server 5050 --directory site
```

Open `http://localhost:5050/`. Use `http://localhost:5050/rsvp/?demo=1` to try
the RSVP UI without a backend.

## 3. Create and configure Cloudflare D1

Install the Worker dependencies and authenticate:

```bash
cd worker
npm install
npx wrangler login
npx wrangler d1 create your-wedding-rsvp
```

Copy the returned database ID into `worker/wrangler.toml`. Keep the binding name
as `DB`, then initialize the remote database:

```bash
npx wrangler d1 execute your-wedding-rsvp --remote --file=../schema.sql
```

For local Worker development, initialize the local D1 database and run Wrangler:

```bash
npm run db:migrate:local
npm run dev
```

For a full local integration test, temporarily set `API_BASE` in
`site/js/rsvp.js` and `site/dashboard/index.html` to `http://localhost:8787`.

## 4. Protect and deploy the Worker

Set a long, randomly generated dashboard credential as a Worker secret:

```bash
npx wrangler secret put DASHBOARD_PIN
```

Set `ALLOWED_ORIGINS` in `worker/wrangler.toml` to exact origins, without paths.
For example:

```toml
[vars]
ALLOWED_ORIGINS = "https://YOURUSERNAME.github.io,http://localhost:5050"
WEDDING_DATE = "2027-09-18"
```

Deploy and copy the resulting Worker URL into both frontend `API_BASE` constants:

```bash
npm run type-check
npm run deploy
```

Never put `DASHBOARD_PIN`, Cloudflare tokens, or Twilio credentials in source
files or `wrangler.toml`.

## 5. Prepare and import guests

Copy the fictional CSV and edit the ignored copy:

```bash
cp scripts/guests.csv.example scripts/guests.csv
```

CSV columns:

```text
household_label,phone_e164,guest_name,events,source_list
```

- Use one row per guest.
- Reuse the same E.164 phone number to group guests into one household.
- Separate multiple event keys with `|`.
- Use source `A` or `B`, or leave it blank.

Generate invite codes and import SQL. Pass the public RSVP page—not the home
page—as the base URL:

```bash
node scripts/generate_tokens.mjs \
  --input=scripts/guests.csv \
  --base-url=https://YOURUSERNAME.github.io/YOUR-REPO/rsvp

node scripts/import_to_d1.mjs --output=scripts/seed.sql
cd worker
npx wrangler d1 execute your-wedding-rsvp --remote --file=../scripts/seed.sql
```

Generated files contain guest PII or usable invitation credentials and are
ignored by Git:

- `scripts/import.csv`: names, phone numbers, and token hashes
- `scripts/sms.csv`: names, phone numbers, raw invite codes, and RSVP URLs
- `scripts/seed.sql`: database seed data

Back them up securely. The raw invite codes cannot be recovered from D1.

## 6. Optional: send invitation texts with Twilio

First edit `buildMessage()` in `scripts/send_sms_twilio.mjs`. Then:

```bash
cd scripts
npm install
export TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
export TWILIO_AUTH_TOKEN=your_auth_token
export TWILIO_FROM=+15550001234

node send_sms_twilio.mjs --dry-run
node send_sms_twilio.mjs --confirm --to=+15550001234
node send_sms_twilio.mjs --confirm
```

Use a Twilio Messaging Service instead of `TWILIO_FROM` by setting
`TWILIO_MESSAGING_SERVICE_SID`. Review applicable consent and messaging rules
before contacting guests.

## 7. Publish the frontend with GitHub Pages

The included workflow publishes only `site/`.

1. Push the private customized repository to GitHub.
2. Open **Settings → Pages**.
3. Set **Source** to **GitHub Actions**.
4. Run the “Deploy frontend to GitHub Pages” workflow.
5. Add the resulting origin to `ALLOWED_ORIGINS`, update `PUBLIC_RSVP_URL`, and
   redeploy the Worker.

The dashboard lives at `/dashboard/`. It is hidden from navigation but is not
secret merely because the URL is unlisted; the Worker credential is the access
control.

## Privacy checklist before every push

```bash
git status --short
git ls-files scripts
rg -n -i "phone|token|address|@|workers\\.dev" . \
  -g '!node_modules/**' -g '!package-lock.json'
```

Confirm that only the fictional example CSV is tracked, no real media is
present, all deployment IDs are placeholders, and no generated guest files were
ever committed. If PII enters Git history, removing the current file is not
enough; rewrite the history or create a fresh repository before making it public.

See [SECURITY.md](SECURITY.md) for deployment-specific guidance.

## License

MIT
