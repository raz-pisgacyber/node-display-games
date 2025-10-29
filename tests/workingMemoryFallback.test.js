const test = require('node:test');
const assert = require('node:assert/strict');

const {
  saveWorkingMemoryPart,
  loadWorkingMemory,
} = require('../src/utils/workingMemoryStore');
const {
  fetchMessagesForHistory,
  countMessagesForScope,
} = require('../src/utils/mysqlQueries');

class FakeConnection {
  constructor() {
    this.calls = [];
    this.handlers = [];
  }

  on(match, handler, method) {
    this.handlers.push({ match, handler, method });
  }

  async execute(sql, params = []) {
    return this.#dispatch('execute', sql, params);
  }

  async query(sql, params = []) {
    return this.#dispatch('query', sql, params);
  }

  release() {}

  #dispatch(method, sql, params) {
    const normalisedSql = sql.replace(/\s+/g, ' ').trim();
    this.calls.push({ method, sql: normalisedSql, params: params.slice() });
    for (const { match, handler, method: handlerMethod } of this.handlers) {
      if (handlerMethod && handlerMethod !== method) {
        continue;
      }
      const matches =
        typeof match === 'function'
          ? match(normalisedSql, method)
          : normalisedSql.includes(match);
      if (matches) {
        if (typeof handler === 'function') {
          return handler(normalisedSql, params.slice(), method);
        }
        return handler;
      }
    }
    return [[], []];
  }
}

test('saveWorkingMemoryPart persists session-scoped history with node metadata', async () => {
  const connection = new FakeConnection();
  await saveWorkingMemoryPart({
    sessionId: 'session-1',
    projectId: 'project-1',
    nodeId: 'node-1',
    part: 'working_history',
    value: 'history-text',
    connection,
  });

  const insertCall = connection.calls.find((call) =>
    call.sql.startsWith('INSERT INTO working_memory_parts')
  );
  assert(insertCall, 'working memory insert executed');
  assert.equal(insertCall.params[0], 'session-1');
  assert.equal(insertCall.params[1], 'project-1');
  assert.equal(insertCall.params[2], 'node-1');
  assert.equal(insertCall.params[3], 'working_history');

  const historyCall = connection.calls.find((call) =>
    call.sql.startsWith('INSERT INTO node_working_history')
  );
  assert(historyCall, 'working history upsert executed');
  assert.equal(historyCall.params[0], 'project-1');
  assert.equal(historyCall.params[1], 'node-1');
});

test('saveWorkingMemoryPart supports project/node fallback when session is missing', async () => {
  const connection = new FakeConnection();
  await saveWorkingMemoryPart({
    sessionId: '',
    projectId: 'project-2',
    nodeId: 'node-9',
    part: 'working_history',
    value: 'fallback-history',
    connection,
  });

  const insertCall = connection.calls.find((call) =>
    call.sql.startsWith('INSERT INTO working_memory_parts')
  );
  assert(insertCall, 'working memory insert executed');
  assert.equal(insertCall.params[0], '');
  assert.equal(insertCall.params[1], 'project-2');
  assert.equal(insertCall.params[2], 'node-9');
  assert.equal(insertCall.params[3], 'working_history');

  const historyCall = connection.calls.find((call) =>
    call.sql.startsWith('INSERT INTO node_working_history')
  );
  assert(historyCall, 'node_working_history insert executed');
  assert.equal(historyCall.params[0], 'project-2');
  assert.equal(historyCall.params[1], 'node-9');
});

test('loadWorkingMemory reads fallback scope with derived session metadata', async () => {
  const connection = new FakeConnection();
  connection.on('FROM working_memory_parts', () => [
    [
      {
        part: 'working_history',
        payload: '"cached"',
        project_id: 'project-2',
        node_id: 'node-9',
      },
    ],
    [],
  ], 'query');

  const { memory } = await loadWorkingMemory({
    sessionId: '',
    projectId: 'project-2',
    nodeId: 'node-9',
    connection,
  });

  assert.equal(memory.working_history, 'cached');
  assert.equal(memory.session.project_id, 'project-2');
  assert.equal(memory.session.session_id, '');
  assert.equal(memory.session.active_node_id, 'node-9');
});

test('message helpers join sessions when only project/node scope is provided', async () => {
  const connection = new FakeConnection();
  connection.on('FROM messages m INNER JOIN sessions s', () => [
    [
      {
        id: 1,
        session_id: 42,
        node_id: 'node-9',
        role: 'user',
        content: 'Hello',
        message_type: 'user_reply',
        created_at: new Date(),
      },
    ],
    [],
  ]);

  const messages = await fetchMessagesForHistory(connection, {
    sessionId: null,
    projectId: 'project-join',
    nodeId: 'node-9',
    limit: 5,
  });
  assert.equal(messages.length, 1);

  const selectCall = connection.calls.find((call) =>
    call.sql.startsWith('SELECT m.id, m.session_id')
  );
  assert(selectCall.sql.includes('INNER JOIN sessions'));
  assert.deepEqual(selectCall.params.slice(0, 2), ['project-join', 'node-9']);

  const countConnection = new FakeConnection();
  countConnection.on('FROM messages m INNER JOIN sessions s', () => [[{ total_count: 7 }], []]);
  const total = await countMessagesForScope(countConnection, {
    sessionId: null,
    projectId: 'project-join',
    nodeId: 'node-9',
  });
  assert.equal(total, 7);
  const countCall = countConnection.calls[0];
  assert(countCall.sql.includes('INNER JOIN sessions'));
  assert.deepEqual(countCall.params, ['project-join', 'node-9']);
});
