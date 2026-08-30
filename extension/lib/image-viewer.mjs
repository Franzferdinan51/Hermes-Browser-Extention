export const IMAGE_ZOOM_MIN = 1;
export const IMAGE_ZOOM_MAX = 4;
export const IMAGE_ZOOM_STEP = 0.25;

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function clampImageZoom(value) {
  return Math.min(IMAGE_ZOOM_MAX, Math.max(IMAGE_ZOOM_MIN, finite(value, IMAGE_ZOOM_MIN)));
}

export function createImageViewerState() {
  return Object.freeze({ scale: IMAGE_ZOOM_MIN, x: 0, y: 0 });
}

export function imageViewerReducer(state = createImageViewerState(), action = {}) {
  const current = {
    scale: clampImageZoom(state.scale),
    x: finite(state.x),
    y: finite(state.y),
  };
  let scale = current.scale;
  let x = current.x;
  let y = current.y;

  switch (action.type) {
    case 'zoom-in':
      scale = clampImageZoom(scale + IMAGE_ZOOM_STEP);
      break;
    case 'zoom-out':
      scale = clampImageZoom(scale - IMAGE_ZOOM_STEP);
      break;
    case 'set-scale':
      scale = clampImageZoom(action.scale);
      break;
    case 'pan':
      if (scale > IMAGE_ZOOM_MIN) {
        x = finite(action.x, x);
        y = finite(action.y, y);
      }
      break;
    case 'reset':
      return createImageViewerState();
    default:
      return Object.freeze(current);
  }

  if (scale <= IMAGE_ZOOM_MIN) {
    x = 0;
    y = 0;
  }
  return Object.freeze({ scale, x, y });
}
