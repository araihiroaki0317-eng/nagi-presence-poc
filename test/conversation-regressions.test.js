import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { HttpTextConversationProvider } from '../providers/http-text-provider.js';
import { ProviderConversationAdapter } from '../runtime/mock-conversation-adapter.js';
import { GatewayPairingClient } from '../providers/gateway-pairing-client.js';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('HTTP conversation carries successful prior exchanges, but not failed turns', async () => {
  const requests = [];
  const provider = new HttpTextConversationProvider({
    gatewayUrl: 'https://fake.test', accessTokenProvider: () => 'fake-token',
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      requests.push(request);
      if (request.input.content === '失敗') return Response.json({ error: { code: 'test_failure' } }, { status: 503 });
      return Response.json({ schema_version: '0.1', turn_id: request.turn_id,
        output: { text: '青ですね' }, provider: { id: 'fake', model: 'fake' } });
    },
  });
  const adapter = new ProviderConversationAdapter({ provider });
  await adapter.start('text_silent');
  adapter.sendContext('前回の会話');
  await adapter.sendText('好きな色は青です');
  await assert.rejects(adapter.sendText('失敗'));
  await adapter.sendText('私の好きな色は？');
  assert.match(requests.at(-1).context, /前回の会話/);
  assert.match(requests.at(-1).context, /ヒロ: 好きな色は青です/);
  assert.match(requests.at(-1).context, /凪: 青ですね/);
  assert.doesNotMatch(requests.at(-1).context, /失敗|私の好きな色は/);
  for (let i = 0; i < 10; i++) await adapter.sendText('長文'.repeat(1000));
  assert.ok(provider.history.length <= 8);
  assert.ok(requests.at(-1).context.length <= 3500 + '前回の会話\n\n'.length);
  await adapter.end();
  await adapter.start('text_silent');
  adapter.sendContext('復帰時のチェックポイント');
  await adapter.sendText('再開');
  assert.equal(requests.at(-1).context, '復帰時のチェックポイント');
});

test('cancelled pairing cannot save a token even if fetch ignores abort', async () => {
  const body = deferred();
  const saved = [];
  const controller = new AbortController();
  const client = new GatewayPairingClient({
    gatewayUrl: 'https://fake.test', tokenStore: { save: value => saved.push(value) },
    fetchImpl: async () => ({ ok: true, json: () => body.promise }),
  });
  const request = client.redeem('fake-code', { signal: controller.signal });
  const rejected = assert.rejects(request, { name: 'AbortError' });
  await tick();
  controller.abort();
  body.resolve({ token: 'must-not-save', expires_at: '2099-01-01' });
  await rejected;
  assert.equal(saved.length, 0);
});

// Execute the shipped UI handlers with fake DOM/transport boundaries. No browser,
// SDK import, network request, or paid provider is involved.
function ui() {
  const handlers = {};
  const sends = [];
  const redeems = [];
  const counts = { retries: 0, starts: 0, records: 0 };
  const context = {
    String, AbortController, sendingText: false, connecting: false,
    draftRevision: 0, pendingSubmittedDraft: null,
    pairingAttemptId: 0, pairingRequestController: null,
    pendingPairingProfile: 'text_silent', retryPendingAfterPairing: true,
    CONVERSATION_PROFILES: { TEXT_SILENT: 'text_silent' },
    currentRouteId: 'gateway-text', GATEWAY_TEXT_ROUTE_ID: 'gateway-text',
    conversationPanel: {}, unreadEl: {}, unreadCount: 0,
    textInput: { value: '送信文', style: {} },
    pairingPanel: { hidden: true, addEventListener: (_event, fn) => { handlers.submit = fn; } },
    pairingCancel: { addEventListener: (_event, fn) => { handlers.cancel = fn; } },
    pairingCode: { value: 'fake-code', focus() {} }, pairingSubmit: {}, pairingStatus: {},
    gatewayTokenStore: { clear() {} },
    pairingClient: { redeem: () => { const d = deferred(); redeems.push(d); return d.promise; } },
    gatewayAdapter: { active: true, retryPendingInput: async () => { counts.retries++; } },
    adapter: { active: true, sendText: () => { const d = deferred(); sends.push(d); return d.promise; } },
    recordTurn: async () => { counts.records++; },
    runtimeEvent() {}, sessionId: 'fake', setStatus() {}, renderState() {},
    debug() {}, friendlyError: () => 'error', pairingErrorMessage: () => 'error',
    isDeviceAuthError: error => error.code === 'device_token_expired',
    budgetNoticeFromError: () => null,
    requestPairing: () => { context.pairingPanel.hidden = false; },
    startConversation: async () => { counts.starts++; return true; },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function invalidatePairingRequest()'),
    source.indexOf('function textFallbackSelection()')), context);
  vm.runInContext(source.slice(source.indexOf('function clearSubmittedDraft('),
    source.indexOf('startVoiceBtn.addEventListener')), context);
  vm.runInContext(source.slice(source.indexOf("pairingPanel.addEventListener('submit'"),
    source.indexOf('inspectLogBtn.addEventListener')), context);
  return { context, handlers, counts, sends, redeems };
}

test('typing while waiting preserves the newer draft and overlapping sends are rejected', async () => {
  const { context: c, sends, counts } = ui();
  const first = c.sendTypedMessage(c.textInput.value);
  await tick();
  c.textInput.value = '次の下書き'; c.draftRevision++;
  await c.sendTypedMessage(c.textInput.value);
  assert.equal(sends.length, 1);
  assert.equal(counts.records, 1);
  sends[0].resolve(); await first;
  assert.equal(c.textInput.value, '次の下書き');
  assert.equal(c.sendingText, false);
});

test('only unchanged submitted drafts clear; editing back to same text is preserved', async () => {
  for (const edited of [false, true]) {
    const { context: c, sends } = ui();
    const first = c.sendTypedMessage(c.textInput.value);
    await tick();
    if (edited) c.draftRevision++;
    sends[0].resolve(); await first;
    assert.equal(c.textInput.value, edited ? '送信文' : '');
  }
});

test('cancelled pairing completion cannot reconnect or retry; a newer attempt still works', async () => {
  const { context: c, handlers, redeems, counts } = ui();
  c.pairingPanel.hidden = false;
  const old = handlers.submit({ preventDefault() {} });
  await handlers.submit({ preventDefault() {} });
  assert.equal(redeems.length, 1);
  handlers.cancel();
  c.pairingPanel.hidden = false;
  c.retryPendingAfterPairing = true;
  const fresh = handlers.submit({ preventDefault() {} });
  redeems[0].resolve({ expires_at: 'old' }); await old;
  assert.equal(counts.retries, 0);
  assert.equal(counts.starts, 0);
  assert.equal(c.pairingSubmit.disabled, true);
  redeems[1].resolve({ expires_at: 'new' }); await fresh;
  assert.equal(counts.retries, 1);
});

test('successful re-pairing retries pending input without erasing a newer draft', async () => {
  const { context: c, sends, handlers, redeems, counts } = ui();
  const send = c.sendTypedMessage(c.textInput.value);
  await tick();
  sends[0].reject(Object.assign(new Error('expired'), { code: 'device_token_expired' }));
  await send;
  c.textInput.value = '新しい下書き'; c.draftRevision++;
  const pairing = handlers.submit({ preventDefault() {} });
  redeems[0].resolve({ expires_at: 'new' }); await pairing;
  assert.equal(counts.retries, 1);
  assert.equal(c.textInput.value, '新しい下書き');
});
