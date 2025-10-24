import NodeBase from '../../core/nodebase.js';
import { randomColor } from '../../core/util.js';

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
}

export default ProjectNode;
