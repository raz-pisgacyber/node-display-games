import NodeBase from '../../core/nodebase.js';
import { randomColor } from '../../core/util.js';

const HIERARCHY_SEQUENCE = ['Chapter', 'Scene', 'Moment'];

class HierarchyNode extends NodeBase {
  constructor(options) {
    const { hierarchy = HIERARCHY_SEQUENCE, levelIndex = 0 } = options;
    super({
      layout: 'pyramid',
      pyramidFirstRowCount: options.pyramidFirstRowCount ?? 2,
      pyramidRowIncrement: options.pyramidRowIncrement ?? 1,
      pyramidHorizontalGap: options.pyramidHorizontalGap ?? 160,
      pyramidVerticalGap: options.pyramidVerticalGap ?? 140,
      ...options,
    });

    this.hierarchy = hierarchy;
    this.levelIndex = levelIndex;
  }

  getNextLevelMetadata() {
    if (!this.hierarchy) return null;
    const nextIndex = this.levelIndex + 1;
    if (nextIndex >= this.hierarchy.length) return null;
    const baseLabel = this.hierarchy[nextIndex];
    const existingCount = this.children.filter(
      (child) => child instanceof HierarchyNode && child.levelIndex === nextIndex,
    ).length;
    return {
      nextIndex,
      baseLabel,
      defaultTitle: `${baseLabel} ${existingCount + 1}`,
    };
  }

  onAddChild() {
    const nextMeta = this.getNextLevelMetadata();
    if (!nextMeta) {
      super.onAddChild();
      return;
    }

    const promptLabel = `Name this ${nextMeta.baseLabel.toLowerCase()}`;
    const label = window.prompt(promptLabel, nextMeta.defaultTitle);
    if (!label) return;

    const child = new HierarchyNode({
      canvas: this.canvas,
      hierarchy: this.hierarchy,
      levelIndex: nextMeta.nextIndex,
      title: label,
      color: randomColor(),
      pyramidFirstRowCount: Math.max(1, this.pyramidFirstRowCount - 1),
      pyramidRowIncrement: this.pyramidRowIncrement,
      pyramidHorizontalGap: Math.max(120, this.pyramidHorizontalGap * 0.8),
      pyramidVerticalGap: this.pyramidVerticalGap,
    });

    this.addChild(child);
    if (!this.expanded) {
      this.expandChildren();
    } else {
      this.layoutChildren();
    }
  }
}

class ProjectNode extends NodeBase {
  constructor(options) {
    const defaults = {
      title: 'Project',
      radius: 80,
      childOrbit: 280,
      color: randomColor(),
      layout: 'pyramid',
      pyramidFirstRowCount: 2,
      pyramidRowIncrement: 1,
      pyramidHorizontalGap: 200,
      pyramidVerticalGap: 160,
    };
    super({ ...defaults, ...options });

    this.hierarchy = HIERARCHY_SEQUENCE;
    this.ensureDefaultChildren();
  }

  ensureDefaultChildren() {
    if (this.children.length) return;
    this.createChild({
      title: 'Characters',
      color: '#74b9ff',
      pyramidFirstRowCount: 1,
      pyramidHorizontalGap: 140,
    });
    this.createChild({
      title: 'Settings',
      color: '#55efc4',
      pyramidFirstRowCount: 1,
      pyramidHorizontalGap: 140,
    });
    this.collapseChildren();
  }

  onAddChild() {
    const baseLabel = this.hierarchy[0];
    const existingCount = this.children.filter(
      (child) => child instanceof HierarchyNode && child.levelIndex === 0,
    ).length;
    const defaultTitle = `${baseLabel} ${existingCount + 1}`;
    const label = window.prompt('Name this chapter', defaultTitle);
    if (!label) return;

    const child = new HierarchyNode({
      canvas: this.canvas,
      hierarchy: this.hierarchy,
      levelIndex: 0,
      title: label,
      color: randomColor(),
      pyramidFirstRowCount: Math.max(1, this.pyramidFirstRowCount - 1),
      pyramidRowIncrement: this.pyramidRowIncrement,
      pyramidHorizontalGap: Math.max(140, this.pyramidHorizontalGap * 0.85),
      pyramidVerticalGap: this.pyramidVerticalGap,
    });

    this.addChild(child);
    if (!this.expanded) {
      this.expandChildren();
    } else {
      this.layoutChildren();
    }
  }
}

export default ProjectNode;
export { HierarchyNode };
