const DEBUG_KEY = 'builder:debug';

const util = {
  log: (...args) => {
    const enabled = localStorage.getItem(DEBUG_KEY);
    if (enabled === null || enabled === 'true') {
      console.log('[Builder]', ...args);
    }
  },

  enableDebugLogging(enabled = true) {
    localStorage.setItem(DEBUG_KEY, enabled ? 'true' : 'false');
  },

  polarToCartesian(radius, angleRadians) {
    return {
      x: radius * Math.cos(angleRadians),
      y: radius * Math.sin(angleRadians),
    };
  },

  randomColor() {
    const palette = [
      '#6C5CE7',
      '#00B894',
      '#0984E3',
      '#E17055',
      '#FD7272',
      '#00CEC9',
      '#FDCB6E',
      '#D980FA',
    ];
    return palette[Math.floor(Math.random() * palette.length)];
  },

  fadeIn(element) {
    element.classList.add('visible');
    element.classList.remove('hidden');
  },

  fadeOut(element) {
    element.classList.remove('visible');
    element.classList.add('hidden');
  },

  storage: {
    set(key, value) {
      localStorage.setItem(key, JSON.stringify(value));
    },
    get(key, fallback = null) {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      try {
        return JSON.parse(raw);
      } catch (err) {
        console.warn('Failed to parse stored value for', key, err);
        return fallback;
      }
    },
    remove(key) {
      localStorage.removeItem(key);
    },
  },

  enableZoomPan(workspace, canvas) {
    if (!workspace || !canvas) {
      throw new Error('Workspace and canvas elements are required for zoom/pan.');
    }

    workspace.classList.add('workspace-ready');
    canvas.classList.add('canvas-ready');

    const state = {
      scale: 1,
      minScale: 0.4,
      maxScale: 2.5,
      translateX: 0,
      translateY: 0,
      panning: false,
      pointerId: null,
      start: { x: 0, y: 0 },
      translateStart: { x: 0, y: 0 },
    };

    const applyTransform = () => {
      canvas.style.transform = `translate(${state.translateX}px, ${state.translateY}px) scale(${state.scale})`;
      canvas.dataset.scale = String(state.scale);
      canvas.dataset.translateX = String(state.translateX);
      canvas.dataset.translateY = String(state.translateY);
    };

    const centerCanvas = () => {
      const workspaceRect = workspace.getBoundingClientRect();
      const canvasRect = canvas.getBoundingClientRect();
      state.translateX = (workspaceRect.width - canvasRect.width) / 2;
      state.translateY = (workspaceRect.height - canvasRect.height) / 2;
      applyTransform();
    };

    // Delay centering until the next frame so layout is calculated.
    requestAnimationFrame(centerCanvas);

    const onWheel = (event) => {
      event.preventDefault();
      const { deltaY } = event;
      const zoomFactor = deltaY < 0 ? 1.1 : 0.9;
      const newScale = Math.min(state.maxScale, Math.max(state.minScale, state.scale * zoomFactor));

      if (newScale === state.scale) return;

      const workspaceRect = workspace.getBoundingClientRect();
      const pointerX = event.clientX - workspaceRect.left;
      const pointerY = event.clientY - workspaceRect.top;

      const offsetX = (pointerX - state.translateX) / state.scale;
      const offsetY = (pointerY - state.translateY) / state.scale;

      state.scale = newScale;
      state.translateX = pointerX - offsetX * state.scale;
      state.translateY = pointerY - offsetY * state.scale;

      applyTransform();
    };

    const onPointerDown = (event) => {
      if (event.button !== 0) return;
      const nodeTarget = event.target.closest('.node');
      if (nodeTarget) return;

      state.panning = true;
      state.pointerId = event.pointerId;
      state.start.x = event.clientX;
      state.start.y = event.clientY;
      state.translateStart.x = state.translateX;
      state.translateStart.y = state.translateY;
      workspace.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event) => {
      if (!state.panning || event.pointerId !== state.pointerId) return;
      const dx = event.clientX - state.start.x;
      const dy = event.clientY - state.start.y;
      state.translateX = state.translateStart.x + dx;
      state.translateY = state.translateStart.y + dy;
      applyTransform();
    };

    const stopPan = (event) => {
      if (event.pointerId !== state.pointerId) return;
      state.panning = false;
      state.pointerId = null;
      if (workspace.hasPointerCapture?.(event.pointerId)) {
        workspace.releasePointerCapture(event.pointerId);
      }
    };

    workspace.addEventListener('wheel', onWheel, { passive: false });
    workspace.addEventListener('pointerdown', onPointerDown);
    workspace.addEventListener('pointermove', onPointerMove);
    workspace.addEventListener('pointerup', stopPan);
    workspace.addEventListener('pointercancel', stopPan);

    util.log('Zoom/Pan enabled');

    return {
      get scale() {
        return state.scale;
      },
      get translate() {
        return { x: state.translateX, y: state.translateY };
      },
      reset() {
        state.scale = 1;
        state.translateX = 0;
        state.translateY = 0;
        applyTransform();
      },
    };
  },
};

export default util;
export const { log, fadeIn, fadeOut, polarToCartesian, randomColor, storage, enableZoomPan } = util;
