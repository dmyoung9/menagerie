# Release checklist

This page is for maintainers. It defines verification requirements, not a claim
that a particular host, engine, or release has passed them.

## Automated checks

1. Run the backend, frontend, and plugin checks in [development](development.md).
2. Build the wheel and source archive from the same reviewed checkout.
3. Check the installed wheel outside the checkout with temporary state.
4. Inspect **all** distribution contents,
   including source, package metadata, documentation, and test fixtures.
   Run `python -m scripts.check_distribution dist/*.whl dist/*.tar.gz` for bounded
   checks of credential-like literals, personal home paths, generated/private
   files, and nested archives. This is not an exhaustive secret or image scanner.
5. If installer code changed, run the opt-in container check with explicit local
    baseline and candidate artifacts; see [testing](testing.md).
6. For Windows, require the native installed-installer and real-subprocess checks,
   inspect the frozen payload (including embedded code and dependency notices),
   and pair the installer/checksum with its matching source archive. CI's synthetic
   older installer proves replacement/preservation, not historical compatibility.

Ordinary branch/PR CI checks and uploads build artifacts; explicitly pushed version
tags invoke the gated [release workflow](releasing.md). Old local
builds, uploaded CI artifacts, and distributed archives do not change when source
files are corrected. Rebuild candidates and review existing copies separately.

## Manual acceptance

On a disposable test installation, verify first-response onboarding, cancellation,
failure recovery, restart, service registration/removal, upgrade, rollback, and
uninstall that preserves model and registry data. Test keyboard navigation,
mobile layout, and assistive technology separately from automated accessibility
checks. Live inference requires separate authorization and is never a CI step.

Report compatibility only for the platform, engine build, model format, and
workflow actually exercised. Fake runtimes and intercepted APIs cannot establish
GPU compatibility, memory fit, thermal safety, context limits, or model quality.
Upstream release discovery does not certify newly discovered builds.

Windows delivery additionally needs a clean Windows 11 installation without
developer prerequisites and an authorized RTX 5060 acceptance run. Capture exact
OS, application, driver, engine/backend and model versions, plus sanitized results
for onboarding, streaming, cancellation, stop/reopen and upgrade/removal. Record
actual security prompts and unresolved blockers; do not disable host protection
or assume code-signing credentials exist. These target-host results remain open
until linked evidence is supplied.

## Publication review

- Use synthetic examples. Exclude personal paths, host/network identifiers,
  application inventories, credentials, live screenshots, and raw diagnostics.
- Keep implementation references in contributor documentation; keep user guides
  focused on supported workflows, limitations, and recovery.
- Verify links, CLI examples, version alignment, dependency/artwork licenses,
  corresponding source, and wheel/checksum pairing before publication.
- Obtain release assets through a trusted channel. Checksums establish integrity,
  not publisher identity. Never distribute repository credentials.
- Publish only after explicit authorization. Credential rotation, history rewriting,
  remote artifact removal, and repository visibility changes are separate actions.
