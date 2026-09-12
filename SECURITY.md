# Security and privacy

This project handles guest names, phone numbers, email addresses, dietary notes,
and private RSVP links. Treat every generated guest file as sensitive.

- Never commit `scripts/guests.csv`, `scripts/import.csv`, `scripts/sms.csv`,
  `scripts/seed.sql`, `.dev.vars`, or environment files.
- Store `DASHBOARD_PIN` with `wrangler secret put`, not in source control.
- Use a long, randomly generated dashboard credential. The dashboard is a
  convenience admin tool, not a complete identity system.
- Limit `ALLOWED_ORIGINS` to the exact production frontend origin and local
  development origins you use.
- Do not publish a real guest database or screenshots of the dashboard.
- Before making a derived repository public, scan its entire Git history—not
  only the current files—for names, phone numbers, raw RSVP links, and secrets.

Report vulnerabilities privately to the maintainer of your deployed copy.
