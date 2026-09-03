---
"@vercel/agent-eval": patch
"@vercel/agent-eval-playground": patch
---

Honor `PORT` / `--port` / `-p` when launching the playground, and stop Next.js 16.3 from crashing on a stale shipped `.next` build. Published playground builds omit `routes-manifest.json#onMatchHeaders`; Next 16.2.4+ calls `.map()` on that field and dies with `Cannot read properties of undefined (reading 'map')`. The playground now writes an empty array before `next start`, and a `file:` / monorepo agent-eval checkout prefers the local playground bin.
