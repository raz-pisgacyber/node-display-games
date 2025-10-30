const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
  sanitiseWorkingMemoryPart,
} = require('../src/utils/workingMemorySchema');

test('sanitiseWorkingMemoryPart retains extended meta properties', () => {
  const originalMeta = {
    notes: 'Existing note',
    customFields: [
      { key: 'role', value: 'hero' },
      { key: '', value: '' },
    ],
    linked_elements: [
      { id: 'villain-1', label: '', type: '' },
      { id: '', label: 'unused', type: 'character' },
    ],
    elementData: { origin: 'Mars' },
    stats: { hp: 10, mp: 4 },
  };
  const payload = sanitiseWorkingMemoryPart('node_context', {
    id: 'node-1',
    label: 'Hero',
    type: 'character',
    notes: '  Outer note  ',
    customFields: [
      { key: ' role ', value: 'hero' },
      { key: '', value: '' },
    ],
    linked_elements: [
      { id: 'villain-2', label: '', type: '' },
      { id: '', label: 'unused', type: 'character' },
    ],
    meta: originalMeta,
  });

  assert.equal(payload.meta.notes, '  Outer note  ');
  assert.deepEqual(payload.meta.elementData, { origin: 'Mars' });
  assert.deepEqual(payload.meta.stats, { hp: 10, mp: 4 });
  assert.deepEqual(payload.meta.customFields, [{ key: 'role', value: 'hero' }]);
  assert.deepEqual(payload.meta.linked_elements, [
    { id: 'villain-2', label: 'villain-2', type: '' },
  ]);
});

test('working memory persistence writes expanded node meta', async (t) => {
  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    return {
      ok: true,
      status: 204,
      text: async () => '',
      json: async () => ({}),
    };
  };
  t.after(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    } else {
      delete global.fetch;
    }
  });

  const moduleUrl = pathToFileURL(path.resolve(__dirname, '../modules/common/workingMemory.js'));
  const workingMemory = await import(moduleUrl);

  await workingMemory.setWorkingMemorySession({
    session_id: 'session-1',
    project_id: 'project-1',
    active_node_id: 'node-1',
  });

  requests.length = 0;

  const metaPayload = {
    notes: '  Hero note  ',
    customFields: [
      { key: 'role', value: 'protagonist' },
      { key: '', value: '' },
    ],
    linked_elements: [
      { id: 'villain-1', label: '', type: '' },
      { id: '', label: 'ignored', type: 'character' },
    ],
    elementData: { origin: 'Mars' },
    stats: { hp: 12 },
  };

  workingMemory.setWorkingMemoryNodeContext({
    id: 'node-1',
    label: 'Hero',
    type: 'character',
    meta: metaPayload,
  });

  assert(requests.length > 0, 'node context persistence triggered');
  const nodeRequest = requests.find((entry) =>
    entry.url.includes('/api/working-memory/node_context')
  );
  assert(nodeRequest, 'node context request captured');
  const body = JSON.parse(nodeRequest.options.body);

  assert.equal(body.value.meta.notes, 'Hero note');
  assert.deepEqual(body.value.meta.customFields, [{ key: 'role', value: 'protagonist' }]);
  assert.deepEqual(body.value.meta.linked_elements, [
    { id: 'villain-1', label: 'villain-1', type: '' },
  ]);
  assert.deepEqual(body.value.meta.elementData, { origin: 'Mars' });
  assert.deepEqual(body.value.meta.stats, { hp: 12 });

  const snapshot = workingMemory.getWorkingMemorySnapshot();
  assert.equal(snapshot.node_context.meta.notes, 'Hero note');
  assert.deepEqual(snapshot.node_context.meta.customFields, [
    { key: 'role', value: 'protagonist' },
  ]);
  assert.deepEqual(snapshot.node_context.meta.linked_elements, [
    { id: 'villain-1', label: 'villain-1', type: '' },
  ]);
  assert.deepEqual(snapshot.node_context.meta.elementData, { origin: 'Mars' });
  assert.deepEqual(snapshot.node_context.meta.stats, { hp: 12 });
  assert.notStrictEqual(snapshot.node_context.meta.elementData, metaPayload.elementData);
  assert.notStrictEqual(snapshot.node_context.meta.stats, metaPayload.stats);
  assert.equal(metaPayload.elementData.origin, 'Mars');
  assert.equal(metaPayload.stats.hp, 12);
});
