# Knowledge Graph App — Active Tasks

## Core / Shared
- Auto-center and scale on page load so default nodes are immediately in view.
- Card positioning: open each card at the **upper-right of its node**, with smart flip if near viewport edges.
- Improve drag precision under zoom (factor in current transform scale).

## Project Builder
- Verify pyramid layout aligns correctly on load and after adding children; keep user drag overrides intact.
- Recenter viewport on the root node when the builder loads.

## Elements Builder
- Ensure builder starts **empty** (no default “Add Element” marble).
- Recenter viewport when the first element is created.
- Keep cards anchored **upper-right of the triggering node** consistently.
- Optional: SVG/canvas connection lines with performant redraw on pan/zoom.

## UI / Polish
- Subtle recenter animation when switching modules or creating first content.
- Refine marble depth/contrast for readability at different zoom levels.
