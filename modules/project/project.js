import ProjectNode from './ProjectNode.js';
import util, { enableZoomPan, ensureCanvas, log } from '../../core/util.js';

const init = () => {
  const workspace = document.getElementById('workspace');
  if (!workspace) {
    log('Workspace element missing.');
    return;
  }

  const canvas = ensureCanvas(workspace, { width: 2400, height: 2400 });

  const canvasCenterX = canvas.offsetWidth / 2;
  const canvasCenterY = Math.max(220, canvas.offsetHeight * 0.24);

  const rootNode = new ProjectNode({ canvas, x: canvasCenterX, y: canvasCenterY });

  const viewport = enableZoomPan(workspace, canvas, {
    minScale: 0.5,
    maxScale: 2.4,
    centerOnLoad: false,
  });

  requestAnimationFrame(() => {
    viewport.focusOn(
      { x: rootNode.position.x, y: rootNode.position.y },
      {
        scale: 0.82,
        offset: { x: 0, y: -Math.max(140, workspace.clientHeight * 0.18) },
      }
    );
  });

  log('Project builder initialised.');

  window.builder = {
    util,
    rootNode,
    viewport,
  };
};

document.addEventListener('DOMContentLoaded', init);
