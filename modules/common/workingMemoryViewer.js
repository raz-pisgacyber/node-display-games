import { serialiseWorkingMemory, subscribeWorkingMemory } from './workingMemory.js';

const viewerState = {
  overlay: null,
  modal: null,
  content: null,
  unsubscribe: null,
  keyHandler: null,
};

function ensureViewer() {
  if (viewerState.overlay) {
    return viewerState;
  }

  const overlay = document.createElement('div');
  overlay.className = 'working-memory-overlay';

  const modal = document.createElement('div');
  modal.className = 'working-memory-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Working memory viewer');
  modal.tabIndex = -1;

  const header = document.createElement('header');
  header.className = 'working-memory-modal__header';

  const title = document.createElement('h2');
  title.textContent = 'Working Memory';
  header.appendChild(title);

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'working-memory-modal__close';
  closeButton.setAttribute('aria-label', 'Close working memory viewer');
  closeButton.textContent = '✕';
  header.appendChild(closeButton);

  const content = document.createElement('pre');
  content.className = 'working-memory-modal__content';
  content.textContent = serialiseWorkingMemory();

  modal.appendChild(header);
  modal.appendChild(content);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const update = () => {
    content.textContent = serialiseWorkingMemory();
  };

  viewerState.unsubscribe = subscribeWorkingMemory(update);

  const keyHandler = (event) => {
    if (event.key === 'Escape') {
      closeWorkingMemoryViewer();
    }
  };

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      closeWorkingMemoryViewer();
    }
  });

  closeButton.addEventListener('click', () => {
    closeWorkingMemoryViewer();
  });

  document.addEventListener('keydown', keyHandler);

  viewerState.overlay = overlay;
  viewerState.modal = modal;
  viewerState.content = content;
  viewerState.keyHandler = keyHandler;

  return viewerState;
}

export function openWorkingMemoryViewer() {
  const { overlay, modal } = ensureViewer();
  if (!overlay || !modal) {
    return;
  }
  overlay.classList.add('visible');
  modal.focus({ preventScroll: true });
  if (viewerState.content) {
    viewerState.content.textContent = serialiseWorkingMemory();
  }
}

export function closeWorkingMemoryViewer() {
  if (!viewerState.overlay) {
    return;
  }
  viewerState.overlay.classList.remove('visible');
}

export function destroyWorkingMemoryViewer() {
  if (viewerState.unsubscribe) {
    try {
      viewerState.unsubscribe();
    } catch (error) {
      console.warn('Failed to detach working memory subscription', error);
    }
    viewerState.unsubscribe = null;
  }
  if (viewerState.keyHandler) {
    document.removeEventListener('keydown', viewerState.keyHandler);
    viewerState.keyHandler = null;
  }
  if (viewerState.overlay) {
    viewerState.overlay.remove();
  }
  viewerState.overlay = null;
  viewerState.modal = null;
  viewerState.content = null;
}
