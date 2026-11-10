// Where a drag that started in the Files panel should land, from the geometry the panel measured on the press.
// Pure geometry: the panel, the drag overlay and its tests all read the same rules.
//
// props from mayonaka-files, in window coordinates:
//   path, dir, parent   the dragged row, whether it is a folder, and its folder ("" is the panel's root)
//   cols     { left, right }   the x range every row covers
//   rowH     a row's height, which is also the pitch between rows (they have no gap)
//   first    the top of the first row, last the bottom of the last one
//   folders  [{ path, y }] for every folder row drawn
//   header, tree   the panel header's and the tree's rectangles; null when the panel could not place them
//
// A row's y is the first row's plus its index times rowH: the tree is a flat list.

export const inside = (r, x, y) => Boolean(r) && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

// Nothing moves into the folder it is already in, and a folder cannot go into itself or below itself.
export function canMoveInto(p, to) {
  if (to === (p.parent ?? "")) return false;
  return !(p.dir && (to === p.path || to.startsWith(p.path + "/")));
}

/** The drop under the pointer: { to, rect } (to "" is the panel's root, rect is what lights up), else null. */
export function moveTargetAt(p, x, y) {
  if (!p?.cols) return null;
  const rowH = p.rowH;
  if (p.header && inside(p.header, x, y)) return canMoveInto(p, "") ? { to: "", rect: p.header } : null;
  const c = p.cols;
  if (x < c.left || x > c.right) return null;
  // Rows scrolled out of the tree still have a y; they are not under the pointer.
  if (p.tree && !inside(p.tree, x, y)) return null;
  const row = (p.folders ?? []).find((f) => y >= f.y && y < f.y + rowH);
  if (row) return canMoveInto(p, row.path) ? { to: row.path, rect: { x: c.left, y: row.y, w: c.right - c.left, h: rowH } } : null;
  // The tree's own blank space above the first row or below the last is the panel's root too.
  const blank = p.first != null && p.last != null && (y < p.first || y >= p.last);
  if (blank && p.tree && inside(p.tree, x, y) && canMoveInto(p, "")) return { to: "", rect: p.header ?? p.tree };
  return null;
}
