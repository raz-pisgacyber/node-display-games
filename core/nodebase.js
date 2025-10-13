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
    this.currentScale = 1;
    this.captureElement = null;
    this.cards = {};
    this.id = id || `node-${++nodeIdCounter}`;

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

  onPointerDown(event) {
    event.stopPropagation();
    this.dragging = true;
    this.pointerId = event.pointerId;
    this.dragStart.x = event.clientX;
    this.dragStart.y = event.clientY;
    this.positionStart.x = this.position.x;
    this.positionStart.y = this.position.y;
    this.currentScale = this.getCanvasScale();
    const captureTarget = event.currentTarget;
    if (captureTarget && captureTarget.setPointerCapture) {
      try {
        captureTarget.setPointerCapture(event.pointerId);
        this.captureElement = captureTarget;
      } catch (error) {
        util.log('Failed to set pointer capture on node', this.id, error);
        this.captureElement = null;
      }
    } else {
      this.captureElement = null;
    }
    this.element.classList.add('dragging');
  }

  onPointerMove(event) {
    if (!this.dragging || event.pointerId !== this.pointerId) return;
    const scale = this.currentScale || 1;
    const dx = (event.clientX - this.dragStart.x) / scale;
    const dy = (event.clientY - this.dragStart.y) / scale;
    this.setPosition(this.positionStart.x + dx, this.positionStart.y + dy);
  }

  onPointerUp(event) {
    if (event.pointerId !== this.pointerId) return;
    if (this.captureElement?.releasePointerCapture) {
      try {
        this.captureElement.releasePointerCapture(event.pointerId);
      } catch (error) {
        util.log('Failed to release pointer capture on node', this.id, error);
      }
    }
    const scale = this.currentScale || 1;
    const dx = Math.abs(event.clientX - this.dragStart.x) / scale;
    const dy = Math.abs(event.clientY - this.dragStart.y) / scale;
    const moved = Math.sqrt(dx * dx + dy * dy) > 6;
    this.dragging = false;
    this.pointerId = null;
    this.currentScale = 1;
    this.captureElement = null;
    this.element.classList.remove('dragging');
    if (!moved) {
      this.toggleChildren();
    } else if (this.parent && this.parent.expanded) {
      this.parent.layoutChildren();
    }
  }

  onPointerCancel(event) {
    if (event.pointerId !== this.pointerId) return;
    if (this.captureElement?.releasePointerCapture) {
      try {
        this.captureElement.releasePointerCapture(event.pointerId);
      } catch (error) {
        util.log('Failed to release pointer capture on cancel for node', this.id, error);
      }
    }
    this.dragging = false;
    this.pointerId = null;
    this.currentScale = 1;
    this.captureElement = null;
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
    const count = this.children.length;
    const angleStep = (Math.PI * 2) / count;
    this.children.forEach((child, index) => {
      const angle = angleStep * index - Math.PI / 2;
      const { x, y } = polarToCartesian(this.childOrbit, angle);
      child.show();
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
