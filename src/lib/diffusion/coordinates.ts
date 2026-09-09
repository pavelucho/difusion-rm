export function getImageMapping(
  rect: { left: number; top: number; width: number; height: number },
  imgW: number,
  imgH: number
) {
  const scale = Math.min(rect.width / imgW, rect.height / imgH);
  const dispW = imgW * scale;
  const dispH = imgH * scale;
  return {
    offX: rect.left + (rect.width - dispW) / 2,
    offY: rect.top + (rect.height - dispH) / 2,
    scale,
  };
}
