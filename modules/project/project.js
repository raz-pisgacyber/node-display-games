import ProjectNode from './ProjectNode.js';
import util, { enableZoomPan, ensureCanvas, log } from '../../core/util.js';

const init = () => {
  const workspace = document.getElementById('workspace');
  if (!workspace) {
    log('Workspace element missing.');
    return;
  }

  const canvas = ensureCanvas(workspace, { width: 2400, height: 2400 });

  const { clientWidth, clientHeight } = workspace;
  const centerX = clientWidth / 2;
  const centerY = Math.max(180, clientHeight * 0.25);

  const rootNode = new ProjectNode({ canvas, x: centerX, y: centerY });

  const viewport = enableZoomPan(workspace, canvas, {
    minScale: 0.5,
    maxScale: 2.4,
  });

  log('Project builder initialised.');

  window.builder = {
    util,
    rootNode,
    viewport,
  };
};

document.addEventListener('DOMContentLoaded', init);
