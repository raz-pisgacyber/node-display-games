import util, { fadeIn, fadeOut, polarToCartesian, randomColor } from './util.js';
import { ensureSession } from './session.js';
import { fetchMessages, sendMessage } from '../modules/common/api.js';

let nodeIdCounter = 0;

const PANEL_HOST_CLASS = 'side-panel-host';

const ensurePanelHost = () => {
  if (!NodeBase.panelHost) {
    const host = document.createElement('div');
    host.className = PANEL_HOST_CLASS;
    document.body.appendChild(host);
    NodeBase.panelHost = host;
  }
  return NodeBase.panelHost;
};

class NodeBase {
  constructor(options = {}) {
    const {
      canvas,
      title = 'Untitled',
      x = 0,
      y = 0,
      radius = 60,
      color = randomColor(),
      childOrbit = 220,
      parent = null,
      id = null,
      draggable = true,
    } = options;

    if (!canvas) {
      throw new Error('NodeBase requires a canvas element.');
    }

    this.canvas = canvas;
    this.parent = parent;
    this.title = title;
    this.radius = radius;
    this.baseRadius = radius;
    this.baseSize = radius * 2;
    this.growthFactor = 1;
    this.color = color;
    this.childOrbit = childOrbit;
    this.children = [];
    this.expanded = false;
    this.dragging = false;
    this.pointerSession = null;
    this.currentScale = 1;
    this.cards = {};
    this.manualPosition = false;
    this.id = id || `node-${++nodeIdCounter}`;
    this.draggable = draggable !== false;
    this.projectId = options?.projectId || null;

    const metaFromOptions =
      options?.meta && typeof options.meta === 'object' && !Array.isArray(options.meta)
        ? { ...options.meta }
        : {};
    this.meta = metaFromOptions;

    this.fullText =
      options?.fullText ?? metaFromOptions.fullText ?? options?.content ?? this.fullText ?? '';
    this.notes = options?.notes ?? metaFromOptions.notes ?? this.notes ?? '';
    this.discussion = options?.discussion ?? metaFromOptions.discussion ?? this.discussion ?? '';
    this.legacyDiscussion =
      typeof this.discussion === 'string' && this.discussion.trim() ? this.discussion.trim() : '';

    this.meta.notes = this.notes;
    this.meta.discussion = this.discussion;
    this.meta.fullText = this.fullText;
    this.meta.color = this.meta.color || this.color;
    if (!this.meta.position && typeof x === 'number' && typeof y === 'number') {
      this.meta.position = { x, y };
    }

    /** ✅ PATCH: Ensure every node has a link set for LinkManager */
    this.links = new Set();

    NodeBase.registerInstance(this);

    this.element = this.createElement();
    this.canvas.appendChild(this.element);
    this.setPosition(x, y, false);
    requestAnimationFrame(() => {
      fadeIn(this.element);
    });

    this.updateGrowth();
    this.updateBadge();
    this.updateToggleState();

    util.log('Node created', this.id, this.title);

    this.discussionMessages = [];
    this.discussionLoading = false;
    this.discussionLoadingPromise = null;
    this.discussionError = '';
    this.discussionInitialized = false;
    this.discussionSending = false;
    this.discussionSilent = false;
    this.discussionUI = null;
  }

  createElement() {
    const node = document.createElement('div');
    node.className = 'node hidden';
    node.dataset.nodeId = this.id;

    const iconBar = document.createElement('div');
    iconBar.className = 'node-icons';
    this.iconBar = iconBar;

    this.getIconDefinitions().forEach((icon) => {
      const button = this.createIconButton(icon);
      if (button) {
        iconBar.appendChild(button);
      }
    });

    const toggle = document.createElement('button');
    toggle.className = 'node-toggle';
    toggle.type = 'button';
    toggle.title = 'Expand or collapse children';
    toggle.textContent = '▾';
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      NodeBase.setLastInteractedNode?.(this);
      this.toggleChildren();
    });
    iconBar.appendChild(toggle);
    this.toggleButton = toggle;

    const marble = document.createElement('div');
    marble.className = 'node-marble';
    marble.style.setProperty('--node-color', this.color);
    marble.style.setProperty('--node-size', `${this.baseSize}px`);
    this.marbleElement = marble;

    const titleEl = document.createElement('div');
    titleEl.className = 'node-title';
    titleEl.textContent = this.title;
    this.titleElement = titleEl;

    marble.appendChild(titleEl);

    const badge = document.createElement('span');
    badge.className = 'node-marble__badge';
    badge.style.display = 'none';
    marble.appendChild(badge);
    this.badgeElement = badge;

    node.appendChild(iconBar);
    node.appendChild(marble);

    marble.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    marble.addEventListener('pointerup', (event) => this.onPointerUp(event));
    marble.addEventListener('pointermove', (event) => this.onPointerMove(event));
    marble.addEventListener('pointercancel', (event) => this.onPointerCancel(event));

    return node;
  }

  getIconDefinitions() {
    return [
      { label: '📄', action: 'data', title: 'Open data panel' },
      { label: '💬', action: 'discussion', title: 'Open discussion panel' },
      { label: '➕', action: 'add', title: 'Add child node' },
      { label: '📝', action: 'text', title: 'Open full text editor' },
    ];
  }

  createIconButton(icon) {
    const { label, action, title, className } = icon;
    if (!label || !action) {
      return null;
    }
    const button = document.createElement('button');
    button.className = className ? `node-icon ${className}` : 'node-icon';
    button.dataset.action = action;
    button.type = 'button';
    if (title) {
      button.title = title;
    }
    button.textContent = label;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      NodeBase.setLastInteractedNode?.(this);
      this.handleIconAction(action);
    });
    return button;
  }

  getGrowthCount() {
    return this.children.length;
  }

  getBadgeValue() {
    return this.getGrowthCount();
  }

  updateGrowth() {
    if (!this.marbleElement) {
      return;
    }
    const count = Math.max(0, this.getGrowthCount());
    const factor = 1 + count * 0.1;
    this.growthFactor = factor;
    const size = this.baseSize * factor;
    this.marbleElement.style.setProperty('--node-size', `${size}px`);
  }

  updateBadge() {
    if (!this.badgeElement) {
      return;
    }
    const value = this.getBadgeValue();
    if (value > 0) {
      this.badgeElement.textContent = value;
      this.badgeElement.style.display = '';
    } else {
      this.badgeElement.textContent = '';
      this.badgeElement.style.display = 'none';
    }
  }

  updateToggleState() {
    if (!this.toggleButton) {
      return;
    }
    const hasChildren = this.children.length > 0;
    this.toggleButton.disabled = !hasChildren;
    this.toggleButton.style.visibility = hasChildren ? 'visible' : 'hidden';
  }

  onChildrenChanged() {
    this.updateGrowth();
    this.updateBadge();
    this.updateToggleState();
  }

  onConnectionsChanged() {
    this.updateGrowth();
    this.updateBadge();
  }

  setPosition(x, y, animate = true) {
    this.position = { x, y };
    if (!this.meta || typeof this.meta !== 'object') {
      this.meta = {};
    }
    this.meta.position = { x, y };
    const style = this.element.style;
    style.left = `${x}px`;
    style.top = `${y}px`;
    if (!animate) {
      this.element.classList.add('no-transition');
      requestAnimationFrame(() => {
        this.element.classList.remove('no-transition');
      });
    }
    NodeBase.activeLinkManager?.updateLinksForNode?.(this);
    if (NodeBase.openCardOwner === this && NodeBase.openCard) {
      this.positionCard(NodeBase.openCard);
    }
  }

  getCanvasScale() {
    if (!this.canvas) {
      return 1;
    }

    const { scale } = this.canvas.dataset;
    if (scale) {
      const parsed = parseFloat(scale);
      if (!Number.isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    }

    const transform = window.getComputedStyle(this.canvas).transform;
    if (!transform || transform === 'none') {
      return 1;
    }

    try {
      const DOMMatrixCtor = window.DOMMatrixReadOnly || window.DOMMatrix;
      if (DOMMatrixCtor) {
        const matrix = new DOMMatrixCtor(transform);
        return matrix.a || 1;
      }
    } catch (error) {
      util.log('Failed to parse canvas scale from transform', error);
    }

    return 1;
  }

  beginPointerSession(event) {
    const captureElement = event.currentTarget;
    if (!captureElement || typeof captureElement.setPointerCapture !== 'function') {
      return null;
    }

    const session = {
      id: event.pointerId,
      captureElement,
      startClient: { x: event.clientX, y: event.clientY },
      startPosition: { x: this.position.x, y: this.position.y },
      moved: false,
    };

    captureElement.setPointerCapture(event.pointerId);
    return session;
  }

  endPointerSession(event, session, cancelled = false) {
    const { captureElement, startClient } = session;
    if (captureElement?.hasPointerCapture?.(event.pointerId)) {
      captureElement.releasePointerCapture(event.pointerId);
    }

    const scale = this.currentScale || 1;
    const dx = Math.abs(event.clientX - startClient.x) / scale;
    const dy = Math.abs(event.clientY - startClient.y) / scale;
    const moved = session.moved || Math.sqrt(dx * dx + dy * dy) > 6;

    this.dragging = false;
    this.pointerSession = null;
    this.currentScale = 1;
    this.element.classList.remove('dragging');

    if (cancelled) {
      return;
    }

    if (!moved) {
      this.toggleChildren();
    } else if (this.parent && this.parent.expanded) {
      this.parent.layoutChildren();
    }
    if (moved) {
      if (!this.meta || typeof this.meta !== 'object') {
        this.meta = {};
      }
      this.meta.position = { ...(this.position || { x: 0, y: 0 }) };
      this.meta.manualPosition = !!this.manualPosition;
      this.notifyMutation('position');
    }
  }

  onPointerDown(event) {
    if (event.button !== 0) return;

    const linkManager = NodeBase.getActiveLinkManager();
    if (linkManager?.consumeNodePointerDown?.(this, event)) {
      event.stopPropagation();
      event.preventDefault();
      return;
    }

    event.stopPropagation();
    NodeBase.setLastInteractedNode?.(this);

    if (this.pointerSession) {
      return;
    }

    this.currentScale = this.getCanvasScale();
    const session = this.beginPointerSession(event);
    if (!session) {
      return;
    }

    this.pointerSession = session;
    if (this.draggable) {
      this.dragging = true;
      this.element.classList.add('dragging');
    }
  }

  onPointerMove(event) {
    const session = this.pointerSession;
    if (!this.dragging || !session || event.pointerId !== session.id) return;

    this.currentScale = this.getCanvasScale();
    const scale = this.currentScale || 1;
    const dx = (event.clientX - session.startClient.x) / scale;
    const dy = (event.clientY - session.startClient.y) / scale;

    if (!session.moved && (Math.abs(dx) > 0 || Math.abs(dy) > 0)) {
      session.moved = true;
      this.manualPosition = true;
      if (!this.meta || typeof this.meta !== 'object') {
        this.meta = {};
      }
      this.meta.manualPosition = true;
    }

    this.setPosition(session.startPosition.x + dx, session.startPosition.y + dy);
  }

  onPointerUp(event) {
    const session = this.pointerSession;
    if (!session || event.pointerId !== session.id) return;
    this.endPointerSession(event, session, false);
  }

  onPointerCancel(event) {
    const session = this.pointerSession;
    if (!session || event.pointerId !== session.id) return;
    this.endPointerSession(event, session, true);
  }

  toggleChildren() {
    if (!this.children.length) {
      return;
    }
    this.expanded ? this.collapseChildren() : this.expandChildren();
  }

  expandChildren() {
    if (!this.children.length) return;
    this.expanded = true;
    this.element.classList.add('expanded');
    this.layoutChildren();
    this.children.forEach((child) => child.show());
    this.updateToggleState();
  }

  collapseChildren() {
    this.expanded = false;
    this.element.classList.remove('expanded');
    this.children.forEach((child) => {
      child.hide();
      child.collapseChildren();
    });
    this.updateToggleState();
  }

  layoutChildren() {
    if (!this.expanded || !this.children.length) return;
    const count = this.children.length;
    const angleStep = (Math.PI * 2) / count;
    this.children.forEach((child, index) => {
      child.show();
      if (child.manualPosition) {
        return;
      }
      const angle = angleStep * index - Math.PI / 2;
      const { x, y } = polarToCartesian(this.childOrbit, angle);
      child.setPosition(this.position.x + x, this.position.y + y);
    });
  }

  addChild(nodeOrConfig) {
    let child = nodeOrConfig;
    if (!(child instanceof NodeBase)) {
      child = new NodeBase({
        canvas: this.canvas,
        parent: this,
        ...nodeOrConfig,
      });
    } else {
      child.parent = this;
    }
    if (!child.projectId && this.projectId) {
      child.projectId = this.projectId;
    }
    child.manualPosition = false;
    this.children.push(child);
    if (!this.expanded) {
      child.hide();
    }
    this.onChildrenChanged();
    if (this.expanded) {
      child.show();
      this.layoutChildren();
    }
    return child;
  }

  createChild(config = {}) {
    const defaults = {
      title: 'New Node',
      color: randomColor(),
      x: this.position.x + 80,
      y: this.position.y + 80,
      childOrbit: this.childOrbit * 0.8,
      projectId: this.projectId,
    };
    return this.addChild({ ...defaults, ...config });
  }

  show() {
    fadeIn(this.element);
    NodeBase.activeLinkManager?.updateLinksForNode?.(this);
  }

  hide() {
    fadeOut(this.element);
    NodeBase.activeLinkManager?.updateLinksForNode?.(this);
  }

  handleIconAction(action) {
    switch (action) {
      case 'data':
        this.toggleCard('data');
        break;
      case 'discussion':
        this.toggleCard('discussion');
        break;
      case 'add':
        this.onAddChild();
        break;
      case 'text':
        this.toggleCard('text');
        break;
      case 'toggle':
        this.toggleChildren();
        break;
      default:
        break;
    }
  }

  onAddChild() {
    const label = window.prompt('Enter a title for the new node');
    if (!label) return;
    const child = this.createChild({ title: label });
    child.hide();
    if (!this.expanded) {
      this.expandChildren();
    } else {
      this.layoutChildren();
    }
  }

  toggleCard(type) {
    const card = this.ensureCard(type);
    const isVisible = card.classList.contains('visible');
    NodeBase.hideOpenCard();
    if (!isVisible) {
      NodeBase.openCard = card;
      NodeBase.openCardOwner = this;
      card.classList.add('visible');
      card.classList.remove('hidden');
      this.positionCard(card);
      if (type === 'discussion') {
        this.onDiscussionCardOpened(card);
      }
      requestAnimationFrame(() => {
        if (NodeBase.openCard === card) {
          this.positionCard(card);
        }
      });
    }
  }

  ensureCard(type) {
    if (this.cards[type]) return this.cards[type];
    const host = ensurePanelHost();
    NodeBase.attachCardPositionListeners?.();
    const card = document.createElement('div');
    card.className = 'side-card hidden';
    card.dataset.nodeId = this.id;
    card.dataset.type = type;

    const header = document.createElement('header');
    header.className = 'side-card__header';
    const title = document.createElement('h2');
    title.textContent = this.getCardTitle(type);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'side-card__close';
    close.textContent = '✕';
    close.title = 'Close';
    close.addEventListener('click', () => {
      NodeBase.hideOpenCard();
    });

    header.appendChild(title);
    header.appendChild(close);
    card.appendChild(header);

    const content = document.createElement('div');
    content.className = 'side-card__content';

    if (type === 'data') {
      const nameLabel = document.createElement('label');
      nameLabel.textContent = 'Title';
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.value = this.title;
      nameInput.addEventListener('input', (event) => {
        this.setTitle(event.target.value);
        header.querySelector('h2').textContent = this.getCardTitle('data');
      });

      const notesLabel = document.createElement('label');
      notesLabel.textContent = 'Notes';
      const notesArea = document.createElement('textarea');
      notesArea.placeholder = 'Capture notes, ideas, or details...';
      notesArea.value = this.notes || '';
      notesArea.addEventListener('input', (event) => {
        this.notes = event.target.value;
        if (!this.meta || typeof this.meta !== 'object') {
          this.meta = {};
        }
        this.meta.notes = this.notes;
        this.notifyMutation('notes');
      });

      content.appendChild(nameLabel);
      content.appendChild(nameInput);
      content.appendChild(notesLabel);
      content.appendChild(notesArea);
    } else if (type === 'discussion') {
      this.buildDiscussionCard(content);
    } else if (type === 'text') {
      const intro = document.createElement('p');
      intro.textContent = 'Draft the full chapter, scene, or moment here. Changes are saved automatically.';
      intro.style.fontSize = '13px';
      intro.style.color = 'var(--muted)';
      content.appendChild(intro);

      const textArea = document.createElement('textarea');
      textArea.placeholder = 'Write your narrative flow, beats, and detailed prose...';
      textArea.value = this.fullText || '';
      textArea.rows = 12;
      textArea.addEventListener('input', (event) => {
        this.fullText = event.target.value;
        if (!this.meta || typeof this.meta !== 'object') {
          this.meta = {};
        }
        this.meta.fullText = this.fullText;
        this.notifyMutation('fullText');
      });
      content.appendChild(textArea);
    }

    card.appendChild(content);
    host.appendChild(card);
    this.cards[type] = card;
    return card;
  }

  buildDiscussionCard(container) {
    container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'discussion-chat';

    const history = document.createElement('div');
    history.className = 'discussion-chat__history';

    const list = document.createElement('div');
    list.className = 'discussion-chat__messages';
    history.appendChild(list);

    const empty = document.createElement('p');
    empty.className = 'discussion-chat__empty';
    history.appendChild(empty);

    wrapper.appendChild(history);

    const status = document.createElement('div');
    status.className = 'discussion-chat__status';
    wrapper.appendChild(status);

    const composer = document.createElement('div');
    composer.className = 'discussion-chat__composer';

    const input = document.createElement('textarea');
    input.className = 'discussion-chat__input';
    input.rows = 3;
    composer.appendChild(input);

    const controls = document.createElement('div');
    controls.className = 'discussion-chat__controls';

    const actionButton = document.createElement('button');
    actionButton.type = 'button';
    actionButton.className = 'discussion-chat__action';
    actionButton.textContent = 'Action';
    actionButton.title = 'Action shortcuts coming soon';
    controls.appendChild(actionButton);

    const sendButton = document.createElement('button');
    sendButton.type = 'button';
    sendButton.className = 'discussion-chat__send';
    sendButton.textContent = 'Send';
    controls.appendChild(sendButton);

    composer.appendChild(controls);
    wrapper.appendChild(composer);

    container.appendChild(wrapper);

    this.discussionUI = {
      wrapper,
      history,
      list,
      empty,
      status,
      input,
      sendButton,
      actionButton,
    };

    input.addEventListener('input', () => {
      this.renderDiscussionStatus();
      this.updateDiscussionComposerState();
    });

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        this.handleDiscussionSend();
      }
    });

    sendButton.addEventListener('click', () => {
      this.handleDiscussionSend();
    });

    this.renderDiscussionMessages();
    this.renderDiscussionStatus();
    this.updateDiscussionComposerState();
  }

  onDiscussionCardOpened(card) {
    if (!card) {
      return;
    }
    if (!this.discussionUI) {
      const content = card.querySelector('.side-card__content');
      if (content) {
        this.buildDiscussionCard(content);
      }
    }
    this.updateDiscussionComposerState();
    this.renderDiscussionStatus();
    this.loadDiscussionMessages({ force: true, showSpinner: !this.discussionInitialized });
  }

  async loadDiscussionMessages({ force = false, showSpinner = true } = {}) {
    if (this.discussionLoading) {
      return this.discussionLoadingPromise;
    }
    if (!force && this.discussionInitialized) {
      return this.discussionMessages;
    }
    if (!this.projectId) {
      this.discussionError = 'Project context missing. Unable to load chat history.';
      this.renderDiscussionStatus();
      return this.discussionMessages;
    }

    this.discussionLoading = true;
    this.discussionSilent = !showSpinner;
    this.renderDiscussionStatus();

    const promise = (async () => {
      try {
        const session = await ensureSession(this.projectId);
        const response = await fetchMessages({
          sessionId: session?.id,
          projectId: this.projectId,
          nodeId: this.id,
          limit: 120,
        });
        const rawMessages = Array.isArray(response?.messages)
          ? response.messages
          : Array.isArray(response)
          ? response
          : [];
        const ordered = [...rawMessages].reverse();
        this.discussionMessages = ordered;
        this.discussionInitialized = true;
        this.discussionError = '';
        this.renderDiscussionMessages({ scroll: true });
        this.updateDiscussionComposerState();
        return ordered;
      } catch (error) {
        console.warn('Failed to load discussion messages', error);
        this.discussionError = error?.message || 'Failed to load discussion history.';
        this.renderDiscussionMessages();
        this.renderDiscussionStatus();
        return this.discussionMessages;
      } finally {
        this.discussionLoading = false;
        this.discussionSilent = false;
        this.discussionLoadingPromise = null;
        this.renderDiscussionStatus();
      }
    })();

    this.discussionLoadingPromise = promise;
    return promise;
  }

  getRenderableDiscussionMessages() {
    const messages = Array.isArray(this.discussionMessages) ? this.discussionMessages : [];
    if (messages.length === 0 && this.legacyDiscussion) {
      return [
        {
          id: 'legacy',
          role: 'user',
          content: this.legacyDiscussion,
          created_at: null,
          legacy: true,
        },
      ];
    }
    return messages;
  }

  getDiscussionRoleClass(role) {
    if (role === 'user') {
      return 'discussion-chat__message--user';
    }
    if (role === 'tool_result') {
      return 'discussion-chat__message--tool';
    }
    return 'discussion-chat__message--ai';
  }

  getDiscussionRoleLabel(message) {
    if (message?.legacy) {
      return 'Legacy note';
    }
    if (message?.optimistic) {
      return 'Sending…';
    }
    switch (message?.role) {
      case 'user':
        return 'You';
      case 'planner':
        return 'AI Planner';
      case 'doer':
        return 'AI Doer';
      case 'tool_result':
        return 'Tool';
      case 'reflector':
      default:
        return 'AI';
    }
  }

  formatDiscussionTimestamp(value) {
    if (!value) {
      return '';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return '';
    }
    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();
    const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (sameDay) {
      return time;
    }
    return `${date.toLocaleDateString()} ${time}`;
  }

  renderDiscussionMessages({ scroll = false } = {}) {
    if (!this.discussionUI) {
      return;
    }
    const { list, empty } = this.discussionUI;
    if (!list || !empty) {
      return;
    }

    const messages = this.getRenderableDiscussionMessages();

    list.innerHTML = '';

    if (messages.length === 0) {
      empty.textContent = this.projectId
        ? 'Start a conversation with your AI collaborator.'
        : 'Select a project to start chatting.';
      empty.style.display = 'block';
    } else {
      empty.style.display = 'none';
    }

    messages.forEach((message) => {
      const item = document.createElement('div');
      item.className = `discussion-chat__message ${this.getDiscussionRoleClass(message.role)}`;
      if (message.optimistic) {
        item.classList.add('discussion-chat__message--pending');
      }

      const bubble = document.createElement('div');
      bubble.className = 'discussion-chat__bubble';
      bubble.textContent = message.content || '';
      item.appendChild(bubble);

      const label = this.getDiscussionRoleLabel(message);
      const timestamp = message.optimistic ? '' : this.formatDiscussionTimestamp(message.created_at);
      if (label || timestamp) {
        const meta = document.createElement('span');
        meta.className = 'discussion-chat__meta';
        if (label && timestamp) {
          meta.textContent = `${label} · ${timestamp}`;
        } else if (label) {
          meta.textContent = label;
        } else {
          meta.textContent = timestamp;
        }
        item.appendChild(meta);
      }

      list.appendChild(item);
    });

    if (scroll) {
      this.scrollDiscussionToBottom();
    }
  }

  renderDiscussionStatus() {
    if (!this.discussionUI?.status) {
      return;
    }
    const status = this.discussionUI.status;
    status.textContent = '';
    status.className = 'discussion-chat__status';

    if (!this.projectId) {
      status.textContent = 'Project context missing. Chat is unavailable.';
      status.classList.add('discussion-chat__status--muted');
      return;
    }

    if (this.discussionError) {
      status.textContent = this.discussionError;
      status.classList.add('discussion-chat__status--error');
      return;
    }

    if (this.discussionSending) {
      status.textContent = 'Sending…';
      status.classList.add('discussion-chat__status--info');
      return;
    }

    if (this.discussionLoading && !this.discussionSilent) {
      status.textContent = 'Loading conversation…';
      status.classList.add('discussion-chat__status--info');
    }
  }

  updateDiscussionComposerState() {
    if (!this.discussionUI) {
      return;
    }
    const { input, sendButton } = this.discussionUI;
    if (!input || !sendButton) {
      return;
    }
    const trimmed = input.value.trim();
    const canSend = Boolean(trimmed) && !this.discussionSending && Boolean(this.projectId);
    sendButton.disabled = !canSend;
    input.disabled = this.discussionSending || !this.projectId;
    input.placeholder = this.projectId
      ? 'Chat with your AI co-creator… (Shift+Enter for a new line)'
      : 'Select a project to start chatting.';
  }

  scrollDiscussionToBottom() {
    if (!this.discussionUI?.history) {
      return;
    }
    requestAnimationFrame(() => {
      const history = this.discussionUI?.history;
      if (history) {
        history.scrollTop = history.scrollHeight;
      }
    });
  }

  async handleDiscussionSend() {
    if (this.discussionSending || !this.discussionUI) {
      return;
    }
    const value = this.discussionUI.input?.value ?? '';
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    if (!this.projectId) {
      this.discussionError = 'Project context missing. Unable to send message.';
      this.renderDiscussionStatus();
      return;
    }

    this.discussionUI.input.value = '';
    this.discussionSending = true;
    this.discussionError = '';
    this.updateDiscussionComposerState();
    this.renderDiscussionStatus();

    let session;
    try {
      session = await ensureSession(this.projectId);
    } catch (error) {
      console.warn('Failed to establish session for discussion', error);
      this.discussionError = error?.message || 'Failed to start chat session.';
      this.discussionSending = false;
      this.renderDiscussionStatus();
      this.updateDiscussionComposerState();
      return;
    }

    const optimistic = {
      id: `local-${Date.now()}`,
      role: 'user',
      content: trimmed,
      created_at: new Date().toISOString(),
      optimistic: true,
    };
    this.discussionMessages = [...this.discussionMessages, optimistic];
    this.renderDiscussionMessages({ scroll: true });

    try {
      await sendMessage({ sessionId: session.id, nodeId: this.id, role: 'user', content: trimmed });
      await this.loadDiscussionMessages({ force: true, showSpinner: false });
    } catch (error) {
      console.warn('Failed to send discussion message', error);
      this.discussionMessages = this.discussionMessages.filter((msg) => msg !== optimistic);
      this.discussionError = error?.message || 'Failed to send message.';
      this.renderDiscussionMessages();
    } finally {
      this.discussionSending = false;
      this.renderDiscussionStatus();
      this.updateDiscussionComposerState();
    }
  }

  positionCard(card) {
    if (!card || !this.marbleElement) {
      return;
    }

    const marbleRect = this.marbleElement.getBoundingClientRect();
    if (!marbleRect?.width && !marbleRect?.height) {
      return;
    }

    const cardWidth = card.offsetWidth || card.getBoundingClientRect().width;
    const cardHeight = card.offsetHeight || card.getBoundingClientRect().height;

    if (!cardWidth || !cardHeight) {
      return;
    }

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const padding = 16;

    let left = marbleRect.right + padding;
    let top = marbleRect.top;
    let horizontal = 'right';

    if (left + cardWidth > viewportWidth - padding) {
      left = marbleRect.left - cardWidth - padding;
      horizontal = 'left';
    }

    if (left < padding) {
      left = Math.max(padding, Math.min(viewportWidth - cardWidth - padding, marbleRect.left + padding));
    }

    const maxTop = viewportHeight - cardHeight - padding;
    let anchoredTop = marbleRect.top;

    if (anchoredTop < padding) {
      anchoredTop = padding;
    }

    if (anchoredTop > maxTop) {
      anchoredTop = Math.max(padding, Math.min(maxTop, marbleRect.bottom - cardHeight));
    }

    top = Math.min(Math.max(anchoredTop, padding), maxTop);

    const anchoredAbove = top <= marbleRect.top;

    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
    card.style.right = 'auto';
    card.style.bottom = 'auto';
    card.dataset.anchor = horizontal;
    card.dataset.verticalAnchor = anchoredAbove ? 'top' : 'bottom';
    card.style.setProperty('--card-shift-x', horizontal === 'left' ? '-24px' : '24px');
    card.style.setProperty('--card-shift-y', anchoredAbove ? '-12px' : '12px');
  }

  setTitle(newTitle) {
    const trimmed = typeof newTitle === 'string' ? newTitle.trim() : '';
    this.title = trimmed || 'Untitled';
    const titleEl = this.element.querySelector('.node-title');
    if (titleEl) {
      titleEl.textContent = this.title;
    }
    this.refreshCardHeaders();
    NodeBase.activeLinkManager?.updateLinkTitlesForNode?.(this);
    if (!this.meta || typeof this.meta !== 'object') {
      this.meta = {};
    }
    this.meta.title = this.title;
    this.notifyMutation('title');
  }

  getCardTitle(type) {
    switch (type) {
      case 'data':
        return `${this.title} — Data`;
      case 'discussion':
        return `${this.title} — Discussion`;
      case 'text':
        return `${this.title} — Full Text`;
      default:
        return this.title;
    }
  }

  refreshCardHeaders() {
    Object.entries(this.cards).forEach(([type, card]) => {
      if (!card) return;
      const heading = card.querySelector('h2');
      if (heading) {
        heading.textContent = this.getCardTitle(type);
      }
    });
  }

  notifyMutation(reason, detail = {}) {
    if (typeof document === 'undefined' || typeof CustomEvent === 'undefined') {
      return;
    }
    const eventDetail = {
      node: this,
      reason,
      detail,
    };
    document.dispatchEvent(
      new CustomEvent('builder:node-mutated', {
        detail: eventDetail,
      })
    );
  }

  toPersistence() {
    const position = this.position || this.meta?.position || { x: 0, y: 0 };
    const meta = {
      ...(this.meta || {}),
      notes: this.notes || '',
      discussion: this.discussion || '',
      fullText: this.fullText || '',
      position: { x: position.x || 0, y: position.y || 0 },
      color: this.color,
    };
    return {
      id: this.id,
      label: this.title || 'Untitled',
      content: this.fullText || '',
      meta,
    };
  }

  static hideOpenCard() {
    if (!NodeBase.openCard) return;
    NodeBase.openCard.classList.remove('visible');
    NodeBase.openCard.classList.add('hidden');
    NodeBase.openCard = null;
    NodeBase.openCardOwner = null;
  }
}

NodeBase.openCard = null;
NodeBase.panelHost = null;
NodeBase.activeLinkManager = null;
NodeBase.instances = new Map();
NodeBase.lastInteractedNode = null;
NodeBase.openCardOwner = null;
NodeBase.cardListenersAttached = false;

NodeBase.registerInstance = function registerInstance(instance) {
  if (!instance?.id) {
    return;
  }
  NodeBase.instances.set(instance.id, instance);
};

NodeBase.unregisterInstance = function unregisterInstance(instance) {
  if (!instance?.id) {
    return;
  }
  if (NodeBase.openCardOwner === instance) {
    NodeBase.hideOpenCard();
  }
  NodeBase.instances.delete(instance.id);
};

NodeBase.getNodeById = function getNodeById(id) {
  return NodeBase.instances.get(id) || null;
};

NodeBase.getNodeFromElement = function getNodeFromElement(element) {
  if (!element) {
    return null;
  }
  const nodeEl = element.closest?.('.node');
  if (!nodeEl) {
    return null;
  }
  const { nodeId } = nodeEl.dataset;
  if (!nodeId) {
    return null;
  }
  return NodeBase.getNodeById(nodeId);
};

NodeBase.setActiveLinkManager = function setActiveLinkManager(manager) {
  NodeBase.activeLinkManager = manager || null;
};

NodeBase.getActiveLinkManager = function getActiveLinkManager() {
  return NodeBase.activeLinkManager || null;
};

NodeBase.setLastInteractedNode = function setLastInteractedNode(node) {
  if (node instanceof NodeBase) {
    NodeBase.lastInteractedNode = node;
  } else if (!node) {
    NodeBase.lastInteractedNode = null;
  }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    const detail = node instanceof NodeBase
      ? { nodeId: node.id ?? null, builder: node.meta?.builder ?? '' }
      : { nodeId: null, builder: '' };
    try {
      window.dispatchEvent(new CustomEvent('nodebase:last-interacted', { detail }));
    } catch (error) {
      console.warn('Failed to dispatch node interaction event', error);
    }
  }
};

NodeBase.getLastInteractedNode = function getLastInteractedNode() {
  return NodeBase.lastInteractedNode || null;
};

NodeBase.repositionOpenCard = function repositionOpenCard() {
  if (!NodeBase.openCard || !NodeBase.openCardOwner) {
    return;
  }
  NodeBase.openCardOwner.positionCard(NodeBase.openCard);
};

NodeBase.attachCardPositionListeners = function attachCardPositionListeners() {
  if (NodeBase.cardListenersAttached) {
    return;
  }
  const handler = () => NodeBase.repositionOpenCard();
  window.addEventListener('resize', handler);
  window.addEventListener('scroll', handler, true);
  document.addEventListener('workspace:transform', handler);
  NodeBase.cardListenersAttached = true;
};

export default NodeBase;
