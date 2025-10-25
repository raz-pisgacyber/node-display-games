import { updateNode, createEdge, deleteEdge, updateEdge } from './api.js';
import { rebuildProjectStructure } from './projectStructureService.js';

const DEFAULT_DELAY = 1700;
const STATUS_IDLE = 'idle';
const STATUS_DIRTY = 'dirty';
const STATUS_SAVING = 'saving';
const STATUS_SAVED = 'saved';
const STATUS_ERROR = 'error';

function sanitiseMeta(meta) {
  if (!meta || typeof meta !== 'object') {
    return {};
  }
  try {
    return JSON.parse(JSON.stringify(meta));
  } catch (error) {
    const result = {};
    Object.entries(meta).forEach(([key, value]) => {
      if (value === undefined) {
        return;
      }
      if (value && typeof value === 'object') {
        result[key] = sanitiseMeta(value);
      } else if (typeof value !== 'function') {
        result[key] = value;
      }
    });
    return result;
  }
}

function buildEdgeKey(from, to, type) {
  const sorted = [from, to].sort();
  return `${sorted[0]}|${sorted[1]}|${type || 'LINKS_TO'}`;
}

export default class AutosaveManager {
  constructor({ projectId, delay = DEFAULT_DELAY, onStatusChange } = {}) {
    this.projectId = projectId || null;
    this.delay = Math.max(250, delay || DEFAULT_DELAY);
    this.onStatusChange = typeof onStatusChange === 'function' ? onStatusChange : null;

    this.pendingNodes = new Map();
    this.pendingLinks = new Map();
    this.timer = null;
    this.status = STATUS_IDLE;
    this.inFlight = false;
  }

  setStatus(status) {
    if (this.status === status) {
      return;
    }
    this.status = status;
    this.onStatusChange?.(status);
  }

  markNodeDirty(node, reason = '') {
    if (!node || !node.id) {
      return;
    }
    this.pendingNodes.set(node.id, node);
    if (this.status !== STATUS_SAVING) {
      this.setStatus(STATUS_DIRTY);
    }
    if (reason === 'position') {
      this.scheduleCommit();
      return;
    }
    this.scheduleCommit();
  }

  markLinkChange({ action, from, to, type = 'LINKS_TO', props = {} }) {
    if (!from || !to) {
      return;
    }
    const key = buildEdgeKey(from, to, type);
    const [sortedFrom, sortedTo] = [from, to].sort();
    const entry = this.pendingLinks.get(key) || { action: null, from, to, type, props: {} };

    if (action === 'create') {
      entry.action = 'create';
      entry.from = sortedFrom;
      entry.to = sortedTo;
      entry.props = { ...props };
    } else if (action === 'delete') {
      if (entry.action === 'create') {
        this.pendingLinks.delete(key);
        if (!this.pendingNodes.size) {
          this.setStatus(this.status === STATUS_SAVING ? STATUS_SAVING : STATUS_IDLE);
        }
        return;
      }
      entry.action = 'delete';
      entry.from = sortedFrom;
      entry.to = sortedTo;
      entry.props = {};
    } else if (action === 'update') {
      if (entry.action === 'delete') {
        // no-op, deletion wins
      } else if (entry.action === 'create') {
        entry.props = { ...entry.props, ...props };
      } else {
        entry.action = 'update';
        entry.props = { ...props };
        entry.from = sortedFrom;
        entry.to = sortedTo;
      }
    }

    this.pendingLinks.set(key, entry);
    if (this.status !== STATUS_SAVING) {
      this.setStatus(STATUS_DIRTY);
    }
    this.scheduleCommit();
  }

  scheduleCommit(immediate = false) {
    if (this.timer) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    if (immediate) {
      this.commit().catch((error) => {
        console.error('Autosave commit failed', error);
      });
      return;
    }
    this.timer = window.setTimeout(() => {
      this.commit().catch((error) => {
        console.error('Autosave commit failed', error);
      });
    }, this.delay);
  }

  async commit({ keepalive = false } = {}) {
    if (this.inFlight) {
      this.scheduleCommit();
      return;
    }
    if (!this.pendingNodes.size && !this.pendingLinks.size) {
      if (this.status !== STATUS_IDLE) {
        this.setStatus(STATUS_SAVED);
        this.setStatus(STATUS_IDLE);
      }
      return;
    }

    this.inFlight = true;
    this.setStatus(STATUS_SAVING);

    let hadError = false;

    for (const [id, node] of Array.from(this.pendingNodes.entries())) {
      try {
        await this.processNode(node, { keepalive });
        this.pendingNodes.delete(id);
      } catch (error) {
        console.error('Failed to save node', id, error);
        hadError = true;
      }
    }

    let structureChanged = false;

    for (const [key, entry] of Array.from(this.pendingLinks.entries())) {
      try {
        const changed = await this.processLink(entry, { keepalive });
        structureChanged = structureChanged || changed;
        this.pendingLinks.delete(key);
      } catch (error) {
        console.error('Failed to persist link', entry, error);
        hadError = true;
      }
    }

    this.inFlight = false;

    if (hadError) {
      this.setStatus(STATUS_ERROR);
      this.scheduleCommit();
      return;
    }

    this.setStatus(STATUS_SAVED);
    this.setStatus(STATUS_IDLE);

    if (structureChanged && this.projectId) {
      try {
        await rebuildProjectStructure(this.projectId);
      } catch (error) {
        console.error('Failed to refresh project structure after link mutation', error);
      }
    }
  }

  async processNode(node, { keepalive = false } = {}) {
    const payload = typeof node.toPersistence === 'function' ? node.toPersistence() : null;
    if (!payload || !node.id) {
      return;
    }
    const meta = sanitiseMeta(payload.meta);
    const body = {
      label: payload.label,
      content: payload.content,
      meta,
    };
    const response = await updateNode(node.id, body, { projectId: this.projectId, keepalive });
    if (response && typeof response === 'object') {
      if (response.meta) {
        node.meta = response.meta;
        const position = response.meta?.position;
        if (position && typeof position.x === 'number' && typeof position.y === 'number') {
          node.position = { x: position.x, y: position.y };
        }
      }
      if (typeof response.label === 'string') {
        node.title = response.label;
      }
      if (typeof response.content === 'string') {
        node.fullText = response.content;
      }
    }
  }

  async processLink(entry, { keepalive = false } = {}) {
    const { action, from, to, type = 'LINKS_TO', props = {} } = entry;
    if (!from || !to || !action) {
      return false;
    }
    if (action === 'create') {
      await createEdge(
        {
          from,
          to,
          type,
          props,
        },
        { projectId: this.projectId, keepalive }
      );
      return true;
    }
    if (action === 'delete') {
      await deleteEdge(
        {
          from,
          to,
          type,
        },
        { projectId: this.projectId, keepalive }
      );
      return true;
    }
    if (action === 'update') {
      await updateEdge(
        {
          from,
          to,
          type,
          props,
        },
        { projectId: this.projectId, keepalive }
      );
    }
    return false;
  }

  flush(options = {}) {
    const keepalive = options.keepalive === true;
    return this.commit({ keepalive });
  }

  hasPending() {
    return this.pendingNodes.size > 0 || this.pendingLinks.size > 0 || this.inFlight;
  }
}

export const AutosaveStatus = {
  IDLE: STATUS_IDLE,
  DIRTY: STATUS_DIRTY,
  SAVING: STATUS_SAVING,
  SAVED: STATUS_SAVED,
  ERROR: STATUS_ERROR,
};
