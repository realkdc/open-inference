const inviteInput = document.querySelector('#invite');
const modelSelect = document.querySelector('#model-select');
const poolRoleInput = document.querySelector('#pool-role');
const acknowledge = document.querySelector('#acknowledge');
const inviteAcknowledge = document.querySelector('#invite-acknowledge');
const mapOptIn = document.querySelector('#map-opt-in');
const serviceUrlInput = document.querySelector('#service-url');
const hostTokenInput = document.querySelector('#host-token');
const regionInput = document.querySelector('#region');
const memoryBudgetElement = document.querySelector('#memory-budget');
const ownerIdElement = document.querySelector('#owner-id');
const copyOwnerIdButton = document.querySelector('#copy-owner-id');
const connectionStatus = document.querySelector('#connection-status');
const statePill = document.querySelector('#state-pill');
const startButton = document.querySelector('#start-sharing');
const pauseButton = document.querySelector('#pause');
const disconnectButton = document.querySelector('#disconnect');
let recommendedMemoryGb = null;
let localOwnerId = '';
const modelDescriptions = {
  'qwen3-8b': '5.0 GB model · 36 layers. Best first pool for gathering enough computers to serve reliably.',
  'qwen3-30b-a3b-thinking-2507': '17.7 GB split package · 48 layers. Larger reasoning model, separate computer pool, and likely slower replies.'
};

function setMessage(element, message, error = false) {
  element.textContent = message || '';
  element.classList.toggle('error', error);
}

function renderStatus(status) {
  const labels = {
    offline: 'Not connected',
    checking: 'Checking runtime',
    starting: 'Starting worker',
    connected: 'Waiting for model',
    contributing: 'Contributing compute',
    paused: 'Sharing paused',
    error: 'Needs attention'
  };
  statePill.textContent = labels[status.state] || 'Not connected';
  statePill.classList.toggle('online', status.state === 'contributing');
  statePill.classList.toggle('error', status.state === 'error');
  setMessage(connectionStatus, status.message, status.state === 'error');

  const busy = status.state === 'checking' || status.state === 'starting';
  const active = ['starting', 'connected', 'contributing'].includes(status.state);
  const connected = status.state === 'connected' || status.state === 'contributing';
  modelSelect.disabled = active || status.state === 'paused';
  poolRoleInput.disabled = active || status.state === 'paused';
  const mapReady = !mapOptIn.checked || (serviceUrlInput.value.trim() && hostTokenInput.value.trim() && regionInput.value);
  startButton.textContent = status.state === 'paused' ? 'Resume sharing' : 'Start contributing';
  startButton.disabled = busy || connected || (status.state !== 'paused' && (
    !inviteInput.value.trim() || !serviceUrlInput.value.trim() || !localOwnerId || !['coordinator', 'worker'].includes(poolRoleInput.value) || !acknowledge.checked || !inviteAcknowledge.checked || !mapReady || recommendedMemoryGb === null || recommendedMemoryGb < 0.5
  ));
  pauseButton.disabled = !active;
  disconnectButton.disabled = !active && status.state !== 'paused' && status.state !== 'error';
}

async function runAction(button, action, statusElement) {
  button.disabled = true;
  try {
    return await action();
  } catch (error) {
    setMessage(statusElement, error?.message || 'The action could not be completed.', true);
    return undefined;
  } finally {
    await window.hostApi.status().then(renderStatus).catch(() => undefined);
  }
}

for (const input of [inviteInput, modelSelect, poolRoleInput, acknowledge, inviteAcknowledge, mapOptIn, serviceUrlInput, hostTokenInput, regionInput]) {
  input.addEventListener('input', () => void window.hostApi.status().then(renderStatus));
  input.addEventListener('change', () => void window.hostApi.status().then(renderStatus));
}

modelSelect.addEventListener('change', () => {
  setMessage(document.querySelector('#model-details'), modelDescriptions[modelSelect.value] || 'Choose a supported model pool.');
});

startButton.addEventListener('click', () => runAction(startButton, async () => {
  if ((await window.hostApi.status()).state === 'paused') {
    const resumed = await window.hostApi.resume();
    renderStatus(resumed);
    return;
  }
  const modelId = modelSelect.value;
  const modelName = modelSelect.selectedOptions[0]?.textContent || 'the selected model';
  const poolRole = poolRoleInput.value;
  const splitCoordinator = poolRole === 'coordinator';
  setMessage(connectionStatus, splitCoordinator
    ? `Starting the ${modelName} coordinator. Model pieces will download automatically.`
    : `Joining the ${modelName} pool as a worker. Model pieces will download automatically.`);
  const started = await window.hostApi.startSharing({
    inviteToken: inviteInput.value,
    serviceUrl: serviceUrlInput.value.trim(),
    modelId,
    poolRole,
    acknowledged: acknowledge.checked,
    inviteAcknowledged: inviteAcknowledge.checked,
    presence: {
      optIn: mapOptIn.checked,
      serviceUrl: serviceUrlInput.value.trim(),
      hostToken: hostTokenInput.value.trim(),
      region: regionInput.value
    }
  });
  inviteInput.value = '';
  hostTokenInput.value = '';
  renderStatus(started);
}, connectionStatus));

copyOwnerIdButton.addEventListener('click', async () => {
  if (!localOwnerId) return;
  try {
    await navigator.clipboard.writeText(localOwnerId);
    setMessage(connectionStatus, 'Owner ID copied. Send it to the beta operator for approval.');
  } catch {
    const range = document.createRange();
    range.selectNodeContents(ownerIdElement);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    setMessage(connectionStatus, 'Select and copy the Owner ID shown above, then send it to the beta operator.');
  }
});

pauseButton.addEventListener('click', () => runAction(pauseButton, () => window.hostApi.pause(), connectionStatus));
disconnectButton.addEventListener('click', () => runAction(disconnectButton, () => window.hostApi.disconnect(), connectionStatus));
window.hostApi.resourceBudget().then(budget => {
  recommendedMemoryGb = budget.recommendedModelMemoryGb;
  setMessage(memoryBudgetElement, recommendedMemoryGb >= 0.5
    ? `Detected ${budget.systemMemoryGb} GB of system memory. The app will cap model use at ${recommendedMemoryGb} GB and keep at least 6 GB for the system and your other apps.`
    : `Detected ${budget.systemMemoryGb} GB of system memory. This computer has less than the beta's safe minimum for contributing.`);
  return window.hostApi.status();
}).then(renderStatus).catch(() => {
  recommendedMemoryGb = 0;
  setMessage(memoryBudgetElement, 'Could not check this computer’s available memory. Sharing is paused until the check works.', true);
});
window.hostApi.ownerId().then(ownerId => {
  localOwnerId = ownerId;
  ownerIdElement.textContent = ownerId;
  copyOwnerIdButton.disabled = false;
  return window.hostApi.status();
}).then(renderStatus).catch(() => {
  ownerIdElement.textContent = 'Could not create a secure MeshLLM identity.';
  setMessage(connectionStatus, 'The bundled MeshLLM runtime could not prepare this computer’s identity.', true);
  void window.hostApi.status().then(renderStatus);
});
window.hostApi.onStatus(renderStatus);
window.hostApi.status().then(renderStatus);
