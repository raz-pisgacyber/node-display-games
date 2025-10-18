import NodeBase from '../../core/nodebase.js';
import util, { enableZoomPan, ensureCanvas } from '../../core/util.js';
import { ElementNode, CharacterNode, PlaceNode, OtherNode } from './ElementNode.js';
import LinkManager from './LinkManager.js';

class AddElementNode extends NodeBase {
  constructor(options = {}) {
    super({
      title: options.title ?? 'Add Element',
      color: options.color ?? '#a29bfe',
      radius: 90,
      childOrbit: options.childOrbit ?? 280,
      draggable: false,
      ...options,
    });

    this.onRequestAdd = options.onRequestAdd;
    this.element.classList.add('add-element-node');
    this.element.classList.add('expanded');
    this.expanded = true;
    if (this.iconBar) {
      this.iconBar.remove();
      this.iconBar = null;
    }
    if (this.toggleButton) {
      this.toggleButton.remove();
      this.toggleButton = null;
    }
    if (this.badgeElement) {
      this.badgeElement.style.display = 'none';
    }
    if (this.titleElement) {
      this.titleElement.textContent = '➕ Add Element';
    }
  }

  getIconDefinitions() {
    return [];
  }

  toggleChildren() {
    if (typeof this.onRequestAdd === 'function') {
      this.onRequestAdd(this);
    }
  }

  onAddChild() {
    this.toggleChildren();
  }

  layoutChildren() {
    if (!this.children.length) {
      return;
    }
    const perRow = 4;
    const spacingX = this.childOrbit * 0.9;
    const spacingY = this.childOrbit * 0.75;
    this.children.forEach((child, index) => {
      child.show();
      if (child.manualPosition) {
        return;
      }
      const row = Math.floor(index / perRow);
      const rowStartIndex = row * perRow;
      const itemsInRow = Math.min(perRow, this.children.length - rowStartIndex);
      const indexInRow = index - rowStartIndex;
      const offsetX = (indexInRow - (itemsInRow - 1) / 2) * spacingX;
      const offsetY = (row + 1) * spacingY;
      child.setPosition(this.position.x + offsetX, this.position.y + offsetY);
    });
  }

  spawnElementNode({ title, type }) {
    const normalizedType = ElementNode.normaliseType(type);
    const element = ElementNode.createNode(normalizedType, {
      canvas: this.canvas,
      parent: this,
      title,
      x: this.position.x,
      y: this.position.y + this.childOrbit,
    });
    const added = super.addChild(element);
    this.expandChildren();
    element.manualPosition = false;
    return added;
  }
}

const createElementModal = ({ onSubmit, onClose } = {}) => {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const card = document.createElement('div');
  card.className = 'modal-card';

  const heading = document.createElement('h2');
  heading.textContent = 'Create new element';
  card.appendChild(heading);

  const form = document.createElement('form');

  const nameLabel = document.createElement('label');
  nameLabel.textContent = 'Name';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.required = true;
  nameInput.placeholder = 'e.g. Protagonist, City of Glass';
  form.appendChild(nameLabel);
  form.appendChild(nameInput);

  const typeLabel = document.createElement('label');
  typeLabel.textContent = 'Type';
  const typeSelect = document.createElement('select');
  const typeOptions = [
    ['character', 'Character'],
    ['place', 'Place'],
    ['item', 'Item'],
    ['theme', 'Theme'],
    ['other', 'Other'],
  ];
  typeOptions.forEach(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    typeSelect.appendChild(option);
  });
  form.appendChild(typeLabel);
  form.appendChild(typeSelect);

  const actions = document.createElement('div');
  actions.className = 'modal-card__actions';

  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'modal-card__button';
  cancelButton.textContent = 'Cancel';

  const submitButton = document.createElement('button');
  submitButton.type = 'submit';
  submitButton.className = 'modal-card__button modal-card__button--primary';
  submitButton.textContent = 'Create';

  actions.appendChild(cancelButton);
  actions.appendChild(submitButton);
  form.appendChild(actions);
  card.appendChild(form);
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  let closed = false;

  const teardown = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener('keydown', onKeyDown);
    onClose?.();
  };

  const cancel = () => {
    teardown();
  };

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    }
  };

  document.addEventListener('keydown', onKeyDown);

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      cancel();
    }
  });

  cancelButton.addEventListener('click', cancel);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      return;
    }
    const type = typeSelect.value;
    onSubmit?.({ name, type });
    teardown();
  });

  nameInput.focus();

  return { close: teardown };
};

const init = () => {
  const workspace = document.getElementById('workspace');
  if (!workspace) {
    util.log('Workspace element missing for elements builder.');
    return;
  }

  const canvas = ensureCanvas(workspace, { width: 2800, height: 2200 });

  const { clientWidth, clientHeight } = workspace;
  const centerX = clientWidth / 2;
  const centerY = Math.max(220, clientHeight * 0.22);

  const linkManager = new LinkManager(canvas);
  ElementNode.attachLinkManager(linkManager);

  let activeModal = null;
  let addNode;

  const openCreationModal = () => {
    if (activeModal) {
      return;
    }
    activeModal = createElementModal({
      onSubmit: ({ name, type }) => {
        if (!addNode) {
          return;
        }
        const node = addNode.spawnElementNode({ title: name, type });
        NodeBase.setLastInteractedNode(node);
      },
      onClose: () => {
        activeModal = null;
      },
    });
  };

  addNode = new AddElementNode({
    canvas,
    x: centerX,
    y: centerY,
    onRequestAdd: openCreationModal,
  });

  NodeBase.setLastInteractedNode(addNode);

  const addButton = document.getElementById('add-element');
  if (addButton) {
    addButton.addEventListener('click', openCreationModal);
  }

  const viewport = enableZoomPan(workspace, canvas, {
    minScale: 0.5,
    maxScale: 2.6,
  });

  util.log('Elements builder initialised.');

  window.builder = {
    util,
    addNode,
    ElementNode,
    CharacterNode,
    PlaceNode,
    OtherNode,
    LinkManager,
    linkManager,
    viewport,
  };
};

document.addEventListener('DOMContentLoaded', init);
