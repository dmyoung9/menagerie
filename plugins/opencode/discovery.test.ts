import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Context} from '@opencode/plugin/promise/plugin';
import {inventory, localEndpoint, startDiscovery} from './discovery.ts';
import {Effect, Layer} from 'effect';
import {HttpClientResponse, type HttpClientRequest} from 'effect/http';
import {AI} from '@opencode/ai/promise';
import {RequestExecutor} from '@opencode/ai/route';
import {OpenAICompatible} from '@opencode/ai/providers/openai-compatible';

function payload(id = 'model-a') {
  return {data: [{id, menagerie: {catalog: {version: 2, catalog_id: id, model: {
    name: 'Example', enabled: true, capabilities: {tools: true, input: ['text'], output: ['text']},
    limit: {context: 32768, output: 8192}, variants: [], cost: [{input: 0, output: 0, cache: {read: 0, write: 0}}],
  }}}}]};
}

test('declared identity, limits and capabilities survive the SDK schema', () => {
  const [model] = inventory(payload());
  assert.equal(model.providerID, 'menagerie');
  assert.equal(model.modelID, 'model-a');
  assert.equal(model.limit.context, 32768);
  assert.equal(model.capabilities.tools, true);
  assert.equal(model.enabled, true);
  assert.deepEqual(inventory({data: []}), []);
});

test('explicit reasoning variants and multimodal declarations survive SDK discovery', () => {
  const source = payload();
  const row = source.data[0];
  const variants = [{id: 'default', body: {}}, {id: 'instant', body: {chat_template_kwargs: {enable_thinking: false}}}, {id: 'high', body: {reasoning_effort: 'high'}}];
  const [model] = inventory({data: [{...row, menagerie: {catalog: {...row.menagerie.catalog, model: {
    ...row.menagerie.catalog.model, capabilities: {tools: true, input: ['text', 'image', 'audio'], output: ['text'], reasoning: {supported: true}},
    compatibility: {reasoningField: 'reasoning_content'}, variants,
  }}}}]});
  assert.deepEqual(model.variants, variants.filter(v => v.id !== 'default'));
  assert.deepEqual(model.capabilities.input, ['text', 'image', 'audio']);
  assert.equal(model.compatibility?.reasoningField, 'reasoning_content');
});

test('selected reasoning bodies reach the SDK wire request and Default clears the override', async () => {
  const row = payload().data[0];
  const variants = [{id: 'default', body: {}}, ...['low', 'medium', 'high'].map(id => ({id, body: {reasoning_effort: id}})),
    {id: 'instant', body: {chat_template_kwargs: {enable_thinking: false}}}];
  const [model] = inventory({data: [{...row, menagerie: {catalog: {...row.menagerie.catalog,
    model: {...row.menagerie.catalog.model, variants}}}}]});
  const captured: Record<string, any>[] = [];
  // In-memory transport: no connection to Menagerie, no GPU loading, no API credentials.
  const layer = Layer.succeed(RequestExecutor.Service, {execute: (request: HttpClientRequest.HttpClientRequest) => Effect.sync(() => {
    assert(request.body._tag === 'Uint8Array');
    captured.push(JSON.parse(new TextDecoder().decode(request.body.body)));
    const chunk = (delta: Record<string, unknown>, finish_reason: string | null) => 'data: ' + JSON.stringify({
      id: 'fixture', object: 'chat.completion.chunk', created: 0, model: model.modelID,
      choices: [{index: 0, delta, finish_reason}],
    }) + '\n\n';
    return HttpClientResponse.fromWeb(request, new Response(chunk({content: 'ok'}, null) + chunk({}, 'stop') + 'data: [DONE]\n\n', {
      headers: {'content-type': 'text/event-stream'},
    }));
  })});
  const ai = AI.make({layer});
  try {
    for (const id of ['low', 'medium', 'high', 'default', 'instant', 'default']) {
      const variant = model.variants.find(v => v.id === id);
      const response = await ai.llm.generate({model: OpenAICompatible.model(model.modelID, {
        baseURL: 'http://127.0.0.1:1/v1', apiKey: 'fixture-not-sent', body: variant?.body,
      }), prompt: 'Hello'});
      assert.equal(response.text, 'ok');
      const body = captured.at(-1)!;
      assert.equal(body.model, model.modelID);
      if (['low', 'medium', 'high'].includes(id)) assert.equal(body.reasoning_effort, id);
      else assert.equal(body.reasoning_effort, undefined);
      assert.deepEqual(body.chat_template_kwargs, id === 'instant' ? {enable_thinking: false} : undefined);
    }
  } finally {await ai.dispose();}
});

test('does not discard a legacy named default with actual request overrides', () => {
  const row = payload().data[0];
  const [model] = inventory({data: [{...row, menagerie: {catalog: {...row.menagerie.catalog,
    model: {...row.menagerie.catalog.model, variants: [{id: 'default', body: {reasoning_effort: 'medium'}}]}}}}]});
  assert.deepEqual(model.variants, [{id: 'default', body: {reasoning_effort: 'medium'}}]);
});

test('rejects incomplete, duplicate and malformed inventories atomically', () => {
  assert.throws(() => inventory({data: [{id: 'plain-openai-model'}]}));
  const data = payload().data[0];
  assert.throws(() => inventory({data: [data, data]}));
  const bad = payload();
  bad.data[0].menagerie.catalog.model.limit.output = 99999;
  assert.throws(() => inventory(bad));
  const badCost = payload();
  badCost.data[0].menagerie.catalog.model.cost[0].input = -1;
  assert.throws(() => inventory(badCost));
});

test('only loopback discovery; no credentials, redirects, query or remote URL', () => {
  assert.equal(localEndpoint('http://127.0.0.1:8028/v1/').pathname, '/v1/models');
  for (const url of ['https://example.com/v1', 'http://127.0.0.1:8001/other', 'http://user:pass@localhost/v1', 'http://localhost/v1?x=1'])
    assert.throws(() => localEndpoint(url));
});

function harness() {
  let transform: (editor: any) => void = () => {};
  let baseURL = 'http://127.0.0.1:8001/v1';
  let models: readonly any[] = [];
  let disposed = false;
  let reloads = 0;
  const logs: string[] = [];
  const editor = {
    get: () => ({provider: {settings: {baseURL}}}),
    add: (value: any) => {models = value.models;},
    models: {set: (_id: string, value: any[]) => {models = value;}},
  };
  const ctx = {provider: {
    transform: async (callback: typeof transform) => {transform = callback; transform(editor); return {dispose: async () => {disposed = true;}};},
    get: async () => ({data: {settings: {baseURL}}}),
    reload: async () => {reloads++; models = []; transform(editor);},
  }} as unknown as Context;
  return {ctx, logs, get models() {return models;}, get disposed() {return disposed;}, get reloads() {return reloads;},
    endpoint: (url: string) => {baseURL = url;}};
}

test('refresh, deduplication, outage retention, empty inventory and disposal', async () => {
  const h = harness();
  let data: unknown = payload();
  let fail = false;
  const discovery = await startDiscovery(h.ctx, {fetch: async (_url, options) => {
    assert.equal(options?.redirect, 'error');
    if (fail) throw new Error('secret remote details');
    return new Response(JSON.stringify(data));
  }, log: text => h.logs.push(text)});
  try {
    await discovery.refresh();
    assert.equal(h.models[0].id, 'model-a');
    await discovery.refresh();
    assert.equal(h.reloads, 1);
    fail = true;
    await discovery.refresh();
    await discovery.refresh();
    assert.equal(h.models.length, 1);
    assert.equal(h.logs.length, 1);
    assert(!h.logs[0].includes('secret'));
    h.endpoint('http://127.0.0.1:8028/v1');
    await discovery.refresh();
    assert.equal(h.models.length, 0, 'do not retain inventory from another endpoint');
    fail = false;
    data = {data: []};
    await discovery.refresh();
    assert.equal(h.models.length, 0);
  } finally {
    await discovery.dispose();
  }
  assert(h.disposed);
  await discovery.refresh();
});
