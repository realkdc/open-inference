import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

async function waitForGateway(url, child, readOutput) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error('Gateway exited before startup. ' + readOutput());
    try {
      const response = await fetch(url + '/healthz', { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch { /* Wait for the local listener to open. */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Gateway did not become ready. ' + readOutput());
}

async function jsonRequest(base, path, options = {}) {
  const response = await fetch(base + path, options);
  const body = response.status === 204 ? undefined : await response.json();
  return { response, body };
}

test('gateway isolates workspaces and never crosses the private/community boundary', { timeout: 20_000 }, async t => {
  const upstreamRequests = [];
  const upstream = createServer(async (request, response) => {
    let rawBody = '';
    for await (const part of request) rawBody += part;
    const body = rawBody ? JSON.parse(rawBody) : undefined;
    upstreamRequests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
    response.setHeader('content-type', 'application/json');

    if (request.headers.authorization !== 'Bearer private-fixture-key') {
      response.writeHead(401).end(JSON.stringify({ error: 'bad fixture credential' }));
      return;
    }
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.end(JSON.stringify({ object: 'list', data: [
        { id: 'private-model', object: 'model' },
        { id: 'private-light-model', object: 'model' }
      ] }));
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      const prompt = JSON.stringify(body?.messages ?? []);
      if (prompt.includes('private-upstream-offline')) {
        response.writeHead(503).end(JSON.stringify({ error: 'fixture unavailable' }));
        return;
      }
      if (body?.stream === true) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end([
          'data: ' + JSON.stringify({ id: 'chat-stream', object: 'chat.completion.chunk', created: 1, model: 'private-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'private stream' }, finish_reason: null }] }),
          '',
          'data: [DONE]',
          '',
          ''
        ].join('\n'));
        return;
      }
      response.end(JSON.stringify({
        id: 'chat-private', object: 'chat.completion', created: 1, model: 'private-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'private answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 }
      }));
      return;
    }
    response.writeHead(404).end(JSON.stringify({ error: 'not found' }));
  });

  const upstreamPort = await listen(upstream);
  const portProbe = createServer();
  const gatewayPort = await listen(portProbe);
  await new Promise(resolve => portProbe.close(resolve));
  const dataDirectory = await mkdtemp(join(tmpdir(), 'open-inference-gateway-'));
  const gatewayFile = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  const adminToken = 'test-admin-token-that-is-longer-than-32-chars';
  const child = spawn(process.execPath, [gatewayFile], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(gatewayPort),
      DATABASE_PATH: join(dataDirectory, 'gateway.sqlite'),
      OPENINFERENCE_ADMIN_TOKEN: adminToken,
      PRIVATE_UPSTREAM_URL: 'http://127.0.0.1:' + upstreamPort + '/v1',
      PRIVATE_UPSTREAM_API_KEY: 'private-fixture-key',
      PRIVATE_DAILY_LIMIT_UNITS: '120',
      MODEL_COMPUTE_WEIGHTS: '{"private-model":2,"private-light-model":1}',
      MESHLLM_INVITE_TOKEN: '',
      MESHLLM_ADMISSION_POLICY_VERIFIED: 'false',
      MESHLLM_TRUSTED_OWNER_IDS: 'a'.repeat(64),
      MAX_CONTEXT_TOKENS: '512',
      MAX_INPUT_TOKENS: '128',
      DEFAULT_MAX_COMPLETION_TOKENS: '16',
      HARD_MAX_COMPLETION_TOKENS: '32'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let processOutput = '';
  child.stdout.setEncoding('utf8').on('data', value => { processOutput += value; });
  child.stderr.setEncoding('utf8').on('data', value => { processOutput += value; });

  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    if (child.exitCode === null) {
      await Promise.race([
        once(child, 'exit'),
        new Promise(resolve => setTimeout(resolve, 3_000))
      ]);
    }
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
    await new Promise(resolve => upstream.close(resolve));
    await rm(dataDirectory, { recursive: true, force: true });
  });

  const base = 'http://127.0.0.1:' + gatewayPort;
  await waitForGateway(base, child, () => processOutput);

  async function createWorkspace(name) {
    const invite = await jsonRequest(base, '/admin/invites', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + adminToken, 'content-type': 'application/json' },
      body: JSON.stringify({ expiresInHours: 1 })
    });
    assert.equal(invite.response.status, 201);
    const claim = await jsonRequest(base, '/api/invites/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inviteToken: invite.body.token, workspaceName: name })
    });
    assert.equal(claim.response.status, 201);
    return claim.body;
  }

  async function createKey(dashboardToken, mode, label) {
    const result = await jsonRequest(base, '/api/keys', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + dashboardToken, 'content-type': 'application/json' },
      body: JSON.stringify({ mode, label })
    });
    assert.equal(result.response.status, 201);
    return result.body;
  }

  const workspaceA = await createWorkspace('Workspace A');
  const workspaceB = await createWorkspace('Workspace B');
  const privateKeyA = await createKey(workspaceA.dashboardToken, 'private', 'private A');
  const privateKeyB = await createKey(workspaceB.dashboardToken, 'private', 'private B');

  const communityStatus = await jsonRequest(base, '/api/community/status');
  assert.equal(communityStatus.response.status, 200);
  assert.equal(communityStatus.body.available, false);
  assert.equal(communityStatus.body.reason, 'join_code_missing');
  assert.deepEqual(communityStatus.body.blockers, ['join_code_missing']);
  assert.deepEqual(Object.keys(communityStatus.body).sort(), ['available', 'blockers', 'connected', 'message', 'reason']);

  const admissionInfo = await jsonRequest(base, '/api/community/admission');
  assert.equal(admissionInfo.response.status, 200);
  assert.equal(admissionInfo.body.admissionVerified, false);
  assert.deepEqual(admissionInfo.body.trustedOwnerIds, ['a'.repeat(64)]);
  assert.equal(admissionInfo.body.gatewayOwnerId, null);

  const hostOwnerId = 'c'.repeat(64);
  const approvedHost = await jsonRequest(base, '/admin/mesh/owners', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + adminToken, 'content-type': 'application/json' },
    body: JSON.stringify({ ownerId: hostOwnerId, label: 'Test host' })
  });
  assert.equal(approvedHost.response.status, 201);
  const updatedAdmission = await jsonRequest(base, '/api/community/admission');
  assert.deepEqual(updatedAdmission.body.trustedOwnerIds, ['a'.repeat(64), hostOwnerId]);
  const duplicateHost = await jsonRequest(base, '/admin/mesh/owners', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + adminToken, 'content-type': 'application/json' },
    body: JSON.stringify({ ownerId: hostOwnerId, label: 'Duplicate' })
  });
  assert.equal(duplicateHost.response.status, 409);
  const revokedHost = await fetch(base + '/admin/mesh/owners/' + hostOwnerId, {
    method: 'DELETE',
    headers: { authorization: 'Bearer ' + adminToken }
  });
  assert.equal(revokedHost.status, 204);
  const revokedAdmission = await jsonRequest(base, '/api/community/admission');
  assert.deepEqual(revokedAdmission.body.trustedOwnerIds, ['a'.repeat(64)]);

  const communityKey = await jsonRequest(base, '/api/keys', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + workspaceA.dashboardToken, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'community', label: 'community A' })
  });
  assert.equal(communityKey.response.status, 201);
  assert.equal(communityKey.body.mode, 'community');

  const beforeUnavailableCommunityCatalog = upstreamRequests.length;
  const unavailableCommunityModels = await jsonRequest(base, '/v1/models', {
    headers: { authorization: 'Bearer ' + communityKey.body.secret }
  });
  assert.equal(unavailableCommunityModels.response.status, 503);
  assert.equal(unavailableCommunityModels.body.error.code, 'pool_unavailable');
  assert.equal(upstreamRequests.length, beforeUnavailableCommunityCatalog);

  const unavailableCommunityCompletion = await jsonRequest(base, '/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + communityKey.body.secret, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'community-model', messages: [{ role: 'user', content: 'must-not-be-forwarded' }] })
  });
  assert.equal(unavailableCommunityCompletion.response.status, 503);
  assert.equal(unavailableCommunityCompletion.body.error.code, 'pool_unavailable');
  assert.equal(upstreamRequests.length, beforeUnavailableCommunityCatalog);

  const communityKeyOnPrivate = await jsonRequest(base, '/private/v1/models', {
    headers: { authorization: 'Bearer ' + communityKey.body.secret }
  });
  assert.equal(communityKeyOnPrivate.response.status, 403);
  assert.equal(upstreamRequests.length, beforeUnavailableCommunityCatalog);

  const beforePrivateCatalog = upstreamRequests.length;
  const privateModels = await jsonRequest(base, '/private/v1/models', {
    headers: { authorization: 'Bearer ' + privateKeyA.secret }
  });
  assert.equal(privateModels.response.status, 200);
  assert.equal(privateModels.body.data[0].id, 'private-model');
  assert.equal(upstreamRequests.length, beforePrivateCatalog + 1);

  const beforeCommunityFailure = upstreamRequests.length;
  const privateKeyOnCommunity = await jsonRequest(base, '/v1/models', {
    headers: { authorization: 'Bearer ' + privateKeyA.secret }
  });
  assert.equal(privateKeyOnCommunity.response.status, 403);
  assert.equal(upstreamRequests.length, beforeCommunityFailure);

  const prompt = 'private-prompt-sentinel-' + Date.now();
  const privateCompletion = await jsonRequest(base, '/private/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + privateKeyA.secret, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'private-model', messages: [{ role: 'user', content: prompt }], max_completion_tokens: 1, session_id: 'must-not-forward' })
  });
  assert.equal(privateCompletion.response.status, 200);
  assert.equal(privateCompletion.body.choices[0].message.content, 'private answer');
  const forwardedBody = upstreamRequests.find(entry => entry.url === '/v1/chat/completions')?.body;
  assert.match(JSON.stringify(forwardedBody.messages), new RegExp(prompt));
  assert.equal('session_id' in forwardedBody, false);

  const completionRequestCount = () => upstreamRequests.filter(entry => entry.url === '/v1/chat/completions').length;
  const beforeOversizedTools = completionRequestCount();
  const oversizedTools = await jsonRequest(base, '/private/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + privateKeyA.secret, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'private-model',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 'lookup', description: 'x'.repeat(700), parameters: { type: 'object', properties: {} } } }],
      max_completion_tokens: 1
    })
  });
  assert.equal(oversizedTools.response.status, 400);
  assert.equal(oversizedTools.body.error.code, 'input_limit_exceeded');
  assert.equal(completionRequestCount(), beforeOversizedTools, 'oversized tool schemas must not be forwarded to the model');

  const streamedPrivate = await fetch(base + '/private/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + privateKeyA.secret, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'private-model', messages: [{ role: 'user', content: 'stream me' }], max_completion_tokens: 1, stream: true })
  });
  const streamedBody = await streamedPrivate.text();
  assert.equal(streamedPrivate.status, 200);
  assert.match(streamedBody, /private stream/);
  assert.match(streamedBody, /\[DONE\]/);

  const offlinePrivate = await jsonRequest(base, '/private/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + privateKeyA.secret, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'private-model', messages: [{ role: 'user', content: 'private-upstream-offline' }], max_completion_tokens: 1 })
  });
  assert.equal(offlinePrivate.response.status, 502);

  const crossWorkspaceRevocation = await fetch(base + '/api/keys/' + privateKeyA.id, {
    method: 'DELETE',
    headers: { authorization: 'Bearer ' + workspaceB.dashboardToken }
  });
  assert.equal(crossWorkspaceRevocation.status, 404);
  const workspaceBView = await jsonRequest(base, '/api/dashboard', {
    headers: { authorization: 'Bearer ' + workspaceB.dashboardToken }
  });
  assert.equal(workspaceBView.body.apiKeys.some(key => key.id === privateKeyA.id), false);
  const privateKeyBModels = await jsonRequest(base, '/private/v1/models', {
    headers: { authorization: 'Bearer ' + privateKeyB.secret }
  });
  assert.equal(privateKeyBModels.response.status, 200);

  const workspaceC = await createWorkspace('Workspace C');
  const privateKeyC = await createKey(workspaceC.dashboardToken, 'private', 'weighted usage');
  async function makeTinyCompletion(model) {
    return jsonRequest(base, '/private/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + privateKeyC.secret, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'x' }], max_completion_tokens: 1 })
    });
  }
  const weightedCompletion = await makeTinyCompletion('private-model');
  const lightCompletion = await makeTinyCompletion('private-light-model');
  assert.equal(weightedCompletion.response.status, 200);
  assert.equal(lightCompletion.response.status, 200);
  const workspaceCView = await jsonRequest(base, '/api/dashboard', {
    headers: { authorization: 'Bearer ' + workspaceC.dashboardToken }
  });
  const weightedUnits = workspaceCView.body.usage.find(row => row.model === 'private-model')?.usedUnits;
  const lightUnits = workspaceCView.body.usage.find(row => row.model === 'private-light-model')?.usedUnits;
  assert.ok(weightedUnits > 0);
  assert.ok(lightUnits > 0);
  assert.equal(weightedUnits, lightUnits * 2, 'the configured model weight doubles usage for the same prompt');

  let quotaRejected;
  let additionalAccepted = 0;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const result = await makeTinyCompletion('private-model');
    if (result.response.status === 429) {
      quotaRejected = result;
      break;
    }
    assert.equal(result.response.status, 200);
    additionalAccepted += 1;
  }
  assert.ok(additionalAccepted > 0);
  assert.equal(quotaRejected?.body.error.code, 'compute_limit_reached');

  const revoked = await fetch(base + '/api/keys/' + privateKeyA.id, {
    method: 'DELETE',
    headers: { authorization: 'Bearer ' + workspaceA.dashboardToken }
  });
  assert.equal(revoked.status, 204);
  const revokedUse = await jsonRequest(base, '/private/v1/models', {
    headers: { authorization: 'Bearer ' + privateKeyA.secret }
  });
  assert.equal(revokedUse.response.status, 401);
  assert.equal(processOutput.includes(prompt), false, 'gateway process output must not contain prompt text');
  assert.equal(processOutput.includes('must-not-forward'), false, 'gateway process output must not contain session identifiers');
  assert.equal(processOutput.includes('must-not-be-forwarded'), false, 'gateway process output must not contain rejected community prompts');
});
