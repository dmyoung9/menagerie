# Release process (maintainers)

Publication is an explicit action: merging code does not publish a release.
No step changes repository/package visibility, rewrites tags, removes previous
artifacts, or updates a live installation. Keep private distributions private
until the owner separately approves public visibility.

## Prepare

1. Update the project version, `controlplane/version.py`, frontend/plugin package
   manifests and root lock entries, installer defaults, Unraid image tag, current
   documentation examples and `uv.lock` together. Use a new semantic version;
   do not replace an existing release/tag. Catalog schema versions are independent.
2. Add user-facing notes at `docs/releases/VERSION.md`, including meaningful
   limitations. Do not include personal environment reports or raw diagnostics.
3. Run current checks and build wheel/source from the same reviewed revision.
   `python -m scripts.prepare_release --tag vVERSION` validates version alignment,
   exports locked runtime constraints and prepares installer/template/checksums.
4. Inspect nested distribution contents with `scripts.check_distribution`. Follow
   [release validation](release-validation.md), including installed-artifact and
   authorized disposable-container checks. No real inference runs in CI.
5. Integrate the reviewed change into main. Obtain authorization to tag/publish.

## Publish

Create and push an annotated `vVERSION` tag at the reviewed main revision. The
Release workflow calls the full Checks workflow before publishing. It builds the
Linux amd64 image from the inspected wheel with pinned base-image digests and
locked Python dependency constraints. OS package updates still require a rebuild;
this is not a claim of byte-identical image reproducibility.

The job uses its repository-scoped `GITHUB_TOKEN` for GitHub assets and GHCR; no
personal token is stored in source or distributed. A new GHCR package is private
by default. An existing public package paired with a private repository causes
publication to fail rather than silently publishing private-source artifacts.
GitHub package creation/linkage policies can block the workflow; resolve those
with the owner without changing visibility or introducing embedded credentials.

After image publication succeeds, the workflow creates a draft GitHub release,
uploads exact matching artifacts, then publishes it. Published assets include:

- versioned wheel and corresponding source archive;
- `install.sh` and `menagerie-unraid.xml`;
- versioned runtime dependency constraints;
- individual `.sha256` files and aggregate `SHA256SUMS`;
- `container-image.txt`, recording the immutable image digest.

Both `ghcr.io/OWNER/menagerie:VERSION` and `:latest` identify the release image;
deployments should prefer a version or digest. No public PyPI publication or
Community Applications submission happens automatically. If publication fails,
inspect the run and rerun reviewed jobs; do not move a tag or overwrite a published
release to hide a failure.

## Verify and hand off

Confirm the tag/commit, release assets/checksums, image digest, package visibility
and source/license availability. Test pull/install using authorized access. Keep
Unraid hardware acceptance open until target-host results are supplied, with CPU,
acceleration and telemetry distinguished. An image build and synthetic network/
persistence checks are not evidence of actual GPU serving.
