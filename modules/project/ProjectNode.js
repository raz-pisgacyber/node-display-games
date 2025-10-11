import NodeBase from '../../core/nodebase.js';
import { randomColor } from '../../core/util.js';

class ProjectNode extends NodeBase {
  constructor(options) {
    const defaults = {
      title: 'Project',
      radius: 80,
      childOrbit: 280,
      color: randomColor(),
    };
    super({ ...defaults, ...options });

    this.ensureDefaultChildren();
  }

  ensureDefaultChildren() {
    if (this.children.length) return;
    this.createChild({ title: 'Characters', color: '#74b9ff' });
    this.createChild({ title: 'Settings', color: '#55efc4' });
    this.collapseChildren();
  }

  onAddChild() {
    const label = window.prompt('Add a new project element');
    if (!label) return;
    this.createChild({ title: label, color: randomColor() });
    this.expandChildren();
  }
}

export default ProjectNode;
