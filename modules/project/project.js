import ProjectNode from './ProjectNode.js';
import util, { enableZoomPan, log } from '../../core/util.js';

const init = () => {
  const workspace = document.getElementById('workspace');
  if (!workspace) {
    log('Workspace element missing.');
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

  const rootNode = new ProjectNode({ canvas, x: centerX, y: centerY });
  rootNode.expandChildren();

  enableZoomPan(workspace, canvas);

  log('Project builder initialised.');

  window.builder = {
    util,
    rootNode,
  };
};

document.addEventListener('DOMContentLoaded', init);
