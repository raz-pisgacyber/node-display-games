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

  enableZoomPan(workspace, canvas, config = {}) {
    if (!workspace || !canvas) {
      throw new Error('Workspace and canvas elements are required for zoom/pan.');
    }

    workspace.classList.add('workspace-ready');
    canvas.classList.add('canvas-ready');

    const settings = {
      minScale: config.minScale ?? 0.4,
      maxScale: config.maxScale ?? 2.5,
      initialScale: config.initialScale ?? 1,
      centerOnLoad: config.centerOnLoad !== false,
      initialTranslate: config.initialTranslate ?? null,
      onTransform: typeof config.onTransform === 'function' ? config.onTransform : null,
    };

    const state = {
      scale: settings.initialScale,
      minScale: settings.minScale,
      maxScale: settings.maxScale,
      translateX: settings.initialTranslate?.x ?? 0,
      translateY: settings.initialTranslate?.y ?? 0,
      panning: false,
      pointerId: null,
      start: { x: 0, y: 0 },
      translateStart: { x: 0, y: 0 },
      transitionTimer: null,
    };

    const notifyTransform = () => {
      const detail = {
        scale: state.scale,
        translateX: state.translateX,
        translateY: state.translateY,
      };
      settings.onTransform?.(detail);
      workspace.dispatchEvent(
        new CustomEvent('workspace:transform', {
          detail,
          bubbles: true,
        })
      );
    };

    const applyTransform = (notify = true) => {
      canvas.style.transform = `translate(${state.translateX}px, ${state.translateY}px) scale(${state.scale})`;
      canvas.dataset.scale = String(state.scale);
      canvas.dataset.translateX = String(state.translateX);
      canvas.dataset.translateY = String(state.translateY);
      if (notify) {
        notifyTransform();
      }
    };

    const withCanvasTransition = (animate, callback) => {
      if (!animate) {
        callback();
        return;
      }

      if (state.transitionTimer) {
        window.clearTimeout(state.transitionTimer);
        state.transitionTimer = null;
      }

      let finished = false;
      const finish = () => {
        if (finished) {
          return;
        }
        finished = true;
        canvas.classList.remove('canvas-transition');
        canvas.removeEventListener('transitionend', finish);
        if (state.transitionTimer) {
          window.clearTimeout(state.transitionTimer);
          state.transitionTimer = null;
        }
      };

      canvas.classList.add('canvas-transition');
      canvas.addEventListener('transitionend', finish, { once: true });
      state.transitionTimer = window.setTimeout(finish, 380);
      callback();
    };

    const centerCanvas = () => {
      const workspaceRect = workspace.getBoundingClientRect();
      const canvasWidth = canvas.offsetWidth * state.scale;
      const canvasHeight = canvas.offsetHeight * state.scale;
      state.translateX = (workspaceRect.width - canvasWidth) / 2;
      state.translateY = (workspaceRect.height - canvasHeight) / 2;
      withCanvasTransition(true, () => applyTransform());
    };

    applyTransform(false);

    if (settings.centerOnLoad) {
      requestAnimationFrame(centerCanvas);
    } else if (settings.initialTranslate) {
      applyTransform();
    }

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
      workspace.setPointerCapture?.(event.pointerId);
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
      applyTransform();
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
      setTransform({ scale, translateX, translateY, animate = true } = {}) {
        if (typeof scale === 'number') {
          state.scale = Math.min(state.maxScale, Math.max(state.minScale, scale));
        }
      if (typeof translateX === 'number') {
        state.translateX = translateX;
      }
      if (typeof translateY === 'number') {
        state.translateY = translateY;
      }
      if (!animate) {
        canvas.classList.add('no-transition');
        applyTransform();
        requestAnimationFrame(() => {
          canvas.classList.remove('no-transition');
        });
        return;
      }
      withCanvasTransition(true, () => applyTransform());
    },
      reset({ animate = true } = {}) {
        state.scale = settings.initialScale;
        state.translateX = settings.initialTranslate?.x ?? 0;
        state.translateY = settings.initialTranslate?.y ?? 0;
        if (settings.centerOnLoad && !settings.initialTranslate) {
          centerCanvas();
          return;
        }
        if (!animate) {
          canvas.classList.add('no-transition');
          applyTransform();
          requestAnimationFrame(() => {
            canvas.classList.remove('no-transition');
          });
          return;
        }
        withCanvasTransition(true, () => applyTransform());
      },
      focusOn(point, options = {}) {
        if (!point || typeof point.x !== 'number' || typeof point.y !== 'number') {
          return;
        }
        const { x, y } = point;
        const {
          scale = state.scale,
          animate = true,
          offset = { x: 0, y: 0 },
        } = options;

        state.scale = Math.min(state.maxScale, Math.max(state.minScale, scale));

        const workspaceRect = workspace.getBoundingClientRect();
        const offsetX = offset?.x ?? 0;
        const offsetY = offset?.y ?? 0;

        state.translateX = workspaceRect.width / 2 + offsetX - x * state.scale;
        state.translateY = workspaceRect.height / 2 + offsetY - y * state.scale;

        if (!animate) {
          canvas.classList.add('no-transition');
          applyTransform();
          requestAnimationFrame(() => {
            canvas.classList.remove('no-transition');
          });
          return;
        }

        withCanvasTransition(true, () => applyTransform());
      },
      destroy() {
        workspace.removeEventListener('wheel', onWheel);
        workspace.removeEventListener('pointerdown', onPointerDown);
        workspace.removeEventListener('pointermove', onPointerMove);
        workspace.removeEventListener('pointerup', stopPan);
        workspace.removeEventListener('pointercancel', stopPan);
        if (state.transitionTimer) {
          window.clearTimeout(state.transitionTimer);
          state.transitionTimer = null;
        }
      },
    };
  },

  ensureCanvas(workspace, options = {}) {
    if (!workspace) {
      throw new Error('Workspace element is required to ensure a canvas.');
    }
    const { id = 'canvas', width = 2400, height = 2400, classes = [] } = options;
    let canvas = workspace.querySelector(`#${id}`);
    if (!canvas) {
      canvas = document.createElement('div');
      canvas.id = id;
      workspace.appendChild(canvas);
    }
    if (width) {
      canvas.style.width = `${width}px`;
    }
    if (height) {
      canvas.style.height = `${height}px`;
    }
    if (Array.isArray(classes)) {
      classes.filter(Boolean).forEach((cls) => canvas.classList.add(cls));
    }
    return canvas;
  },
};

export default util;
export const { log, fadeIn, fadeOut, polarToCartesian, randomColor, storage, enableZoomPan, ensureCanvas } = util;
