import util, { enableZoomPan } from '../../core/util.js';
import { ElementNode, CharacterNode, SettingNode, OtherNode } from './ElementNode.js';

class ElementsRootNode extends ElementNode {
  constructor(options = {}) {
    super({
      title: 'Story Elements',
      color: '#a29bfe',
      radius: 88,
      childOrbit: 320,
      type: options.type ?? 'other',
      ...options,
    });
  }

  ensureStarterNodes() {
    if (this.children.length) {
      return;
    }

    const starterConfigs = [
      { type: 'character', title: 'Characters' },
      { type: 'setting', title: 'Settings' },
      { type: 'other', title: 'Story Threads' },
    ];

    starterConfigs.forEach((config) => {
      const child = this.createTypedChild(config.type, {
        title: config.title,
      });
      child.hide();
    });

    this.expandChildren();
  }
}

const init = () => {
  const workspace = document.getElementById('workspace');
  if (!workspace) {
    util.log('Workspace element missing for elements builder.');
    return;
  }

  let canvas = workspace.querySelector('#canvas');
  if (!canvas) {
    canvas = document.createElement('div');
    canvas.id = 'canvas';
    workspace.appendChild(canvas);
  }

  const { clientWidth, clientHeight } = workspace;
  const centerX = clientWidth / 2;
  const centerY = clientHeight / 2;

  const rootNode = new ElementsRootNode({ canvas, x: centerX, y: centerY });
  rootNode.ensureStarterNodes();

  enableZoomPan(workspace, canvas);

  util.log('Elements builder initialised.');

  window.builder = {
    util,
    rootNode,
    ElementNode,
    CharacterNode,
    SettingNode,
    OtherNode,
  };
};

document.addEventListener('DOMContentLoaded', init);
