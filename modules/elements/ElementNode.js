import NodeBase from '../../core/nodebase.js';

const TYPE_CONFIG = {
  character: {
    label: 'Character',
    color: '#fd79a8',
  },
  setting: {
    label: 'Setting',
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
    super({ ...defaults, ...options });
    this.type = type;
    this.element.classList.add('element-node', `element-${this.type}`);
    this.element.dataset.elementType = this.type;
  }

  static normaliseType(type) {
    if (!type) return 'other';
    const normalised = String(type).trim().toLowerCase();
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

  promptForChild() {
    const typeInput = window.prompt('Create which type of element? (character / setting / other)');
    if (!typeInput) return null;
    const type = ElementNode.normaliseType(typeInput);
    if (!ElementNode.getNodeClass(type)) {
      window.alert('Unknown element type. Please choose character, setting, or other.');
      return null;
    }

    const label = window.prompt(`Enter a title for the new ${type}:`);
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

class SettingNode extends ElementNode {
  constructor(options = {}) {
    super({ ...options, type: 'setting' });
  }
}

class OtherNode extends ElementNode {
  constructor(options = {}) {
    super({ ...options, type: 'other' });
  }
}

ElementNode.typeRegistry = {
  character: CharacterNode,
  setting: SettingNode,
  other: OtherNode,
};

export { ElementNode, CharacterNode, SettingNode, OtherNode };
export default ElementNode;
