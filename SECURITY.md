# Security

Menagerie is intended for a single trusted Linux user and defaults to loopback.
It has no login, TLS, tenant isolation, or protection against malicious local
processes. An enabled LAN dashboard grants administration to trusted LAN peers.
Do not expose the dashboard or gateway to the public internet.

Runtime executables, source builds, model artifacts, and OCI images must come from
sources you trust. Review commands and pins before authorizing them. See
[operational trust boundaries](docs/operations.md#trust-and-security).

For a suspected vulnerability, use GitHub's private vulnerability reporting for
this repository if available. If it is unavailable, open an issue requesting a
private contact **without exploit details or private data**. Do not post tokens,
prompts, raw databases, identifying host details, or unredacted logs publicly.
