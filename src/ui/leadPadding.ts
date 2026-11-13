/** Screen padding that moves the followed bus a quarter of the view back from the centre, away from where the
 *  route goes next (owner, #155). `from` is the bus and `to` a stop ahead, both in screen pixels. */
export function leadPadding(from: { x: number; y: number }, to: { x: number; y: number }, width: number, height: number) {
  const padding = { top: 0, bottom: 0, left: 0, right: 0 };
  const dx = to.x - from.x, dy = to.y - from.y, length = Math.hypot(dx, dy);
  if (!(width > 0 && height > 0 && length > 1 && Number.isFinite(length))) return padding;
  const x = dx / length, y = dy / length;
  // Half the view as padding on the leading side puts the bus a quarter of the view back from the centre.
  padding.top = y < 0 ? -y * height / 2 : 0; padding.bottom = y > 0 ? y * height / 2 : 0;
  padding.left = x < 0 ? -x * width / 2 : 0; padding.right = x > 0 ? x * width / 2 : 0;
  return padding;
}
