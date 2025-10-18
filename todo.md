## 🧩 Knowledge Graph App — Development TODO

### 🏠 Main App Page

* [ ] Add **marble entries** for:

  * Story Builder
  * Elements Hub
* [ ] Ensure navigation animation (zoom-fade) matches Project Builder transition.
* [ ] Unify marble design across index and all modules (use shared CSS from `core.css`).

---

### 📘 Project Builder (`modules/project`)

#### 🧠 Behavior & Logic

* [ ] Remove default child nodes (`Characters`, `Settings`).
* [ ] Each node can contain **Characters**, **Settings**, and other story metadata within its **Data Card** — not as separate nodes.
* [ ] Clicking a node (not icons) should:

  * **Expand/Collapse** its children (pyramid layout).
  * **Never** create new nodes.
  * **Not** interfere with drag behavior — dragging must still work as usual.
* [ ] The **➕ Add Child** button remains for adding child nodes manually.
* [ ] Arrange child nodes automatically in a **pyramid formation** under their parent by default:

  * Root node at top center.
  * Child nodes centered below.
  * Auto-spacing and alignment between tiers.
  * Allow user drag to override default placement.
* [ ] Add a **collapse / expand icon** on each node for quick toggle.
* [ ] Hide connection lines between nodes in this builder.

#### 🧰 Node UI & Icons

* [ ] Node icon bar includes:

  * `📄` Data Card — edit metadata.
  * `💬` Discussion Card.
  * `➕` Add Child Node.
  * `📝` Full Text Editor (main content for chapter / scene / moment).
* [ ] Each node visually scales **+10% for each new child node**.
* [ ] Upgrade node visuals:

  * Make marbles **3D-style / mock-glass** look (layered gradient + inner light + shadow).
  * Apply subtle hover glow.

---

### 🧱 Elements Builder (`modules/elements`)

#### 🧠 Behavior & Logic

* [ ] Builder starts **empty** — no default nodes.
* [ ] The workspace contains **one fixed top-level “Add Element” marble** only.
* [ ] Clicking on this marble opens a modal / popup to **create a new element**:

  * Enter **Name**.
  * Select **Type** from dropdown (`Character`, `Place`, `Item`, `Theme`, etc.).
* [ ] Clicking on existing elements should **not** create new elements.
* [ ] Maintain **drag & drop** for all existing nodes (click ≠ create).
* [ ] Show **visible connecting lines** between related nodes.
* [ ] Apply **node growth rule** (+10% size per connection).

---

### ⚙️ Core / Shared Logic

* [ ] Refactor `util.enableZoomPan()`:

  * Normalize pan/zoom behavior across all modules.
  * Support per-module settings (visible connections, node spacing modes).
* [ ] Unify `workspace` / `canvas` creation logic to prevent duplication.
* [ ] Refine drag system to coexist with node click events (no overlap or stuck states).
* [ ] Extend node class hierarchy:

  * Base: `NodeBase` → common visuals, drag, zoom awareness.
  * Specialized: `ProjectNode`, `ElementNode`, etc. for module-specific logic.
* [ ] Add CSS support for “pyramid layout mode” and “mock-3D marbles.”

---

### 🎨 Design / UI Polish

* [ ] Update marble CSS:

  * Add **radial highlights**, **soft reflections**, **depth gradient**, and **inset glow**.
  * Slight hover pulse or shadow animation.
* [ ] Optional: implement **SVG or canvas layer** for link lines (only visible in Elements Builder).
* [ ] Add smooth expand/collapse transitions for Project Builder nodes.

---

✅ **Current status:**
Architecture finalized.
All modules need refactoring for distinct interaction modes (Project vs. Elements).
Visual upgrade & layout logic next.

