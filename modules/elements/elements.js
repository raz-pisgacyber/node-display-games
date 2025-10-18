import NodeBase from '../../core/nodebase.js';
import util, { enableZoomPan, ensureCanvas } from '../../core/util.js';
import { ElementNode, CharacterNode, PlaceNode, OtherNode } from './ElementNode.js';
import LinkManager from './LinkManager.js';

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

  const layout = {
    centerX: canvas.offsetWidth / 2,
    centerY: Math.max(260, canvas.offsetHeight * 0.28),
    spacingX: 320,
    spacingY: 260,
    perRow: 4,
  };

  const elementNodes = [];

  const layoutNodes = () => {
    elementNodes.forEach((node, index) => {
      if (node.manualPosition) {
        return;
      }
      const row = Math.floor(index / layout.perRow);
      const rowStart = row * layout.perRow;
      const itemsInRow = Math.min(layout.perRow, elementNodes.length - rowStart);
      const indexInRow = index - rowStart;
      const offsetX = (indexInRow - (itemsInRow - 1) / 2) * layout.spacingX;
      const offsetY = row * layout.spacingY;
      node.setPosition(layout.centerX + offsetX, layout.centerY + offsetY);
    });
  };

  const linkManager = new LinkManager(canvas);
  ElementNode.attachLinkManager(linkManager);

  let activeModal = null;
  let viewport;

  const createElementNode = ({ name, type }) => {
    const normalizedType = ElementNode.normaliseType(type);
    const node = ElementNode.createNode(normalizedType, {
      canvas,
      title: name,
      x: layout.centerX,
      y: layout.centerY,
    });
    node.manualPosition = false;
    elementNodes.push(node);
    layoutNodes();
    NodeBase.setLastInteractedNode(node);
    if (elementNodes.length === 1 && viewport) {
      viewport.focusOn(
        { x: node.position.x, y: node.position.y },
        {
          scale: 0.88,
          offset: { x: 0, y: -Math.max(120, workspace.clientHeight * 0.16) },
        }
      );
    }
    return node;
  };

  const openCreationModal = () => {
    if (activeModal) {
      return;
    }
    activeModal = createElementModal({
      onSubmit: ({ name, type }) => {
        const node = createElementNode({ name, type });
        NodeBase.setLastInteractedNode(node);
      },
      onClose: () => {
        activeModal = null;
      },
    });
  };

  const addButton = document.getElementById('add-element');
  if (addButton) {
    addButton.addEventListener('click', openCreationModal);
  }

  viewport = enableZoomPan(workspace, canvas, {
    minScale: 0.5,
    maxScale: 2.6,
    centerOnLoad: false,
  });

  requestAnimationFrame(() => {
    viewport.focusOn(
      { x: layout.centerX, y: layout.centerY },
      {
        scale: 0.92,
        offset: { x: 0, y: -Math.max(100, workspace.clientHeight * 0.14) },
      }
    );
  });

  util.log('Elements builder initialised.');

  window.builder = {
    util,
    ElementNode,
    CharacterNode,
    PlaceNode,
    OtherNode,
    LinkManager,
    linkManager,
    viewport,
    elementNodes,
    createElementNode,
    layoutNodes,
  };
};

document.addEventListener('DOMContentLoaded', init);
