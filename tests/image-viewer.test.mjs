import test from 'node:test';
import assert from 'node:assert/strict';

import {
  IMAGE_ZOOM_MAX,
  IMAGE_ZOOM_MIN,
  createImageViewerState,
  imageViewerReducer,
} from '../extension/lib/image-viewer.mjs';

test('image viewer zoom is bounded and resets between images', () => {
  let state = createImageViewerState();
  assert.deepEqual(state, { scale: 1, x: 0, y: 0 });

  for (let index = 0; index < 20; index += 1) state = imageViewerReducer(state, { type: 'zoom-in' });
  assert.equal(state.scale, IMAGE_ZOOM_MAX);

  state = imageViewerReducer(state, { type: 'pan', x: 80, y: -42 });
  assert.deepEqual({ x: state.x, y: state.y }, { x: 80, y: -42 });

  state = imageViewerReducer(state, { type: 'reset' });
  assert.deepEqual(state, { scale: 1, x: 0, y: 0 });

  for (let index = 0; index < 20; index += 1) state = imageViewerReducer(state, { type: 'zoom-out' });
  assert.equal(state.scale, IMAGE_ZOOM_MIN);
  assert.deepEqual({ x: state.x, y: state.y }, { x: 0, y: 0 });
});

test('panning is ignored at the fitted scale and zooming out recenters the image', () => {
  const fitted = imageViewerReducer(createImageViewerState(), { type: 'pan', x: 100, y: 100 });
  assert.deepEqual(fitted, { scale: 1, x: 0, y: 0 });

  let zoomed = imageViewerReducer(fitted, { type: 'set-scale', scale: 2 });
  zoomed = imageViewerReducer(zoomed, { type: 'pan', x: 30, y: 20 });
  zoomed = imageViewerReducer(zoomed, { type: 'set-scale', scale: 1 });
  assert.deepEqual(zoomed, { scale: 1, x: 0, y: 0 });
});
