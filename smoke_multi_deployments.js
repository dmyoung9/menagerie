// Pool-first multi-deployment smoke. Isolated frontend at :8038; all API
// traffic is intercepted. No live mutations.
async page => {
  await page
    .context()
    .route(
      '**/*',
      (route) =>
        new URL(route.request().url()).origin ===
        'http://127.0.0.1:8038'
          ? route.continue()
          : route.abort(),
    );
  await page.unroute('**/api/**');
  const assert = (value, text) => {
    if (!value) throw new Error(text);
  };
  const errors = [],
    writes = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (e) => {
    if (
      e.type() === 'error' &&
      !e.text().startsWith('Failed to load resource:')
    )
      errors.push(e.text());
  });

  // --- Fixture state ---
  const poolName = 'Shared pool',
    slugify = (t) =>
      t
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'pool';
  let pools = [],
    members = [],
    createdMemberIds = [],
    started = false;
  const host = {
    ts: 1700000000,
    gpus: [
      {
        index: 0,
        name: 'GPU 0',
        total_mib: 16384,
        free_mib: 5000,
        used_mib: 11384,
        headroom_mib: 2048,
      },
    ],
    ram_total_mib: 32000,
    ram_available_mib: 24000,
    ram_headroom_mib: 4096,
    deployments: {},
  };
  const profile = {
    id: 'profile',
    name: 'Model settings',
    revision: 1,
    config: { 'ctx-size': 32768, parallel: 1 },
    catalog: { model: { limit: { context: 32768 } } },
    artifact_id: 'weights',
    runtime_id: 'engine',
    raw_args: [],
  };
  const models = [
    { id: 'qwen-weights', revision: 1, name: 'Qwen 9B', format: 'gguf' },
    { id: 'gemma-weights', revision: 1, name: 'Gemma E4B', format: 'gguf' },
  ];
  const runtimes = [
    {
      id: 'engine',
      revision: 1,
      name: 'Example engine',
      engine: 'llama.cpp',
      execution_kind: 'native',
      capabilities: {
        formats: ['gguf'],
        flags: ['models-preset'],
        schema: {},
      },
    },
  ];

  // Estimate shape must satisfy the launchPlan.resourceEstimate contract:
  // basis is constrained to observed/derived/engine/unavailable and the plan
  // requires a provenance plus a profile hash.
  const est = (peakMib) => ({
    peak_mib: peakMib,
    ram_mib: 512,
    file_size_bytes: 8 * 1024 ** 3,
    kv_mib: 1024,
    basis: 'observed',
    sample_count: 3,
    provenance: 'launch-validate',
    profile_hash: 'profile-1',
  });

  const baseMember = (id, name, alias, state) => ({
    id,
    name,
    alias,
    state,
    revision: 1,
    residency: 'on-demand',
    priority: 50,
    idle_timeout: 300,
    allow_eviction: true,
    queue_timeout: 300,
    port: null,
    gpu: 0,
    enabled: true,
    member_availability: true,
    multi_model: true,
    inflight: 0,
    reservation_mib: 0,
    profile_snapshot: {},
    lifecycle: { serving: true },
  });

  // The /api/serving_deployments view: pools carry their member rows; orphans
  // (standalone) members are their own "unit" with multi_model false.
  const serving = () => [
    ...pools.map((p) => ({
      ...p,
      members: members.filter((m) => p.member_ids.includes(m.id)),
    })),
    ...members
      .filter((m) => !new Set(pools.flatMap((p) => p.member_ids)).has(m.id))
      .map((m) => ({
        ...m,
        multi_model: false,
        member_ids: [m.id],
        members: [m],
        inflight: 0,
      })),
  ];

  await page.route('**/api/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname,
      body = req.method() === 'POST' ? req.postDataJSON() : null;
    if (body) writes.push({ path, body, url: req.url() });
    const send = (value, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(value),
      });
    const findPool = (id) => pools.find((p) => p.id === id);
    const findMember = (id) => members.find((m) => m.id === id);

    // --- GET ---
    if (path === '/api/status')
      return send({
        version: '3.0.0',
        csrf_token: 'fixture',
        host,
        settings: {
          gpu_headroom_mib: 2048,
          ram_headroom_mib: 4096,
          temperature_limit: 80,
          max_queue: 4,
          sample_seconds: 10,
          retention_days: 30,
          summary_days: 7,
          history_quota_mib: 1024,
          expose_on_demand: true,
        },
        queue: 0,
        gateway: 'http://127.0.0.1:8042',
        gateway_url: 'http://127.0.0.1:8042',
        state_path: '/var/lib/menagerie/state.db',
        deployments: members,
        serving_deployments: serving(),
      });
    if (path === '/api/registry/deployments') return send(members);
    if (path === '/api/registry/profiles') return send([profile]);
    if (path === '/api/registry/models') return send(models);
    if (path === '/api/registry/runtimes') return send(runtimes);
    if (path === '/api/registry/jobs') return send([]);
    if (path === '/api/integration/opencode')
      return send({ endpoint: 'http://127.0.0.1:8001/v1' });
    if (path === '/api/events/stream')
      return route.fulfill({
        contentType: 'text/event-stream',
        body: ': ready\n\n',
      });
    if (/^\/api\/deployment-sets$/.test(path)) {
      // Pool creation: the PoolWizard posts engine_pool:true with empty members.
      assert(body.engine_pool === true, 'Pool creation must flag engine_pool');
      const id = slugify(body.name);
      const pool = {
        ...body,
        id,
        enabled: body.enabled ?? false,
        multi_model: true,
        revision: 1,
        state: 'STOPPED',
        member_ids: [],
        members: [],
        lifecycle: { serving: body.enabled ?? false },
      };
      assert(pools.every((p) => p.name !== pool.name), 'Duplicate pool name');
      pools.push(pool);
      return send(pool);
    }
    const poolMatch = path.match(/^\/api\/deployment-sets\/([^/]+)$/);
    if (poolMatch && path === '/api/deployment-sets/' + poolMatch[1] + '/configuration')
      return send(findPool(poolMatch[1]) || {});
    if (poolMatch) {
      const pool = findPool(poolMatch[1]);
      if (!pool) return send({ error: 'Pool not found' }, 404);
      // member removal: /api/deployment-sets/{id}/members/{memberId}/remove
      if (path.match(/^\/api\/deployment-sets\/[^/]+\/members\/[^/]+\/remove$/)) {
        const memberId = path.split('/')[6];
        pool.member_ids = pool.member_ids.filter((m) => m !== memberId);
        members = members.filter((m) => m.id !== memberId);
        return send(pool);
      }
      if (path.endsWith('/logs')) {
        const logMember = new URL(req.url()).searchParams.get('requestedMember');
        return send({
          text:
            logMember && findMember(logMember)
              ? findMember(logMember).name + ' log'
              : pool.name + ' log',
        });
      }
      return send({ ...pool, members: members.filter((m) => pool.member_ids.includes(m.id)) });
    }
    const memberMatch = path.match(/^\/api\/deployments\/([^/]+)$/);
    if (memberMatch) {
      const memberId = memberMatch[1];
      const suffix = path.slice(path.length - memberId.length - 1);
      if (suffix === '') return send(findMember(memberId) || { error: 'Not found' }, findMember(memberId) ? 200 : 404);
      if (suffix === '/pending')
        return send({ pending: false });
      if (suffix === '/validate')
        return send({
          errors: [],
          warnings: ['Low-confidence estimate'],
          stops: [],
          estimates: { qwen: est(4096), gemma: est(2048) },
          plan_token: 'member-' + memberId + '-token',
        });
      if (suffix === '/logs') return send({ text: (findMember(memberId) || { name: memberId }).name + ' log' });
      return send({ error: 'Unexpected route ' + path }, 500);
    }
    if (path.startsWith('/api/serving-deployments/')) {
      const pool = findPool(
        path.slice('/api/serving-deployments/'.length).split('/')[0],
      );
      if (pool) {
        const suffix = path.slice('/api/serving-deployments/'.length + pool.id.length);
        if (suffix === '') return send(pool);
        if (suffix === '/validate')
          return send({
            errors: [],
            warnings: ['Low-confidence estimate'],
            stops: [],
            estimates: { qwen: est(4096), gemma: est(2048) },
            plan_token: 'pool-' + pool.id + '-token',
          });
        if (suffix === '/start') {
          assert(
            body && body.plan_token === 'pool-' + pool.id + '-token',
            'Launch must approve the reviewed pool plan',
          );
          started = true;
          host.deployments = { qwen: { gpu_mib: 4096 }, gemma: { gpu_mib: 2048 } };
          pool.state = 'READY';
          members.forEach((m) => (m.state = 'READY'));
          return send({ state: 'QUEUED' });
        }
        if (suffix === '/enabled') {
          assert(pool, 'Cannot enable a member without its pool');
          const member = findMember(pool.member_ids[0]);
          if (member) member.enabled = body.enabled;
          return send({ enabled: body.enabled });
        }
        if (suffix === '/stop') {
          pool.state = 'STOPPED';
          members.forEach((m) => (m.state = 'STOPPED'));
          return send({ state: 'UNLOADING' });
        }
      }
    }
    // POST /api/serving-deployments/{id}/enabled (member enable/disable)
    const memberEnable = path.match(
      /^\/api\/(serving-deployments|deployments)\/([^/]+)\/enabled$/,
    );
    if (memberEnable) {
      const member = findMember(memberEnable[2]);
      if (member) {
        member.enabled = body.enabled;
        return send({ enabled: body.enabled });
      }
    }
    if (path === '/api/model-setups') {
      if (body?.pool_id) {
        const pool = findPool(body.pool_id);
        assert(pool, 'Joining a pool that does not exist');
        const memberId = slugify(body.name) + '-' + Date.now();
        const member = {
          ...baseMember(memberId, body.name, body.name || slugify(body.name), 'STOPPED'),
          ...body,
          id: memberId,
          unit_id: pool.id,
          runtime_id: body.runtime_id || pool.runtime_id || 'engine',
          // Members inherit the pool's device exactly; null means the pool
          // uses its default device. No numeric fallback so the member
          // cannot diverge from the pool.
          gpu: body.gpu ?? pool.gpu,
          port: null,
          member_availability: true,
          multi_model: true,
          profile_snapshot: {
            artifact_id: body.artifact_id,
            runtime_id: body.runtime_id || pool.runtime_id || 'engine',
            config: body.config || {},
            raw_args: body.raw_args || [],
            catalog: body.catalog || {},
          },
        };
        members.push(member);
        pool.member_ids.push(memberId);
        createdMemberIds.push(memberId);
        return send(member);
      }
      // Standalone member (not used by the new wizard; kept for the API surface).
      const memberId = slugify(body.name) + '-' + Date.now();
      const member = {
        ...baseMember(memberId, body.name, body.name, 'STOPPED'),
        ...body,
        id: memberId,
        port: null,
        member_availability: true,
        multi_model: false,
        profile_snapshot: {
          artifact_id: body.artifact_id,
          runtime_id: body.runtime_id || 'engine',
          config: body.config || {},
          raw_args: body.raw_args || [],
          catalog: body.catalog || {},
        },
      };
      members.push(member);
      return send(member);
    }
    return send({ error: 'Unexpected route ' + path }, 500);
  });

  const openWizard = async (name, poolId) => {
    await page.locator('.page-head').getByRole('button', { name: 'New deployment', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expectVisible(dialog);
    return dialog;
  };

  const expectVisible = (locator) =>
    new Promise((resolve) =>
      locator
        .waitFor({ state: 'visible', timeout: 15000 })
        .then(() => resolve()),
    );
  // Wait until the locator's count equals `count`; the modal closes after an
  // async perform() completes, so immediate count() checks race the close.
  const waitForCount = (locator, count, timeout = 5000) => {
    let start = Date.now();
    return new Promise((resolve, reject) => {
      const tick = async () => {
        try {
          if ((await locator.count()) === count) return resolve();
        } catch (e) {}
        if (Date.now() - start > timeout)
          return reject(new Error('Timed out waiting for count ' + count));
        setTimeout(tick, 50);
      };
      tick();
    });
  };

  // --- 1. Create the pool (New pool -> PoolWizard -> Create pool) ---
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('http://127.0.0.1:8038/#/deployments');
  await page.reload();
  const head = page.locator('.page-head');
  assert(await head.getByRole('button', { name: 'New pool', exact: true }).count() === 1, 'No "New pool" button in page head');
  assert(await head.getByRole('button', { name: 'New deployment', exact: true }).count() === 1, 'No "New deployment" button in page head');
  assert(await head.getByRole('button', { name: 'Add model', exact: true }).count() === 0, '"Add model" button should be retired');
  await head.getByRole('button', { name: 'New pool', exact: true }).click();
  const poolWizard = page.getByRole('dialog');
  assert(await poolWizard.getByText('New pool', { exact: true }).count() === 1, 'Pool wizard not opened');
  assert(await poolWizard.getByLabel('Shared installed engine').count() === 1, 'Shared installed engine select missing');
  await poolWizard.getByRole('textbox', { label: 'Name' }).fill(poolName);
  await poolWizard.getByLabel('Shared installed engine').selectOption({ label: 'Example engine' });
  await poolWizard.getByLabel('Serving port', { exact: true }).fill('9120');
  await poolWizard.getByLabel('Serving port', { exact: true }).blur();
  assert(await poolWizard.getByRole('button', { name: 'Create pool', exact: true }).isEnabled(), 'Create pool disabled after fill');
  const poolCreate = poolWizard.getByRole('button', { name: 'Create pool', exact: true });
  await poolCreate.click();
  assert(pools.length === 1, 'Pool not created');
  assert(pools[0].name === poolName, 'Wrong pool name created');
  assert(pools[0].engine_pool === true, 'Pool not flagged as engine pool');
  assert(pools[0].member_ids.length === 0, 'New pool must start empty');
  await page.waitForTimeout(300);
  const createdPoolId = pools[0].id;
  // Pool creation navigates to the pool detail.
  assert(page.url().includes('/deployments/' + createdPoolId), 'Pool creation did not navigate to detail');
  assert(await page.locator('.page-head').getByRole('button', { name: 'New deployment', exact: true }).count() === 0, 'Page head should not offer New deployment on the pool detail');
  await page.goto('http://127.0.0.1:8038/#/deployments');

  // --- 2. Create two members that join the pool ---
  const joinMember = async (modelLabel, memberName) => {
    await page.goto('http://127.0.0.1:8038/#/deployments');
    await page.locator('.page-head').getByRole('button', { name: 'New deployment', exact: true }).click();
    const dialog = page.getByRole('dialog');
    // Step 0 (Choose model): pick the model explicitly.
    assert(await dialog.getByLabel('Model', { exact: true }).count() === 1, 'Model select missing in step 0');
    await dialog.getByLabel('Model', { exact: true }).selectOption({ label: modelLabel });
    assert(await dialog.getByRole('button', { name: 'Continue', exact: true }).isEnabled(), 'Continue disabled in step 0');
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
    // Step 1 (Review setup): name + pool.
    assert(await dialog.getByLabel('Name', { exact: true }).count() === 1, 'Name field missing in step 1');
    await dialog.getByLabel('Name', { exact: true }).fill(memberName);
    assert(
      await dialog.getByLabel('Pool', { exact: true }).count() === 1,
      'Pool select missing in step 1',
    );
    assert(
      await dialog.getByLabel('Pool name', { exact: true }).count() === 0,
      'Inline "Pool name" field must be gone',
    );
    assert(
      await dialog.getByLabel('Serving port', { exact: true }).count() === 0,
      'Inline "Serving port" field must be gone',
    );
    const poolOption = dialog.getByLabel('Pool', { exact: true });
    assert(await poolOption.locator(`option[value="pool:${createdPoolId}"]`).count() === 1, 'Pool not offered for joining');
    await poolOption.selectOption({ label: 'Join pool: ' + poolName });
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
    // Step 2 (Make available): save without loading.
    assert(
      await dialog.getByRole('button', { name: 'Make available without loading', exact: true }).count() === 1,
      'Make available without loading missing',
    );
    await dialog.getByRole('button', { name: 'Make available without loading', exact: true }).click();
    const outcome = page.locator('.dialog-body', { hasText: memberName + ' is available' });
    await expectVisible(dialog.getByText(memberName + ' is available', { exact: true }));
    // The wizard stays open on the completion screen; close it (dirty -> discard).
    await page.keyboard.press('Escape');
    const discard = page.getByRole('alertdialog');
    assert(await discard.count() === 1, 'Expected a discard dialog when closing a dirty wizard');
    await discard.getByRole('button', { name: 'Discard changes', exact: true }).click();
    // Wizard closes on discard; the Base UI dialog stays mounted but hidden,
    // so wait until it is no longer visible rather than expecting it to be gone.
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll('[role="dialog"]')).every(
          (d) => {
            const style = window.getComputedStyle(d);
            return (
              style.display === 'none' ||
              style.visibility === 'hidden' ||
              d.offsetWidth === 0
            );
          },
        ),
      undefined,
      { timeout: 15000 },
    );
    const lastId = createdMemberIds.slice(-1)[0];
    assert(lastId, 'No member id recorded for join');
    assert(writes.filter((w) => w.path === '/api/model-setups' && w.body.pool_id === createdPoolId).length > 0, 'Member join must POST pool_id to /api/model-setups');
    assert(!writes.filter((w) => w.path === '/api/model-setups' && w.body.pool).some(Boolean), 'Wizard must not POST an inline pool spec');
    return lastId;
  };
  const qwenId = await joinMember('Qwen 9B', 'Qwen');
  const gemmaId = await joinMember('Gemma E4B', 'Gemma');

  // --- 3. Shared policy: members inherit the pool's runtime/device; no port ---
  assert(members.length === 2, 'Expected two members');
  assert(
    members.every((m) => m.port === null),
    'Pooled members must carry no port (pool owns it)',
  );
  assert(
    members.every((m) => m.runtime_id === pools[0].runtime_id),
    'Members must inherit the pool runtime',
  );
  assert(
    members.every((m) => m.gpu === pools[0].gpu),
    'Members must inherit the pool device',
  );
  assert(pools[0].member_ids.sort().join(',') === [qwenId, gemmaId].sort().join(','), 'Pool must own both members');
  assert(members.every((m) => m.unit_id === createdPoolId), 'Members must be bound to the pool');

  // --- 4. Member-only configuration: no Availability card in the member
  //     editor. Members are joined dynamically (unlike the browser suite's
  //     static fixture members), so reload to get a fresh mount whose initial
  //     slice fetch picks the member up in the flat deployments list.
  await page.goto('http://127.0.0.1:8038/#/deployments/' + qwenId + '/configuration');
  await page.reload();
  const config = page.locator('form.configuration-editor');
  await expectVisible(config);
  assert(await config.getByRole('heading', { name: 'Availability', exact: true }).count() === 0, 'Member editor must not show an Availability card');
  assert(await config.getByRole('heading', { name: 'Identity', exact: true }).count() === 1, 'Identity card missing');
  assert(await config.getByRole('heading', { name: 'Model & runtime', exact: true }).count() === 1, 'Model & runtime card missing');

  // --- 5. Unified list + expandable members ---
  await page.goto('http://127.0.0.1:8038/#/deployments');
  const listPool = page.getByText(poolName, { hasText: false });
  assert(await listPool.count() > 0, 'Pool not visible in unified list');
  assert(await page.getByText('Qwen', { exact: true }).count() > 0, 'Qwen member not in list');
  assert(await page.getByText('Gemma', { exact: true }).count() > 0, 'Gemma member not in list');
  // The standalone member table (orphan rows) should not leak; only the pool shows.
  assert(await page.getByRole('button', { name: 'Enabled (1)', exact: true }).count() === 1, 'Expected one enabled pool');
  assert(await page.getByRole('button', { name: 'Enabled (2)', exact: true }).count() === 0, 'Members must not be listed as separate enabled pools');

  // --- 6. Per-member enable/disable ---
  const poolCard = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText(poolName, { exact: true }) });
  // Find the Qwen member's Enable/Disable button.
  const qwenMemberCell = poolCard.getByRole('row').filter({
    has: page.getByText('Qwen', { exact: true }),
  });
  const memberToggle = qwenMemberCell.getByRole('button', {
    name: /Enable|Disable/,
  });
  assert(await memberToggle.count() === 1, 'Member enable/disable button missing');
  await memberToggle.click();
  // The confirmation is the generic app Dialog (role "dialog"), not an
  // alertdialog; it is titled "Disable <member>" when turning a member off.
  // It closes after perform() resolves, so wait for it rather than count().
  const enableModal = page.getByRole('dialog');
  await waitForCount(enableModal, 1, 5000);
  await expectVisible(enableModal.getByRole('button', { name: 'Disable', exact: true }));
  await enableModal.getByRole('button', { name: 'Disable', exact: true }).click();
  assert(members.find((m) => m.id === qwenId).enabled === false, 'Member not disabled via POST /enabled');
  await waitForCount(page.getByRole('dialog'), 0, 5000);
  // Re-enable.
  const qwenToggle = qwenMemberCell.getByRole('button', { name: /Enable|Disable/ });
  assert(await qwenToggle.count() === 1, 'Qwen toggle missing after disable');
  await qwenToggle.click();
  await waitForCount(page.getByRole('dialog'), 1, 5000);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Enable', exact: true })
    .click();
  assert(members.find((m) => m.id === qwenId).enabled === true, 'Member not re-enabled');
  await waitForCount(page.getByRole('dialog'), 0, 5000);

  // --- 7. Combined admission review + whole-unit launch ---
  const loadBtn = poolCard.getByRole('button', { name: 'Load', exact: true });
  assert(await loadBtn.count() === 1, 'Pool Load button missing');
  await loadBtn.click();
  const review = page.getByRole('dialog', { name: 'Review launch', exact: true });
  await expectVisible(review);
  assert(await review.getByRole('button', { name: 'Load', exact: true }).isEnabled(), 'Launch Load button disabled without errors/stops');
  await review.getByRole('button', { name: 'Load', exact: true }).click();
  assert(started, 'Pool start not submitted');
  assert(writes.some((w) => w.path === '/api/serving-deployments/' + createdPoolId + '/start' && w.body.plan_token), 'Start must submit the pool plan token');
  // Degraded state: a failed member pushes the pool into DEGRADED.
  const poolObj = pools.find((p) => p.id === createdPoolId);
  poolObj.state = 'DEGRADED';
  members.find((m) => m.id === gemmaId).state = 'FAILED';
  await page.reload();
  // Wait for the pool's degraded badge to re-render after the reload.
  await expectVisible(page.getByText('Degraded', { exact: true }));
  assert(members.some((m) => m.state === 'FAILED'), 'Fixture member not marked failed');

  assert(!errors.length, 'Page errors: ' + errors.join('\n'));
  // Count the meaningful writes: 1 pool + 2 member joins (+ 1 enabled toggle x2).
  const apiWrites = writes.filter((w) =>
    w.path === '/api/deployment-sets' ||
    w.path === '/api/model-setups' ||
    w.path.endsWith('/start') ||
    w.path.endsWith('/enabled'),
  );
  assert(apiWrites.length === 6, 'Expected 6 writes (pool, 2 joins, 2 toggles, start), got ' + apiWrites.length + ': ' + apiWrites.map((w) => w.path).join(', '));
  return {
    result: 'passed',
    checks: [
      'pool creation via New pool',
      'two members joined via New deployment',
      'shared pool runtime/device; member port null',
      'member-only configuration (no Availability card)',
      'unified pool list with members',
      'per-member enable/disable',
      'whole-unit launch review',
      'member failed -> degraded pool',
    ],
    writesIntercepted: writes.length,
  };
}