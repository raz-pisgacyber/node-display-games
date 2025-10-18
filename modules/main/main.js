import NodeBase from '../../core/nodebase.js';
import util, { enableZoomPan, ensureCanvas } from '../../core/util.js';

class LinkNode extends NodeBase {
  constructor(options) {
    const { url, radius = 90, childOrbit = 260 } = options;
    super({ ...options, radius, childOrbit });
    this.url = url;
    this.element.classList.add('link-node');
    this.element.setAttribute('role', 'link');
    this.element.setAttribute('tabindex', '0');
    this.element.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this.navigate();
      }
    });
  }

  navigate() {
    if (!this.url) return;
    window.location.href = this.url;
  }

  toggleChildren() {
    this.navigate();
  }

  handleIconAction() {
    // Link nodes do not expose icon actions.
  }
}

const init = () => {
  const workspace = document.getElementById('workspace');
  if (!workspace) {
    util.log('Workspace element missing on main page.');
    return;
  }

  const canvas = ensureCanvas(workspace, { width: 2200, height: 1600 });

  const canvasCenterX = canvas.offsetWidth / 2;
  const canvasCenterY = canvas.offsetHeight / 2;

  const viewport = enableZoomPan(workspace, canvas, {
    minScale: 0.6,
    maxScale: 2.2,
    centerOnLoad: false,
  });

  new LinkNode({
    canvas,
    x: canvasCenterX - 220,
    y: canvasCenterY,
    title: 'Project Builder',
    color: '#6C5CE7',
    url: '../project/project.html',
  });

  new LinkNode({
    canvas,
    x: canvasCenterX + 220,
    y: canvasCenterY,
    title: 'Elements Builder',
    color: '#00CEC9',
    url: '../elements/elements.html',
  });

  requestAnimationFrame(() => {
    viewport.focusOn({ x: canvasCenterX, y: canvasCenterY }, { scale: 0.9 });
  });

  util.log('Main hub initialised.');
};

document.addEventListener('DOMContentLoaded', init);
