import React, { useState, useEffect, useMemo, useCallback, useRef } from 'https://esm.sh/react@18?dev';
import { createRoot } from 'https://esm.sh/react-dom@18/client?dev';
import ReactFlow, {
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
} from 'https://esm.sh/reactflow@11?deps=react@18,react-dom@18&dev';

const AUTOSAVE_DELAY = 1600;
const VERSION_INTERVAL = 6000;
const API_BASE = '/api';

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function fetchJSON(url, options = {}) {
  const finalOptions = { ...options };
  finalOptions.headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  if (finalOptions.body && typeof finalOptions.body !== 'string') {
    finalOptions.body = JSON.stringify(finalOptions.body);
  }
  const response = await fetch(url, finalOptions);
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const data = await response.json();
      if (data && data.error) {
        message = data.error;
      } else if (typeof data === 'string') {
        message = data;
      }
    } catch (err) {
      const text = await response.text();
      if (text) message = text;
    }
    throw new Error(message);
  }
  if (response.status === 204) {
    return null;
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function getOrCreateSession() {
  const key = 'story-graph-session';
  const cached = window.localStorage.getItem(key);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed?.id) {
        return parsed;
      }
    } catch (err) {
      console.warn('Failed to parse cached session', err);
    }
  }
  const userId = `guest_${Math.random().toString(36).slice(2, 10)}`;
  const created = await fetchJSON(`${API_BASE}/sessions`, {
    method: 'POST',
    body: { user_id: userId },
  });
  const stored = { ...created, user_id: userId };
  window.localStorage.setItem(key, JSON.stringify(stored));
  return stored;
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function deepEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function parseMetaValue(input) {
  const trimmed = input.trim();
  if (trimmed === '') return '';
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (!Number.isNaN(Number(trimmed))) {
    return Number(trimmed);
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    return input;
  }
}

function stringifyMetaValue(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function App() {
  const [session, setSession] = useState(null);
  const [sessionError, setSessionError] = useState(null);
  const [graphNodes, setGraphNodes] = useState([]);
  const [graphEdges, setGraphEdges] = useState([]);
  const [nodes, setNodes, onNodesChangeBase] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [draftNode, setDraftNode] = useState(null);
  const [autosaveState, setAutosaveState] = useState('idle');
  const [isDirty, setIsDirty] = useState(false);
  const autosaveHandle = useRef(null);
  const versionCursor = useRef(null);
  const [messages, setMessages] = useState([]);
  const [messagesStatus, setMessagesStatus] = useState('idle');
  const [newMessage, setNewMessage] = useState('');
  const [summary, setSummary] = useState(null);
  const [summaryDraft, setSummaryDraft] = useState('');
  const [checkpoints, setCheckpoints] = useState([]);
  const [checkpointName, setCheckpointName] = useState('');
  const [newMetaKey, setNewMetaKey] = useState('');
  const [newMetaValue, setNewMetaValue] = useState('');
  const [errorBanner, setErrorBanner] = useState(null);
  const initialisedPositions = useRef(new Set());

  const selectedNode = useMemo(
    () => graphNodes.find((node) => node.id === selectedNodeId) || null,
    [graphNodes, selectedNodeId]
  );

  useEffect(() => {
    let mounted = true;
    getOrCreateSession()
      .then((data) => {
        if (mounted) setSession(data);
      })
      .catch((err) => {
        console.error(err);
        if (mounted) setSessionError(err.message);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const loadGraph = useCallback(async () => {
    try {
      const data = await fetchJSON(`${API_BASE}/graph`);
      setGraphNodes(data.nodes || []);
      setGraphEdges(data.edges || []);
      versionCursor.current = new Date().toISOString();
      setErrorBanner(null);
    } catch (error) {
      console.error(error);
      setErrorBanner(error?.message || 'Failed to load graph');
    }
  }, []);

  useEffect(() => {
    loadGraph();
  }, [loadGraph]);

  useEffect(() => {
    setNodes(
      graphNodes.map((node, index) => {
        const position = node.meta?.position;
        let pos = position;
        if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') {
          pos = {
            x: 200 + (index % 4) * 220,
            y: 160 + Math.floor(index / 4) * 180,
          };
          if (!initialisedPositions.current.has(node.id)) {
            initialisedPositions.current.add(node.id);
            const metaUpdates = { ...(node.meta || {}), position: pos };
            setGraphNodes((prev) =>
              prev.map((n) => (n.id === node.id ? { ...n, meta: metaUpdates } : n))
            );
            fetchJSON(`${API_BASE}/node/${node.id}`, {
              method: 'PATCH',
              body: { meta: metaUpdates },
            }).catch((err) => console.warn('Failed to seed node position', err));
          }
        }
        return {
          id: node.id,
          position: pos,
          data: { label: node.label || node.id },
        };
      })
    );
  }, [graphNodes, setNodes]);

  useEffect(() => {
    setEdges(
      graphEdges.map((edge, index) => ({
        id: `${edge.from}-${edge.to}-${edge.type || 'LINKS_TO'}-${index}`,
        source: edge.from,
        target: edge.to,
        label: edge.type && edge.type !== 'LINKS_TO' ? edge.type : undefined,
        data: edge.props || {},
      }))
    );
  }, [graphEdges, setEdges]);

  useEffect(() => {
    if (!selectedNode) {
      setDraftNode(null);
      setAutosaveState('idle');
      setIsDirty(false);
      return;
    }
    setDraftNode({
      ...selectedNode,
      meta: { ...(selectedNode.meta || {}) },
    });
    setAutosaveState('saved');
    setIsDirty(false);
  }, [selectedNode]);

  useEffect(() => {
    if (!session || selectedNodeId === undefined) return;
    fetchJSON(`${API_BASE}/sessions/${session.id}`, {
      method: 'PATCH',
      body: { active_node: selectedNodeId || null },
    }).catch((err) => console.warn('Failed to update session', err));
  }, [session, selectedNodeId]);

  useEffect(() => {
    if (!draftNode || !selectedNode || !isDirty) {
      return undefined;
    }
    setAutosaveState('saving');
    if (autosaveHandle.current) {
      clearTimeout(autosaveHandle.current);
    }
    autosaveHandle.current = setTimeout(async () => {
      const payload = {};
      if (draftNode.label !== selectedNode.label) {
        payload.label = draftNode.label;
      }
      if (draftNode.content !== selectedNode.content) {
        payload.content = draftNode.content;
      }
      if (!deepEqual(draftNode.meta, selectedNode.meta)) {
        payload.meta = draftNode.meta;
      }
      if (Object.keys(payload).length === 0) {
        setAutosaveState('saved');
        setIsDirty(false);
        return;
      }
      try {
        const updated = await fetchJSON(`${API_BASE}/node/${draftNode.id}`, {
          method: 'PATCH',
          body: payload,
        });
        setGraphNodes((prev) => prev.map((node) => (node.id === updated.id ? updated : node)));
        setAutosaveState('saved');
        setIsDirty(false);
      } catch (error) {
        console.error(error);
        setAutosaveState('error');
        setErrorBanner(error?.message || 'Request failed');
      }
    }, AUTOSAVE_DELAY);
    return () => {
      if (autosaveHandle.current) {
        clearTimeout(autosaveHandle.current);
      }
    };
  }, [draftNode, selectedNode, isDirty]);

  useEffect(() => {
    if (!session) return undefined;
    const interval = setInterval(async () => {
      if (!versionCursor.current) return;
      try {
        const data = await fetchJSON(
          `${API_BASE}/versions/check?since=${encodeURIComponent(versionCursor.current)}`
        );
        versionCursor.current = new Date().toISOString();
        if (data?.versions?.length) {
          await loadGraph();
        }
      } catch (error) {
        console.warn('Version check failed', error);
      }
    }, VERSION_INTERVAL);
    return () => clearInterval(interval);
  }, [session, loadGraph]);

  const refreshMessages = useCallback(async () => {
    if (!session) return;
    setMessagesStatus('loading');
    const params = new URLSearchParams({ session_id: session.id, limit: '50' });
    if (selectedNodeId) {
      params.set('node_id', selectedNodeId);
    }
    try {
      const data = await fetchJSON(`${API_BASE}/messages?${params.toString()}`);
      const list = (data.messages || []).slice().reverse();
      setMessages(list);
      setMessagesStatus('ready');
    } catch (error) {
      console.error(error);
      setMessagesStatus('error');
    }
  }, [session, selectedNodeId]);

  useEffect(() => {
    refreshMessages();
  }, [refreshMessages]);

  useEffect(() => {
    if (!session) return;
    fetchJSON(`${API_BASE}/summaries?session_id=${session.id}&limit=1`)
      .then((data) => {
        const latest = data.summaries?.[0];
        if (latest) {
          setSummary(latest.summary_json);
        }
      })
      .catch((error) => console.warn('Failed to load summary', error));
  }, [session]);

  useEffect(() => {
    fetchJSON(`${API_BASE}/checkpoints`)
      .then((data) => setCheckpoints(data.checkpoints || []))
      .catch((error) => console.warn('Failed to load checkpoints', error));
  }, []);

  const handleNodesChange = useCallback(
    (changes) => {
      onNodesChangeBase(changes);
      const updates = [];
      changes.forEach((change) => {
        if (change.type === 'position' && !change.dragging && change.position) {
          updates.push({ id: change.id, position: change.position });
        }
      });
      if (updates.length) {
        setGraphNodes((prev) =>
          prev.map((node) => {
            const update = updates.find((item) => item.id === node.id);
            if (!update) return node;
            const updatedMeta = { ...(node.meta || {}), position: update.position };
            if (node.id === draftNode?.id) {
              setDraftNode((current) =>
                current
                  ? {
                      ...current,
                      meta: { ...updatedMeta },
                    }
                  : current
              );
            }
            return { ...node, meta: updatedMeta };
          })
        );
        if (!isDirty) {
          setAutosaveState('saving');
        }
        Promise.all(
          updates.map((update) => {
            const node = graphNodes.find((n) => n.id === update.id);
            const baseMetaSource =
              draftNode?.id === update.id && draftNode?.meta
                ? draftNode.meta
                : node?.meta;
            const baseMeta = baseMetaSource
              ? { ...baseMetaSource, position: update.position }
              : { position: update.position };
            return fetchJSON(`${API_BASE}/node/${update.id}`, {
              method: 'PATCH',
              body: { meta: baseMeta },
            });
          })
        )
          .then(() => {
            if (!isDirty) {
              setAutosaveState('saved');
            }
          })
          .catch((err) => {
            console.warn('Failed to persist position', err);
            if (!isDirty) {
              setAutosaveState('error');
            }
            setErrorBanner(err?.message || 'Failed to persist position');
          });
      }
    },
    [onNodesChangeBase, draftNode, graphNodes, isDirty]
  );

  const handleConnect = useCallback(
    async (connection) => {
      try {
        const created = await fetchJSON(`${API_BASE}/edge`, {
          method: 'POST',
          body: { from: connection.source, to: connection.target, type: connection.type || 'LINKS_TO' },
        });
        setGraphEdges((prev) => [...prev, created]);
        setEdges((eds) => addEdge(connection, eds));
      } catch (error) {
        console.error(error);
        setErrorBanner(error?.message || 'Request failed');
      }
    },
    [setEdges]
  );

  const handleAddNode = useCallback(async () => {
    const label = window.prompt('Node label', 'New Story Node');
    if (!label) return;
    const position = {
      x: 200 + (graphNodes.length % 4) * 220,
      y: 160 + Math.floor(graphNodes.length / 4) * 200,
    };
    try {
      const created = await fetchJSON(`${API_BASE}/node`, {
        method: 'POST',
        body: { label, content: '', meta: { position } },
      });
      setGraphNodes((prev) => [...prev, created]);
      setSelectedNodeId(created.id);
    } catch (error) {
      console.error(error);
      setErrorBanner(error?.message || 'Request failed');
    }
  }, [graphNodes.length]);

  const handleDeleteNode = useCallback(async () => {
    if (!selectedNode) return;
    if (!window.confirm(`Delete node "${selectedNode.label || selectedNode.id}"?`)) {
      return;
    }
    try {
      await fetchJSON(`${API_BASE}/node/${selectedNode.id}`, { method: 'DELETE' });
      setGraphNodes((prev) => prev.filter((node) => node.id !== selectedNode.id));
      setGraphEdges((prev) => prev.filter((edge) => edge.from !== selectedNode.id && edge.to !== selectedNode.id));
      setSelectedNodeId(null);
    } catch (error) {
      console.error(error);
      setErrorBanner(error?.message || 'Request failed');
    }
  }, [selectedNode]);

  const handleDeleteEdge = useCallback(async (edge) => {
    try {
      await fetchJSON(`${API_BASE}/edge`, {
        method: 'DELETE',
        body: { from: edge.from, to: edge.to, type: edge.type },
      });
      setGraphEdges((prev) => prev.filter((item) => item !== edge));
    } catch (error) {
      console.error(error);
      setErrorBanner(error.message);
    }
  }, []);

  const handleMessageSubmit = useCallback(
    async (event) => {
      event.preventDefault();
      if (!session || !newMessage.trim()) return;
      try {
        await fetchJSON(`${API_BASE}/messages`, {
          method: 'POST',
          body: {
            session_id: session.id,
            node_id: selectedNodeId || null,
            role: 'user',
            content: newMessage.trim(),
          },
        });
        setNewMessage('');
        refreshMessages();
      } catch (error) {
        console.error(error);
        setErrorBanner(error?.message || 'Request failed');
      }
    },
    [session, newMessage, selectedNodeId, refreshMessages]
  );

  const handleSaveSummary = useCallback(async () => {
    if (!session || !summaryDraft.trim()) return;
    try {
      const payload = {
        session_id: session.id,
        nodes: selectedNodeId ? [selectedNodeId] : [],
        text: summaryDraft.trim(),
        last_n: messages.length,
      };
      const saved = await fetchJSON(`${API_BASE}/summaries/rollup`, {
        method: 'POST',
        body: payload,
      });
      setSummary(saved.summary_json);
      setSummaryDraft('');
    } catch (error) {
      console.error(error);
      setErrorBanner(error?.message || 'Request failed');
    }
  }, [session, summaryDraft, selectedNodeId, messages.length]);

  const handleSaveCheckpoint = useCallback(async () => {
    const name = checkpointName.trim();
    if (!name) return;
    try {
      await fetchJSON(`${API_BASE}/checkpoints`, {
        method: 'POST',
        body: { name },
      });
      setCheckpointName('');
      const refreshed = await fetchJSON(`${API_BASE}/checkpoints`);
      setCheckpoints(refreshed.checkpoints || []);
    } catch (error) {
      console.error(error);
      setErrorBanner(error?.message || 'Request failed');
    }
  }, [checkpointName]);

  const handleRestoreCheckpoint = useCallback(
    async (checkpointId) => {
      if (!checkpointId) return;
      if (!window.confirm('Restore checkpoint? Current graph will be replaced.')) {
        return;
      }
      try {
        await fetchJSON(`${API_BASE}/checkpoints/${checkpointId}/restore`, { method: 'POST' });
        await loadGraph();
        const refreshed = await fetchJSON(`${API_BASE}/checkpoints`);
        setCheckpoints(refreshed.checkpoints || []);
      } catch (error) {
        console.error(error);
        setErrorBanner(error?.message || 'Request failed');
      }
    },
    [loadGraph]
  );

  const connectedEdges = useMemo(
    () => graphEdges.filter((edge) => edge.from === selectedNodeId || edge.to === selectedNodeId),
    [graphEdges, selectedNodeId]
  );

  const statusLabel = useMemo(() => {
    switch (autosaveState) {
      case 'saving':
        return 'Saving…';
      case 'saved':
        return 'Saved';
      case 'error':
        return 'Autosave failed';
      case 'idle':
        return 'Idle';
      default:
        return 'Editing…';
    }
  }, [autosaveState]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-title">
          <h1>Story Graph Studio</h1>
          <span>Visual editor with live Neo4j + MySQL sync</span>
        </div>
        <div className="header-actions">
          <button type="button" onClick={handleAddNode}>Add node</button>
          <div className="status-indicator" aria-live="polite">
            <span className={`status-dot ${autosaveState}`}></span>
            <span>{statusLabel}</span>
          </div>
        </div>
      </header>

      <section className="graph-panel">
        {errorBanner && (
          <div className="summary-banner" style={{ margin: '0.75rem' }}>
            <h3>Error</h3>
            <p>{errorBanner}</p>
          </div>
        )}
        <div className="graph-wrapper">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={handleNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={handleConnect}
            fitView
            onSelectionChange={({ nodes: selected }) => {
              setSelectedNodeId(selected[0]?.id || null);
            }}
            style={{ width: '100%', height: '100%' }}
          >
            <MiniMap />
            <Controls />
            <Background />
          </ReactFlow>
        </div>
      </section>

      <aside className="sidebar">
        <div className="panel">
          <h2>Session</h2>
          {sessionError && <div className="empty-state">{sessionError}</div>}
          {session && (
            <div className="field">
              <label>Session</label>
              <div>{session.id}</div>
            </div>
          )}
          {summary && (
            <div className="summary-banner">
              <h3>Summary</h3>
              <p>{summary.text}</p>
            </div>
          )}
        </div>

        <div className="panel">
          <h2>Node inspector</h2>
          {!selectedNode && <div className="empty-state">Select a node to edit details.</div>}
          {selectedNode && draftNode && (
            <>
              <div className="field">
                <label>Label</label>
                <input
                  type="text"
                  value={draftNode.label || ''}
                  onChange={(event) => {
                    setDraftNode((prev) => ({ ...prev, label: event.target.value }));
                    setIsDirty(true);
                    setAutosaveState('dirty');
                  }}
                />
              </div>
              <div className="field">
                <label>Content</label>
                <textarea
                  value={draftNode.content || ''}
                  onChange={(event) => {
                    setDraftNode((prev) => ({ ...prev, content: event.target.value }));
                    setIsDirty(true);
                    setAutosaveState('dirty');
                  }}
                />
              </div>
              <div className="field">
                <label>Metadata</label>
                <div className="meta-grid">
                  {Object.entries(draftNode.meta || {}).length === 0 && (
                    <div className="meta-empty">No metadata yet.</div>
                  )}
                  {Object.entries(draftNode.meta || {}).map(([key, value]) => (
                    <div className="meta-row" key={key}>
                      <input
                        type="text"
                        value={key}
                        onChange={(event) => {
                          const nextKey = event.target.value;
                          setDraftNode((prev) => {
                            const meta = { ...(prev.meta || {}) };
                            delete meta[key];
                            if (nextKey) meta[nextKey] = value;
                            return { ...prev, meta };
                          });
                          setIsDirty(true);
                          setAutosaveState('dirty');
                        }}
                      />
                      <input
                        type="text"
                        value={stringifyMetaValue(value)}
                        onChange={(event) => {
                          const parsed = parseMetaValue(event.target.value);
                          setDraftNode((prev) => ({
                            ...prev,
                            meta: { ...(prev.meta || {}), [key]: parsed },
                          }));
                          setIsDirty(true);
                          setAutosaveState('dirty');
                        }}
                      />
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => {
                          setDraftNode((prev) => {
                            const meta = { ...(prev.meta || {}) };
                            delete meta[key];
                            return { ...prev, meta };
                          });
                          setIsDirty(true);
                          setAutosaveState('dirty');
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
                <div className="meta-row" style={{ marginTop: '0.5rem' }}>
                  <input
                    type="text"
                    placeholder="key"
                    value={newMetaKey}
                    onChange={(event) => setNewMetaKey(event.target.value)}
                  />
                  <input
                    type="text"
                    placeholder="value"
                    value={newMetaValue}
                    onChange={(event) => setNewMetaValue(event.target.value)}
                  />
                  <button
                    type="button"
                    disabled={!newMetaKey.trim()}
                    onClick={() => {
                      if (!newMetaKey.trim()) return;
                      const parsed = parseMetaValue(newMetaValue);
                      setDraftNode((prev) => ({
                        ...prev,
                        meta: { ...(prev.meta || {}), [newMetaKey]: parsed },
                      }));
                      setNewMetaKey('');
                      setNewMetaValue('');
                      setIsDirty(true);
                      setAutosaveState('dirty');
                    }}
                  >
                    Add
                  </button>
                </div>
              </div>
              <button type="button" className="secondary-button" onClick={handleDeleteNode}>
                Delete node
              </button>
            </>
          )}
        </div>

        {selectedNode && (
          <div className="panel">
            <h2>Edges</h2>
            {connectedEdges.length === 0 && <div className="empty-state">No edges linked.</div>}
            {connectedEdges.map((edge, index) => (
              <div className="checkpoint-item" key={`${edge.from}-${edge.to}-${index}`}>
                <span>
                  <strong>{edge.from === selectedNodeId ? '→ ' : '← '}{edge.from === selectedNodeId ? edge.to : edge.from}</strong>
                  <time>{edge.type || 'LINKS_TO'}</time>
                </span>
                <button type="button" className="secondary-button" onClick={() => handleDeleteEdge(edge)}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="panel">
          <h2>Messages</h2>
          {messagesStatus === 'loading' && <div className="empty-state">Loading messages…</div>}
          {messagesStatus === 'error' && <div className="empty-state">Failed to load messages.</div>}
          {messagesStatus === 'ready' && messages.length === 0 && (
            <div className="empty-state">No messages yet.</div>
          )}
          {messagesStatus === 'ready' && messages.length > 0 && (
            <div className="messages">
              {messages.map((message) => (
                <div className="message" key={message.id}>
                  <div className="message-header">
                    <span>{message.role}</span>
                    <span>{formatDate(message.created_at)}</span>
                  </div>
                  <div className="message-content">{message.content}</div>
                </div>
              ))}
            </div>
          )}
          <form className="messages-form" onSubmit={handleMessageSubmit}>
            <textarea
              placeholder="Leave a note about this session"
              value={newMessage}
              onChange={(event) => setNewMessage(event.target.value)}
            />
            <button type="submit" disabled={!newMessage.trim()}>
              Add message
            </button>
          </form>
        </div>

        <div className="panel">
          <h2>Summary</h2>
          <textarea
            placeholder="Summarise what changed..."
            value={summaryDraft}
            onChange={(event) => setSummaryDraft(event.target.value)}
          />
          <button type="button" onClick={handleSaveSummary} disabled={!summaryDraft.trim()}>
            Save summary
          </button>
        </div>

        <div className="panel">
          <h2>Checkpoints</h2>
          <div className="field">
            <label>New checkpoint</label>
            <input
              type="text"
              placeholder="Checkpoint name"
              value={checkpointName}
              onChange={(event) => setCheckpointName(event.target.value)}
            />
            <button type="button" onClick={handleSaveCheckpoint} disabled={!checkpointName.trim()}>
              Save checkpoint
            </button>
          </div>
          <div className="checkpoint-list">
            {checkpoints.length === 0 && <div className="empty-state">No checkpoints saved yet.</div>}
            {checkpoints.map((checkpoint) => (
              <div className="checkpoint-item" key={checkpoint.id}>
                <span>
                  <strong>{checkpoint.name}</strong>
                  <time>{formatDate(checkpoint.created_at)}</time>
                </span>
                <button type="button" className="secondary-button" onClick={() => handleRestoreCheckpoint(checkpoint.id)}>
                  Restore
                </button>
              </div>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}

const rootElement = document.getElementById('root');
if (rootElement) {
  const root = createRoot(rootElement);
  root.render(<App />);
}
