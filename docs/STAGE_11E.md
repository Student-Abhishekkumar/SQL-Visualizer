# Stage 11E — Canvas Experience (Future Scope)

> Recorded during Stage 11C. **Not implemented here.** Do not begin this stage
> until the Stage 11C layout/workspace tasks are complete and verified.

## A. Multiple selectable themes

Add selectable presets:

- Light
- Dark
- Midnight
- Dracula
- Nord
- Solarized Dark

Requirements:

- Theme preview and persistent selection.
- Consistent application, editor and Canvas colors.
- Accessible contrast.
- No regressions in the existing light/dark theme behavior.

## B. Mobile Canvas node interaction

- Tap a node to select it.
- Tap another node to change selection.
- Tap empty Canvas space to deselect.
- Make selection reliable with fingers.
- Preserve Inspector behavior.
- Avoid accidental node dragging.

## C. Touch gestures

- Two-finger pinch to zoom.
- Two-finger drag to pan.
- Zoom centered around the pinch gesture.
- Prevent unwanted page scrolling during Canvas gestures.
- Preserve desktop mouse, wheel and trackpad interactions.

## D. Canvas node sharpness and zoom quality

Investigate why nodes appear blurry when zoomed. Inspect:

- CSS transforms and fractional positioning.
- Browser compositing and GPU rendering.
- SVG or HTML rendering and scaling behavior.
- Canvas/device-pixel-ratio handling, if applicable.
- Text and border rendering at different zoom levels.
- Scaling, filtering and rasterization behavior.

Requirements:

- Keep node text crisp and readable at high and low zoom.
- Keep borders, ports, icons and connection lines sharp.
- Avoid unnecessary rasterization or blurry scaling.
- Maintain smooth zoom and pan performance.
- Preserve node geometry and connection alignment.
- Test at multiple zoom levels and browser/device pixel ratios.

Do not blindly add `translateZ(0)`, `will-change`, or other GPU hints without
measuring their effect.