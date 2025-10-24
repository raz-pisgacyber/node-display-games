import NodeBase from '../../core/nodebase.js';
import util from '../../core/util.js';

const ensurePanelHost = () => {
  if (!NodeBase.panelHost) {
    const host = document.createElement('div');
    host.className = 'side-panel-host';
    document.body.appendChild(host);
    NodeBase.panelHost = host;
  }
  return NodeBase.panelHost;
};

const TYPE_CONFIG = {
  character: {
    label: 'Character',
    color: '#fd79a8',
  },
  place: {
    label: 'Place',
    color: '#55efc4',
  },
  other: {
    label: 'Story Detail',
    color: '#ffeaa7',
  },
};

class ElementNode extends NodeBase {
  constructor(options = {}) {
    const type = ElementNode.normaliseType(options.type);
    const config = TYPE_CONFIG[type] || TYPE_CONFIG.other;
    const defaults = {
      title: config.label,
      color: config.color,
      radius: 72,
      childOrbit: 240,
    };
    super({ ...defaults, ...options, type: undefined });
    this.type = type;
    this.element.classList.add('element-node', `element-${this.type}`);
    this.element.dataset.elementType = this.type;
    this.links = new Set();
    const initialData = ElementNode.cloneData(options.data);
    this.data = this.ensureDataShape(initialData);
    if (!this.meta || typeof this.meta !== 'object') {
      this.meta = {};
    }
    this.meta.builder = 'elements';
    this.meta.elementType = this.type;
    this.meta.elementData = ElementNode.cloneData(this.data);
  }

  getIconDefinitions() {
    return [
      { label: '📄', action: 'data', title: 'Open data panel' },
      { label: '💬', action: 'discussion', title: 'Open discussion panel' },
      { label: '🔗', action: 'link', title: 'Link this element to another' },
    ];
  }

  getGrowthCount() {
    return this.links?.size ?? 0;
  }

  getBadgeValue() {
    return this.links?.size ?? 0;
  }

  getCardTitle(type) {
    if (type === 'data') {
      return `${this.title} — ${TYPE_CONFIG[this.type].label} Data`;
    }
    return super.getCardTitle(type);
  }

  recordDataChange(reason = 'data') {
    if (!this.meta || typeof this.meta !== 'object') {
      this.meta = {};
    }
    this.meta.builder = 'elements';
    this.meta.elementType = this.type;
    this.meta.elementData = ElementNode.cloneData(this.data);
    this.meta.notes = this.notes || '';
    this.meta.discussion = this.discussion || '';
    this.meta.fullText = this.fullText || '';
    this.notifyMutation(reason, { data: this.meta.elementData });
  }

  toPersistence() {
    const base = super.toPersistence();
    base.meta = {
      ...base.meta,
      builder: 'elements',
      elementType: this.type,
      elementData: ElementNode.cloneData(this.data),
    };
    return base;
  }

  static normaliseType(type) {
    if (!type) return 'other';
    const normalised = String(type).trim().toLowerCase();
    if (normalised === 'setting') {
      return 'place';
    }
    if (TYPE_CONFIG[normalised]) {
      return normalised;
    }
    return 'other';
  }

  static getNodeClass(type) {
    const normalised = ElementNode.normaliseType(type);
    return ElementNode.typeRegistry?.[normalised] ?? null;
  }

  static createNode(type, options = {}) {
    const NodeClass = ElementNode.getNodeClass(type);
    if (!NodeClass) {
      throw new Error(`Unsupported element node type: ${type}`);
    }
    return new NodeClass(options);
  }

  static cloneData(data) {
    if (!data) return null;
    if (typeof structuredClone === 'function') {
      try {
        return structuredClone(data);
      } catch (error) {
        util.log('Failed to structuredClone element data, falling back to JSON clone.', error);
      }
    }
    try {
      return JSON.parse(JSON.stringify(data));
    } catch (error) {
      util.log('Failed to clone element data; using shallow copy.', error);
      return { ...data };
    }
  }

  static attachLinkManager(manager) {
    ElementNode.linkManager = manager;
    NodeBase.setActiveLinkManager(manager);
  }

  createDefaultData() {
    switch (this.type) {
      case 'character':
        return {
          title: this.title,
          profile: '',
          personalityType: '',
          bigFive: {
            openness: '',
            conscientiousness: '',
            extraversion: '',
            agreeableness: '',
            neuroticism: '',
          },
          internalConflict: '',
          relationshipsPatterns: '',
          innerMonologueExamples: '',
          customFields: [],
        };
      case 'place':
        return {
          title: this.title,
          overview: '',
          atmosphere: '',
          keyFeatures: '',
          history: '',
          sensoryDetails: '',
          customFields: [],
        };
      default:
        return {
          title: this.title,
          notes: '',
          customFields: [],
        };
    }
  }

  ensureDataShape(existingData) {
    const defaults = this.createDefaultData();
    if (!existingData) {
      return defaults;
    }

    const merged = { ...defaults, ...existingData };

    if (this.type === 'character') {
      merged.bigFive = {
        ...defaults.bigFive,
        ...(existingData.bigFive || {}),
      };
    }

    merged.customFields = Array.isArray(existingData.customFields)
      ? existingData.customFields.map((field) => ({
          key: field?.key ?? '',
          value: field?.value ?? '',
        }))
      : defaults.customFields;

    return merged;
  }

  handleIconAction(action) {
    if (action === 'link') {
      if (!ElementNode.linkManager) {
        util.log('No link manager available for elements.');
        return;
      }
      ElementNode.linkManager.beginLinking(this);
      return;
    }
    super.handleIconAction(action);
  }

  ensureCard(type) {
    if (type !== 'data') {
      return super.ensureCard(type);
    }

    if (this.cards[type]) {
      return this.cards[type];
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
    this.buildDataContent(content, title);
    card.appendChild(content);

    host.appendChild(card);
    this.cards[type] = card;
    return card;
  }

  buildDataContent(container, headerTitleEl) {
    container.innerHTML = '';

    const titleLabel = document.createElement('label');
    titleLabel.textContent = 'Title';
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.value = this.title;
    titleInput.addEventListener('input', (event) => {
      this.setTitle(event.target.value);
      this.data.title = this.title;
      headerTitleEl.textContent = `${this.title} — ${TYPE_CONFIG[this.type].label} Data`;
      this.recordDataChange('title');
    });

    container.appendChild(titleLabel);
    container.appendChild(titleInput);

    const typeLabel = document.createElement('p');
    typeLabel.className = 'element-data-card__type';
    typeLabel.textContent = `Element type: ${TYPE_CONFIG[this.type].label}`;
    container.appendChild(typeLabel);

    if (this.type === 'character') {
      this.addCharacterFields(container);
    } else if (this.type === 'place') {
      this.addPlaceFields(container);
    } else {
      this.addOtherFields(container);
    }

    this.addCustomFieldsSection(container);
  }

  addField(container, { label, type = 'textarea', value = '', onInput, placeholder = '' }) {
    const fieldLabel = document.createElement('label');
    fieldLabel.textContent = label;
    let inputEl;
    if (type === 'textarea') {
      inputEl = document.createElement('textarea');
      inputEl.rows = 3;
    } else {
      inputEl = document.createElement('input');
      inputEl.type = type;
    }
    inputEl.value = value || '';
    inputEl.placeholder = placeholder;
    inputEl.addEventListener('input', (event) => {
      onInput?.(event.target.value);
      this.recordDataChange('data');
    });
    container.appendChild(fieldLabel);
    container.appendChild(inputEl);
    return inputEl;
  }

  addCharacterFields(container) {
    this.addField(container, {
      label: 'Basic Profile',
      value: this.data.profile,
      onInput: (value) => {
        this.data.profile = value;
      },
      placeholder: 'Role in the story, background, defining traits...'
    });

    this.addField(container, {
      label: 'Personality Type',
      type: 'text',
      value: this.data.personalityType,
      onInput: (value) => {
        this.data.personalityType = value;
      },
      placeholder: 'e.g. ENFP, Chaotic Good, Archetypes...'
    });

    const bigFiveWrapper = document.createElement('section');
    bigFiveWrapper.className = 'element-data-card__bigfive';
    const bigFiveTitle = document.createElement('h3');
    bigFiveTitle.textContent = 'Big Five Traits';
    bigFiveWrapper.appendChild(bigFiveTitle);
    const traits = [
      ['Openness', 'openness'],
      ['Conscientiousness', 'conscientiousness'],
      ['Extraversion', 'extraversion'],
      ['Agreeableness', 'agreeableness'],
      ['Neuroticism', 'neuroticism'],
    ];
    traits.forEach(([label, key]) => {
      this.addField(bigFiveWrapper, {
        label,
        type: 'text',
        value: this.data.bigFive?.[key] ?? '',
        onInput: (value) => {
          this.data.bigFive[key] = value;
        },
        placeholder: 'Scale, notes, or keywords'
      });
    });
    container.appendChild(bigFiveWrapper);

    this.addField(container, {
      label: 'Main Internal Conflict',
      value: this.data.internalConflict,
      onInput: (value) => {
        this.data.internalConflict = value;
      },
      placeholder: 'What keeps them up at night?'
    });

    this.addField(container, {
      label: 'Relationships & Behavioural Patterns',
      value: this.data.relationshipsPatterns,
      onInput: (value) => {
        this.data.relationshipsPatterns = value;
      },
      placeholder: 'Recurring dynamics with others, habits, tells...'
    });

    this.addField(container, {
      label: 'Examples of Inner Monologue',
      value: this.data.innerMonologueExamples,
      onInput: (value) => {
        this.data.innerMonologueExamples = value;
      },
      placeholder: 'Snippets of self-talk or recurring thoughts'
    });
  }

  addPlaceFields(container) {
    this.addField(container, {
      label: 'Overview',
      value: this.data.overview,
      onInput: (value) => {
        this.data.overview = value;
      },
      placeholder: 'What is this place? Who inhabits it?'
    });

    this.addField(container, {
      label: 'Atmosphere & Mood',
      value: this.data.atmosphere,
      onInput: (value) => {
        this.data.atmosphere = value;
      },
      placeholder: 'Ambient sounds, light, emotional tone...'
    });

    this.addField(container, {
      label: 'Key Features & Landmarks',
      value: this.data.keyFeatures,
      onInput: (value) => {
        this.data.keyFeatures = value;
      },
      placeholder: 'Notable spots, geography, props...'
    });

    this.addField(container, {
      label: 'History & Lore',
      value: this.data.history,
      onInput: (value) => {
        this.data.history = value;
      },
      placeholder: 'Origins, important events, secrets...'
    });

    this.addField(container, {
      label: 'Sensory Details',
      value: this.data.sensoryDetails,
      onInput: (value) => {
        this.data.sensoryDetails = value;
      },
      placeholder: 'Sights, sounds, smells, textures...'
    });
  }

  addOtherFields(container) {
    this.addField(container, {
      label: 'Notes',
      value: this.data.notes,
      onInput: (value) => {
        this.data.notes = value;
      },
      placeholder: 'Free-form details, prompts, or reminders'
    });
  }

  addCustomFieldsSection(container) {
    const section = document.createElement('section');
    section.className = 'element-data-card__custom';
    const heading = document.createElement('h3');
    heading.textContent = 'Custom Fields';
    section.appendChild(heading);

    const description = document.createElement('p');
    description.textContent = 'Add bespoke key:value details for this element.';
    section.appendChild(description);

    const fieldsWrapper = document.createElement('div');
    fieldsWrapper.className = 'element-data-card__custom-grid';
    section.appendChild(fieldsWrapper);

    const addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.className = 'element-data-card__add-field';
    addButton.textContent = 'Add field';
    addButton.addEventListener('click', () => {
      this.data.customFields.push({ key: '', value: '' });
      this.renderCustomFields(fieldsWrapper);
      this.recordDataChange('data');
    });
    section.appendChild(addButton);

    container.appendChild(section);
    this.renderCustomFields(fieldsWrapper);
  }

  renderCustomFields(wrapper) {
    wrapper.innerHTML = '';
    this.data.customFields.forEach((field, index) => {
      const row = document.createElement('div');
      row.className = 'element-data-card__custom-row';

      const keyInput = document.createElement('input');
      keyInput.type = 'text';
      keyInput.placeholder = 'Key';
      keyInput.value = field.key;
      keyInput.addEventListener('input', (event) => {
        field.key = event.target.value;
        this.recordDataChange('data');
      });

      const valueInput = document.createElement('textarea');
      valueInput.rows = 2;
      valueInput.placeholder = 'Value';
      valueInput.value = field.value;
      valueInput.addEventListener('input', (event) => {
        field.value = event.target.value;
        this.recordDataChange('data');
      });

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'element-data-card__remove-field';
      remove.textContent = '✕';
      remove.title = 'Remove field';
      remove.addEventListener('click', () => {
        this.data.customFields.splice(index, 1);
        this.renderCustomFields(wrapper);
        this.recordDataChange('data');
      });

      row.appendChild(keyInput);
      row.appendChild(valueInput);
      row.appendChild(remove);
      wrapper.appendChild(row);
    });

    if (!this.data.customFields.length) {
      const empty = document.createElement('p');
      empty.className = 'element-data-card__custom-empty';
      empty.textContent = 'No custom data yet. Add key:value details specific to this element.';
      wrapper.appendChild(empty);
    }
  }

  setPosition(x, y, animate = true) {
    super.setPosition(x, y, animate);
    ElementNode.linkManager?.updateLinksForNode(this);
  }

  setTitle(newTitle) {
    super.setTitle(newTitle);
    this.data.title = this.title;
    ElementNode.linkManager?.updateLinkTitlesForNode(this);
  }

  show() {
    super.show();
    ElementNode.linkManager?.updateLinksForNode(this);
  }

  hide() {
    super.hide();
    ElementNode.linkManager?.updateLinksForNode(this);
  }

  promptForChild() {
    const typeInput = window.prompt('Create which type of element? (character / place / other)');
    if (!typeInput) return null;
    const type = ElementNode.normaliseType(typeInput);
    if (!ElementNode.getNodeClass(type)) {
      window.alert('Unknown element type. Please choose character, place, or other.');
      return null;
    }

    const label = window.prompt(`Enter a title for the new ${TYPE_CONFIG[type]?.label ?? type}:`);
    if (!label) return null;

    const child = this.createTypedChild(type, { title: label });
    child.hide();
    if (!this.expanded) {
      this.expandChildren();
    } else {
      this.layoutChildren();
    }
    return child;
  }

  createTypedChild(type, options = {}) {
    const child = ElementNode.createNode(type, {
      canvas: this.canvas,
      parent: this,
      ...options,
    });
    return this.addChild(child);
  }

  onAddChild() {
    this.promptForChild();
  }
}

class CharacterNode extends ElementNode {
  constructor(options = {}) {
    super({ ...options, type: 'character' });
  }
}

class PlaceNode extends ElementNode {
  constructor(options = {}) {
    super({ ...options, type: 'place' });
  }
}

class OtherNode extends ElementNode {
  constructor(options = {}) {
    super({ ...options, type: 'other' });
  }
}

ElementNode.typeRegistry = {
  character: CharacterNode,
  place: PlaceNode,
  setting: PlaceNode,
  item: OtherNode,
  theme: OtherNode,
  other: OtherNode,
};

export { ElementNode, CharacterNode, PlaceNode, OtherNode };
export default ElementNode;
