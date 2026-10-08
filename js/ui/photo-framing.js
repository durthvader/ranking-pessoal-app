// O enquadramento usa a imagem original e muda a área visível no cartão.
export function applyPhotoFraming(image, photo) {
  const frame = photo?.framing;
  const values = frame && [frame.x, frame.y, frame.w, frame.h];
  const valid = values?.every(Number.isFinite) && frame.x >= 0 && frame.y >= 0
    && frame.w > 0 && frame.h > 0 && frame.x + frame.w <= 1.000001 && frame.y + frame.h <= 1.000001;
  image.classList.toggle('has-framing', !!valid);
  for (const name of ['left', 'top', 'width', 'height']) image.style.removeProperty(`--framing-${name}`);
  if (!valid) return;
  image.style.setProperty('--framing-left', `${-100 * frame.x / frame.w}%`);
  image.style.setProperty('--framing-top', `${-100 * frame.y / frame.h}%`);
  image.style.setProperty('--framing-width', `${100 / frame.w}%`);
  image.style.setProperty('--framing-height', `${100 / frame.h}%`);
}
