import util, { fadeIn, fadeOut, polarToCartesian, randomColor } from './util.js';

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
  constructor(options) {
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
    } = options;

    const layout = options.layout ?? 'radial';
    const pyramidFirstRowCount = Math.max(1, options.pyramidFirstRowCount ?? 1);
    const pyramidRowIncrement = Math.max(0, options.pyramidRowIncrement ?? 1);
    const pyramidHorizontalGap = options.pyramidHorizontalGap ?? 180;
    const pyramidVerticalGap = options.pyramidVerticalGap ?? 160;
    const isManuallyPositioned = Boolean(options.isManuallyPositioned);

    if (!canvas) {
      throw new Error('NodeBase requires a canvas element.');
    }

    this.canvas = canvas;
    this.parent = parent;
    this.title = title;
    this.radius = radius;
    this.color = color;
    this.childOrbit = childOrbit;
    this.children = [];
    this.expanded = false;
    this.dragging = false;
    this.dragStart = { x: 0, y: 0 };
    this.positionStart = { x: 0, y: 0 };
    this.pointerId = null;
    this.pointerTarget = null;
    this.cards = {};
    this.id = id || `node-${++nodeIdCounter}`;
    this.layout = layout;
    this.pyramidFirstRowCount = pyramidFirstRowCount;
    this.pyramidRowIncrement = pyramidRowIncrement;
    this.pyramidHorizontalGap = pyramidHorizontalGap;
    this.pyramidVerticalGap = pyramidVerticalGap;
    this.isManuallyPositioned = isManuallyPositioned;
    this.activeScale = 1;
    this.dragMoved = false;

    this.element = this.createElement();
    this.canvas.appendChild(this.element);
    this.setPosition(x, y, false);
    requestAnimationFrame(() => {
      this.element.classList.add('visible');
    });

    util.log('Node created', this.id, this.title);
  }

  createElement() {
    const node = document.createElement('div');
    node.className = 'node hidden';
    node.dataset.nodeId = this.id;

    const iconBar = document.createElement('div');
    iconBar.className = 'node-icons';

    const createIconButton = (label, action, title) => {
      const button = document.createElement('button');
      button.className = 'node-icon';
      button.dataset.action = action;
      button.type = 'button';
      button.title = title;
      button.textContent = label;
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        this.handleIconAction(action);
      });
      return button;
    };

    iconBar.appendChild(createIconButton('📄', 'data', 'Open data panel'));
    iconBar.appendChild(createIconButton('💬', 'discussion', 'Open discussion panel'));
    iconBar.appendChild(createIconButton('➕', 'add', 'Add child node'));

    const marble = document.createElement('div');
    marble.className = 'node-marble';
    marble.style.background = this.color;

    const titleEl = document.createElement('div');
    titleEl.className = 'node-title';
    titleEl.textContent = this.title;

    marble.appendChild(titleEl);

    node.appendChild(iconBar);
    node.appendChild(marble);

    marble.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    marble.addEventListener('pointerup', (event) => this.onPointerUp(event));
    marble.addEventListener('pointermove', (event) => this.onPointerMove(event));
    marble.addEventListener('pointercancel', (event) => this.onPointerCancel(event));

    return node;
  }

  setPosition(x, y, animate = true) {
    this.position = { x, y };
    const style = this.element.style;
    style.left = `${x}px`;
    style.top = `${y}px`;
    if (!animate) {
      this.element.classList.add('no-transition');
      requestAnimationFrame(() => {
        this.element.classList.remove('no-transition');
      });
    }
  }

  onPointerDown(event) {
    event.stopPropagation();
    this.dragging = true;
    this.pointerId = event.pointerId;
    this.pointerTarget = event.currentTarget;
    this.dragStart.x = event.clientX;
    this.dragStart.y = event.clientY;
    this.positionStart.x = this.position.x;
    this.positionStart.y = this.position.y;
    this.dragMoved = false;
    const rect = this.canvas.getBoundingClientRect();
    const baseWidth = this.canvas.offsetWidth || rect.width;
    this.activeScale = baseWidth ? rect.width / baseWidth : 1;
    if (this.pointerTarget?.setPointerCapture) {
      this.pointerTarget.setPointerCapture(event.pointerId);
    }
    this.element.classList.add('dragging');
  }

  onPointerMove(event) {
    if (!this.dragging || event.pointerId !== this.pointerId) return;
    const dxRaw = event.clientX - this.dragStart.x;
    const dyRaw = event.clientY - this.dragStart.y;
    const dx = dxRaw / this.activeScale;
    const dy = dyRaw / this.activeScale;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (!this.dragMoved && distance > 3) {
      this.dragMoved = true;
    }
    this.setPosition(this.positionStart.x + dx, this.positionStart.y + dy, false);
  }

  onPointerUp(event) {
    if (event.pointerId !== this.pointerId) return;
    if (this.pointerTarget?.hasPointerCapture?.(event.pointerId)) {
      this.pointerTarget.releasePointerCapture(event.pointerId);
    }
    this.dragging = false;
    this.pointerId = null;
    this.pointerTarget = null;
    this.element.classList.remove('dragging');
    if (!this.dragMoved) {
      this.toggleChildren();
    } else {
      this.isManuallyPositioned = true;
    }
    if (this.expanded) {
      this.layoutChildren();
    }
    this.dragMoved = false;
  }

  onPointerCancel(event) {
    if (event.pointerId !== this.pointerId) return;
    if (this.pointerTarget?.hasPointerCapture?.(event.pointerId)) {
      this.pointerTarget.releasePointerCapture(event.pointerId);
    }
    this.dragging = false;
    this.pointerId = null;
    this.pointerTarget = null;
    this.dragMoved = false;
    this.element.classList.remove('dragging');
  }

  toggleChildren() {
    if (!this.children.length) {
      this.handleIconAction('add');
      return;
    }
    this.expanded ? this.collapseChildren() : this.expandChildren();
  }

  expandChildren() {
    if (!this.children.length) return;
    this.expanded = true;
    this.element.classList.add('expanded');
    this.layoutChildren();
  }

  collapseChildren() {
    this.expanded = false;
    this.element.classList.remove('expanded');
    this.children.forEach((child) => {
      child.hide();
      child.collapseChildren();
    });
  }

  layoutChildren() {
    if (!this.expanded || !this.children.length) return;
    if (this.layout === 'pyramid') {
      this.layoutChildrenPyramid();
      return;
    }

    this.children.forEach((child) => child.show());

    const autoChildren = this.children.filter((child) => !child.isManuallyPositioned);
    if (!autoChildren.length) return;

    const count = autoChildren.length;
    const angleStep = (Math.PI * 2) / count;
    autoChildren.forEach((child, index) => {
      const angle = angleStep * index - Math.PI / 2;
      const { x, y } = polarToCartesian(this.childOrbit, angle);
      child.setPosition(this.position.x + x, this.position.y + y);
    });
  }

  layoutChildrenPyramid() {
    this.children.forEach((child) => child.show());

    const autoChildren = this.children.filter((child) => !child.isManuallyPositioned);
    if (!autoChildren.length) return;

    const horizontalGap = this.pyramidHorizontalGap;
    const verticalGap = this.pyramidVerticalGap;
    let index = 0;
    let row = 0;
    let rowSize = this.pyramidFirstRowCount;

    while (index < autoChildren.length) {
      const remaining = autoChildren.length - index;
      const nodesThisRow = Math.min(rowSize, remaining);
      const offset = (nodesThisRow - 1) / 2;
      for (let i = 0; i < nodesThisRow; i += 1) {
        const child = autoChildren[index + i];
        const x = this.position.x + (i - offset) * horizontalGap;
        const y = this.position.y + verticalGap * (row + 1);
        child.setPosition(x, y);
      }
      index += nodesThisRow;
      row += 1;
      rowSize += this.pyramidRowIncrement;
    }
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
    child.hide();
    this.children.push(child);
    if (this.expanded) {
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
      layout: this.layout,
      pyramidFirstRowCount: this.pyramidFirstRowCount,
      pyramidRowIncrement: this.pyramidRowIncrement,
      pyramidHorizontalGap: this.pyramidHorizontalGap,
      pyramidVerticalGap: this.pyramidVerticalGap,
    };
    return this.addChild({ ...defaults, ...config });
  }

  show() {
    fadeIn(this.element);
  }

  hide() {
    fadeOut(this.element);
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
      card.classList.add('visible');
      card.classList.remove('hidden');
    }
  }

  ensureCard(type) {
    if (this.cards[type]) return this.cards[type];
    const host = ensurePanelHost();
    const card = document.createElement('div');
    card.className = 'side-card hidden';
    card.dataset.nodeId = this.id;
    card.dataset.type = type;

    const header = document.createElement('header');
    header.className = 'side-card__header';
    const title = document.createElement('h2');
    title.textContent = `${this.title} — ${type === 'data' ? 'Data' : 'Discussion'}`;
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
        header.querySelector('h2').textContent = `${this.title} — Data`;
      });

      const notesLabel = document.createElement('label');
      notesLabel.textContent = 'Notes';
      const notesArea = document.createElement('textarea');
      notesArea.placeholder = 'Capture notes, ideas, or details...';
      notesArea.value = this.notes || '';
      notesArea.addEventListener('input', (event) => {
        this.notes = event.target.value;
      });

      content.appendChild(nameLabel);
      content.appendChild(nameInput);
      content.appendChild(notesLabel);
      content.appendChild(notesArea);
    } else {
      const discussionArea = document.createElement('textarea');
      discussionArea.placeholder = 'Collaborate and leave feedback...';
      discussionArea.value = this.discussion || '';
      discussionArea.addEventListener('input', (event) => {
        this.discussion = event.target.value;
      });
      content.appendChild(discussionArea);
    }

    card.appendChild(content);
    host.appendChild(card);
    this.cards[type] = card;
    return card;
  }

  setTitle(newTitle) {
    this.title = newTitle || 'Untitled';
    const titleEl = this.element.querySelector('.node-title');
    if (titleEl) {
      titleEl.textContent = this.title;
    }
  }

  static hideOpenCard() {
    if (!NodeBase.openCard) return;
    NodeBase.openCard.classList.remove('visible');
    NodeBase.openCard.classList.add('hidden');
    NodeBase.openCard = null;
  }
}

NodeBase.openCard = null;
NodeBase.panelHost = null;

export default NodeBase;
