import NodeBase from '../../core/nodebase.js';
import util from '../../core/util.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const ensurePanelHost = () => {
  if (!NodeBase.panelHost) {
    const host = document.createElement('div');
    host.className = 'side-panel-host';
    document.body.appendChild(host);
    NodeBase.panelHost = host;
  }
  return NodeBase.panelHost;
};

class LinkManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.links = new Map();
    this.pendingSource = null;
    this.svg = this.ensureSvgLayer();

    this.onCanvasPointerDown = this.handleCanvasPointerDown.bind(this);
    this.canvas.addEventListener('pointerdown', this.onCanvasPointerDown);
  }

  ensureSvgLayer() {
    let layer = this.canvas.querySelector('svg.element-links');
    if (!layer) {
      layer = document.createElementNS(SVG_NS, 'svg');
      layer.classList.add('element-links');
      layer.setAttribute('width', this.canvas.offsetWidth);
      layer.setAttribute('height', this.canvas.offsetHeight);
      layer.setAttribute('viewBox', `0 0 ${this.canvas.offsetWidth} ${this.canvas.offsetHeight}`);
      this.canvas.insertBefore(layer, this.canvas.firstChild);
    }
    return layer;
  }

  beginLinking(node) {
    this.selectNode(node);
  }

  clearPending() {
    if (this.pendingSource) {
      this.pendingSource.element.classList.remove('node-linking');
    }
    this.pendingSource = null;
  }

  getLinkId(nodeA, nodeB) {
    const ids = [nodeA.id, nodeB.id].sort();
    return ids.join('__');
  }

  toggleLink(nodeA, nodeB) {
    if (nodeA === nodeB) {
      this.clearPending();
      return;
    }
    const id = this.getLinkId(nodeA, nodeB);
    if (this.links.has(id)) {
      this.removeLink(id);
      util.log('Removed link between nodes', nodeA.title, nodeB.title);
      return;
    }
    this.createLink(nodeA, nodeB, id);
  }

  selectNode(node) {
    if (!node) {
      return;
    }

    if (!this.pendingSource) {
      this.pendingSource = node;
      node.element.classList.add('node-linking');
      util.log('Select another node to link with', node.title);
      return;
    }

    if (this.pendingSource === node) {
      this.clearPending();
      return;
    }

    this.toggleLink(this.pendingSource, node);
    this.clearPending();
  }

  consumeNodePointerDown(node, event) {
    if (!this.pendingSource) {
      return false;
    }

    if (event?.target?.closest?.('.node-icon[data-action="link"]')) {
      return false;
    }

    this.selectNode(node);
    return true;
  }

  handleCanvasPointerDown(event) {
    if (!this.pendingSource) {
      return;
    }

    const targetNode = NodeBase.getNodeFromElement(event.target);
    if (targetNode) {
      return;
    }

    this.clearPending();
  }

  createLink(nodeA, nodeB, id) {
    const line = document.createElementNS(SVG_NS, 'line');
    line.classList.add('element-link');
    line.setAttribute('stroke-linecap', 'round');
    this.svg.appendChild(line);

    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'element-link__handle';
    handle.title = 'Open relationship notes';
    handle.textContent = '🔍';

    const link = {
      id,
      nodeA,
      nodeB,
      line,
      handle,
      notes: '',
      card: null,
    };

    handle.addEventListener('click', (event) => {
      event.stopPropagation();
      this.openLinkCard(link);
    });

    handle.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
    });

    this.canvas.appendChild(handle);

    this.links.set(id, link);
    nodeA.links.add(link);
    nodeB.links.add(link);

    this.updateLinkPosition(link);
  }

  removeLink(id) {
    const link = this.links.get(id);
    if (!link) return;
    link.nodeA.links.delete(link);
    link.nodeB.links.delete(link);
    link.line.remove();
    link.handle.remove();
    if (link.card) {
      link.card.remove();
      if (NodeBase.openCard === link.card) {
        NodeBase.hideOpenCard();
      }
    }
    this.links.delete(id);
  }

  updateLinksForNode(node) {
    node.links.forEach((link) => {
      this.updateLinkPosition(link);
    });
  }

  updateLinkTitlesForNode(node) {
    node.links.forEach((link) => {
      if (!link.card) return;
      const title = link.card.querySelector('h2');
      if (title) {
        title.textContent = this.getLinkTitle(link);
      }
    });
  }

  updateLinkPosition(link) {
    const { nodeA, nodeB, line, handle } = link;
    const ax = nodeA.position?.x ?? 0;
    const ay = nodeA.position?.y ?? 0;
    const bx = nodeB.position?.x ?? 0;
    const by = nodeB.position?.y ?? 0;
    line.setAttribute('x1', ax);
    line.setAttribute('y1', ay);
    line.setAttribute('x2', bx);
    line.setAttribute('y2', by);

    const midX = (ax + bx) / 2;
    const midY = (ay + by) / 2;
    handle.style.left = `${midX}px`;
    handle.style.top = `${midY}px`;

    const visible = nodeA.element.classList.contains('visible') && nodeB.element.classList.contains('visible');
    line.style.opacity = visible ? '1' : '0';
    handle.style.opacity = visible ? '1' : '0';
    handle.style.pointerEvents = visible ? 'auto' : 'none';
  }

  getLinkTitle(link) {
    return `${link.nodeA.title} ↔ ${link.nodeB.title} — Relationship`;
  }

  openLinkCard(link) {
    if (!link.card) {
      link.card = this.createLinkCard(link);
    }
    const card = link.card;
    const isVisible = card.classList.contains('visible');
    NodeBase.hideOpenCard();
    if (!isVisible) {
      card.classList.add('visible');
      card.classList.remove('hidden');
      NodeBase.openCard = card;
    }
  }

  createLinkCard(link) {
    const host = ensurePanelHost();
    const card = document.createElement('div');
    card.className = 'side-card hidden';
    card.dataset.type = 'relationship';
    card.dataset.linkId = link.id;

    const header = document.createElement('header');
    header.className = 'side-card__header';
    const title = document.createElement('h2');
    title.textContent = this.getLinkTitle(link);
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

    const content = document.createElement('div');
    content.className = 'side-card__content relationship-card';

    const summary = document.createElement('p');
    summary.className = 'relationship-card__summary';
    summary.textContent = 'Document the nature, history, and stakes of this relationship.';

    const notes = document.createElement('textarea');
    notes.placeholder = 'Shared history, power dynamics, secrets, leverage, obligations...';
    notes.value = link.notes;
    notes.addEventListener('input', (event) => {
      link.notes = event.target.value;
    });

    const unlinkButton = document.createElement('button');
    unlinkButton.type = 'button';
    unlinkButton.className = 'relationship-card__remove';
    unlinkButton.textContent = 'Unlink elements';
    unlinkButton.addEventListener('click', () => {
      this.removeLink(link.id);
      NodeBase.hideOpenCard();
    });

    content.appendChild(summary);
    content.appendChild(notes);
    content.appendChild(unlinkButton);

    card.appendChild(header);
    card.appendChild(content);
    host.appendChild(card);

    return card;
  }
}

export default LinkManager;
