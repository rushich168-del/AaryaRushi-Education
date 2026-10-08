# AaryaRushi Education

A learning platform for coaching institutes — public website, student portal (lessons, timed tests, results),
teacher/admin workspaces (question bank, test builder, printed-paper import with OCR, results) and online fee
payments with automatic enrolment.

This is a demo and portfolio project. All institute names, programs and contact details are placeholders.

**Stack:** React 19 · Vite 7 · Tailwind CSS 3 · Supabase (Postgres, Auth, Storage, Edge Functions) · Razorpay (test mode) · KaTeX · pdf.js · tesseract.js

## Re-branding

Everything brand-specific — name, tagline, logo, colours, contact details and centres — lives in
[`src/config/brand.js`](src/config/brand.js). Colours reach CSS through `--brand-*` variables and Tailwind's
`brand` / `accent` colours; `index.html` is filled from the same file at build time.

## Local development

```bash
npm install
cp .env.example .env.local   # VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
npm run dev
```

_Full setup, architecture notes and screenshots coming soon._
