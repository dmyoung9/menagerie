# Testing and isolation

This page is for contributors. Ordinary checks use synthetic data, temporary
state, fake runtimes, and mocked upstream APIs. They must work without personal
credentials, a model library, an installed client, GPU hardware, or LAN devices.
Dependency installation and builds can require network access; test execution
must not silently use external services.

## Ordinary suites

- `tests/test_*.py`: backend behavior, API contracts, lifecycle with fake runtimes,
  and packaging. The shared fixture isolates HOME/XDG/cache state and permits only
  loopback sockets. Hardware collection is replaced with synthetic telemetry.
- `frontend/tests/*.test.ts`: frontend logic with explicit inputs/mocked transport.
- `frontend/tests/browser/`: a fresh browser context and dedicated Vite server;
  mocked API responses and a network allowlist. Unexpected API requests fail.
- `plugins/opencode/discovery.test.ts`: in-memory SDK/transport behavior.

Run commands from [development](development.md). Screenshots/traces from the
maintained browser suite contain fixtures only and stay under ignored
`frontend/test-results/`. They must never be produced from a personal browser
profile. Legacy fixture runners in `smoke_*.js` use the documented fixture-server
port in each file; run them only in a fresh browser context. They do not save
screenshots. Captures belong only to the maintained fixture suite.
Catalog and dashboard smoke coverage lives in the maintained browser suite;
there is no automatic live-dashboard screenshot runner.

## Opt-in integration checks

These are not ordinary test-suite prerequisites and are never run implicitly:

| Command | Side effects and requirements |
| --- | --- |
| `python -m scripts.check_opencode` | Installed OpenCode V2; temporary config and fake loopback catalog; no inference. SDK dependency resolution may need internet. |
| `bash scripts/check_linux_install.sh BASELINE_WHEEL CANDIDATE_WHEEL` | Docker and network downloads into a disposable container; no host install, repository authentication, GPU, or inference. Baseline and candidate must have different content. |
| `python -m scripts.check_container IMAGE` | Explicit locally built Docker image; disposable network/volume and synthetic state; verifies non-root operation, restart/replacement, shutdown and network boundaries. No GPU or inference. Also runs in CI. |
| `python -m scripts.smoke_opencode --approve` | Downloads a CPU engine and small model; performs real inference with temporary application/client state. |
| `python -m scripts.smoke_vllm --approve` | Downloads a GPU runtime/model and uses GPU capacity with temporary state. |
| `python tests/live_acceptance.py --gateway-port PORT --alias ALIAS --approve` | Targets an existing gateway. Requests may load models and evict eligible deployments under saved policy. Does not edit configuration. |

Run Python integration checks with the intended environment's interpreter. Review
resource and network costs before approving live checks. They summarize outcomes;
raw runtime logs, complete client events, host telemetry, and credentials must not
be printed as routine test results. Temporary directories are not a security
sandbox: live runtimes still execute trusted code under the invoking account.

## New tests and publication

Keep fixtures demonstrably synthetic. A private-address literal used by an ASGI
transport is not a connection to a real device; do not replace it with a discovered
address. Preserve meaningful behavioral assertions when removing environment
coupling. Use explicit local artifact inputs rather than an authenticated release
download. Add regression checks for isolation and safe output when changing helpers.

Inspect wheel and source archives before distributing them. Ignored
files and CI artifacts are not automatically safe to publish. See the
[release checklist](release-validation.md) for acceptance and publication boundaries.
