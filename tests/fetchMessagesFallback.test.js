const test = require('node:test');
const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadApiModule() {
  const moduleUrl = pathToFileURL(resolve(__dirname, '../modules/common/api.js')).href;
  return import(moduleUrl);
}

test('fetchMessages includes project scope for sessionless requests', async () => {
  const { fetchMessages } = await loadApiModule();
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          messages: [{ id: 1, content: 'hello' }],
          total_count: 1,
          filtered_count: 1,
          has_more: false,
          next_cursor: null,
          last_user_message: 'hello',
        }),
    };
  };
  try {
    const result = await fetchMessages({ nodeId: 'node-42', projectId: 'project-99', limit: 10 });
    assert.equal(calls.length, 1);
    const requestUrl = calls[0];
    assert.match(requestUrl, /project_id=project-99/);
    assert.match(requestUrl, /node_id=node-42/);
    assert.match(requestUrl, /limit=10/);
    assert.deepEqual(result.messages, [{ id: 1, content: 'hello' }]);
    assert.equal(result.total_count, 1);
    assert.equal(result.last_user_message, 'hello');
  } finally {
    global.fetch = originalFetch;
  }
});

test('fetchMessages keeps session-first requests unchanged', async () => {
  const { fetchMessages } = await loadApiModule();
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          messages: [],
          total_count: 0,
          filtered_count: 0,
          has_more: false,
          next_cursor: null,
          last_user_message: '',
        }),
    };
  };
  try {
    await fetchMessages({ sessionId: 'session-7', nodeId: 'node-1', limit: 5 });
    assert.equal(calls.length, 1);
    const requestUrl = calls[0];
    assert.match(requestUrl, /session_id=session-7/);
    assert.match(requestUrl, /node_id=node-1/);
    assert(!requestUrl.includes('project_id='));
  } finally {
    global.fetch = originalFetch;
  }
});
