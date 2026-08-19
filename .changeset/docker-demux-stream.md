---
'@vercel/agent-eval': patch
---

Fix corrupted command output from the Docker sandbox on large reads. Docker
multiplexes stdout and stderr into a single framed stream, and frames split
across `data` events at arbitrary byte offsets. The hand-rolled parser read each
chunk in isolation, so any frame straddling a chunk boundary was mis-read,
silently dropping and corrupting bytes (a 512KB `cat` came back short). Framing
is now delegated to docker-modem's `demuxStream()`.
