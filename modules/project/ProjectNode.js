import NodeBase from '../../core/nodebase.js';
import { randomColor } from '../../core/util.js';

const ensurePanelHost = () => {
  if (!NodeBase.panelHost) {
    const host = document.createElement('div');
    host.className = 'side-panel-host';
    document.body.appendChild(host);
    NodeBase.panelHost = host;
  }
  return NodeBase.panelHost;
};

class ProjectNode extends NodeBase {
  constructor(options = {}) {
    const defaults = {
      title: options?.title ?? 'Project',
      radius: 80,
      childOrbit: 280,
      color: randomColor(),
    };
    super({ ...defaults, ...options });

    const baseSpacing = options?.pyramidSpacing ?? {};
    const horizontal = baseSpacing.x ?? this.childOrbit * 0.9;
    const vertical = baseSpacing.y ?? this.childOrbit * 0.6;
    this.pyramidSpacing = {
      x: Math.max(120, horizontal),
      y: Math.max(100, vertical),
    };
    if (!this.meta || typeof this.meta !== 'object') {
      this.meta = {};
    }
    this.meta.builder = 'project';
    this.meta.childOrbit = this.childOrbit;
    this.meta.pyramidSpacing = { ...this.pyramidSpacing };

    this.projectData = this.ensureProjectData(this.meta?.projectData);
    this.projectData.title = this.title;
    this.projectData.notes = this.notes || this.projectData.notes || '';
    this.syncProjectDataToMeta();
  }

  addChild(nodeOrConfig = {}) {
    const child =
      nodeOrConfig instanceof ProjectNode
        ? nodeOrConfig
        : new ProjectNode({
            canvas: this.canvas,
            parent: this,
            childOrbit: Math.max(160, (this.childOrbit ?? 220) * 0.78),
            pyramidSpacing: {
              x: Math.max(140, (this.pyramidSpacing?.x ?? this.childOrbit) * 0.84),
              y: Math.max(110, (this.pyramidSpacing?.y ?? this.childOrbit * 0.6) * 0.92),
            },
            ...nodeOrConfig,
          });
    return super.addChild(child);
  }

  createChild(config = {}) {
    return this.addChild(config);
  }

  ensureCard(type) {
    if (type !== 'data') {
      return super.ensureCard(type);
    }

    if (this.cards[type]) {
      const existing = this.cards[type];
      if (!existing.classList.contains('visible')) {
        const existingContent = existing.querySelector('.side-card__content.element-data-card');
        if (existingContent) {
          this.buildDataContent(existingContent);
        }
      }
      return existing;
    }

    const host = ensurePanelHost();
    const card = document.createElement('div');
    card.className = 'side-card hidden';
    card.dataset.nodeId = this.id;
    card.dataset.type = type;

    const header = document.createElement('header');
    header.className = 'side-card__header';
    const title = document.createElement('h2');
    title.textContent = this.getCardTitle('data');
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
    card.appendChild(header);

    const content = document.createElement('div');
    content.className = 'side-card__content element-data-card';
    this.buildDataContent(content);
    card.appendChild(content);

    host.appendChild(card);
    this.cards[type] = card;
    return card;
  }

  buildDataContent(container) {
    container.innerHTML = '';

    const titleLabel = document.createElement('label');
    titleLabel.textContent = 'Title';
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.value = this.title;
    titleInput.addEventListener('input', (event) => {
      this.setTitle(event.target.value);
    });

    container.appendChild(titleLabel);
    container.appendChild(titleInput);

    const notesLabel = document.createElement('label');
    notesLabel.textContent = 'Notes';
    const notesArea = document.createElement('textarea');
    notesArea.placeholder = 'Capture notes, ideas, or details...';
    notesArea.value = this.projectData.notes;
    notesArea.addEventListener('input', (event) => {
      this.notes = event.target.value;
      this.projectData.notes = this.notes;
      this.recordProjectDataChange('notes');
    });

    container.appendChild(notesLabel);
    container.appendChild(notesArea);

    this.addCustomFieldsSection(container);
  }

  addCustomFieldsSection(container) {
    const section = document.createElement('section');
    section.className = 'element-data-card__custom';

    const heading = document.createElement('h3');
    heading.textContent = 'Custom Fields';
    section.appendChild(heading);

    const description = document.createElement('p');
    description.textContent = 'Add bespoke key:value details for this project.';
    section.appendChild(description);

    const fieldsWrapper = document.createElement('div');
    fieldsWrapper.className = 'element-data-card__custom-grid';
    section.appendChild(fieldsWrapper);

    const addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.className = 'element-data-card__add-field';
    addButton.textContent = 'Add field';
    addButton.addEventListener('click', () => {
      this.projectData.customFields.push({ key: '', value: '' });
      this.renderCustomFields(fieldsWrapper);
      this.recordProjectDataChange('project-data');
    });
    section.appendChild(addButton);

    container.appendChild(section);
    this.renderCustomFields(fieldsWrapper);
  }

  renderCustomFields(wrapper) {
    wrapper.innerHTML = '';

    this.projectData.customFields.forEach((field, index) => {
      const row = document.createElement('div');
      row.className = 'element-data-card__custom-row';

      const keyInput = document.createElement('input');
      keyInput.type = 'text';
      keyInput.placeholder = 'Key';
      keyInput.value = field.key;
      keyInput.addEventListener('input', (event) => {
        field.key = event.target.value;
        this.recordProjectDataChange('project-data');
      });

      const valueInput = document.createElement('textarea');
      valueInput.rows = 2;
      valueInput.placeholder = 'Value';
      valueInput.value = field.value;
      valueInput.addEventListener('input', (event) => {
        field.value = event.target.value;
        this.recordProjectDataChange('project-data');
      });

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'element-data-card__remove-field';
      remove.textContent = '✕';
      remove.title = 'Remove field';
      remove.addEventListener('click', () => {
        this.projectData.customFields.splice(index, 1);
        this.renderCustomFields(wrapper);
        this.recordProjectDataChange('project-data');
      });

      row.appendChild(keyInput);
      row.appendChild(valueInput);
      row.appendChild(remove);
      wrapper.appendChild(row);
    });

    if (!this.projectData.customFields.length) {
      const empty = document.createElement('p');
      empty.className = 'element-data-card__custom-empty';
      empty.textContent = 'No custom data yet. Add key:value details specific to this project.';
      wrapper.appendChild(empty);
    }
  }

  recordProjectDataChange(reason = 'project-data') {
    this.syncProjectDataToMeta();
    this.notifyMutation(reason, { data: this.meta.projectData });
  }

  syncProjectDataToMeta() {
    if (!this.meta || typeof this.meta !== 'object') {
      this.meta = {};
    }
    this.meta.builder = 'project';
    this.meta.childOrbit = this.childOrbit;
    this.meta.pyramidSpacing = { ...this.pyramidSpacing };
    this.meta.projectData = ProjectNode.cloneProjectData(this.projectData) || {
      title: this.title,
      notes: this.notes,
      customFields: [],
    };
    this.meta.notes = this.notes || '';
    this.meta.discussion = this.discussion || '';
    this.meta.fullText = this.fullText || '';
  }

  createDefaultProjectData() {
    return {
      title: this.title,
      notes: this.notes || '',
      customFields: [],
    };
  }

  ensureProjectData(existing) {
    const defaults = this.createDefaultProjectData();
    if (!existing || typeof existing !== 'object') {
      return defaults;
    }
    const data = {
      ...defaults,
      ...existing,
    };
    data.title = typeof data.title === 'string' ? data.title : defaults.title;
    data.notes = typeof data.notes === 'string' ? data.notes : defaults.notes;
    data.customFields = Array.isArray(existing.customFields)
      ? existing.customFields.map((field) => ({
          key: typeof field?.key === 'string' ? field.key : '',
          value: typeof field?.value === 'string' ? field.value : '',
        }))
      : defaults.customFields.slice();
    return data;
  }

  layoutChildren() {
    if (!this.expanded || !this.children.length) {
      return;
    }

    const spacingX = this.pyramidSpacing?.x ?? this.childOrbit;
    const spacingY = this.pyramidSpacing?.y ?? this.childOrbit * 0.6;

    let remaining = this.children.length;
    let rowSize = 1;
    let index = 0;

    while (remaining > 0) {
      const countInRow = Math.min(rowSize, remaining);
      const rowWidth = (countInRow - 1) * spacingX;
      for (let i = 0; i < countInRow; i += 1) {
        const child = this.children[index++];
        if (!child) {
          continue;
        }
        child.show();
        if (child.manualPosition) {
          continue;
        }
        const offsetX = -rowWidth / 2 + i * spacingX;
        const offsetY = spacingY * rowSize;
        child.setPosition(this.position.x + offsetX, this.position.y + offsetY);
      }
      remaining -= countInRow;
      rowSize += 1;
    }
  }

  toPersistence() {
    const base = super.toPersistence();
    base.meta = {
      ...base.meta,
      builder: 'project',
      childOrbit: this.childOrbit,
      pyramidSpacing: { ...this.pyramidSpacing },
      projectData: ProjectNode.cloneProjectData(this.projectData),
    };
    return base;
  }

  onAddChild() {
    const label = window.prompt('Name the new story beat or chapter');
    if (!label) return null;
    const child = this.createChild({ title: label, color: randomColor() });
    if (!this.expanded) {
      this.expandChildren();
    } else {
      this.layoutChildren();
    }
    return child;
  }

  setTitle(newTitle) {
    super.setTitle(newTitle);
    if (!this.projectData) {
      this.projectData = this.createDefaultProjectData();
    }
    this.projectData.title = this.title;
    this.syncProjectDataToMeta();
  }

  getCardTitle(type) {
    if (type === 'data') {
      return `${this.title} — Project Data`;
    }
    return super.getCardTitle(type);
  }

  static cloneProjectData(data) {
    if (!data) {
      return null;
    }
    if (typeof structuredClone === 'function') {
      try {
        return structuredClone(data);
      } catch (error) {
        // fall through
      }
    }
    try {
      return JSON.parse(JSON.stringify(data));
    } catch (error) {
      return { ...data };
    }
  }
}

export default ProjectNode;
