const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
function makeSelrect(x, y, width, height) {
  return {
    x,
    y,
    width,
    height,
    x1: x,
    y1: y,
    x2: x + width,
    y2: y + height
  };
}
function point(x, y) {
  return { x, y };
}
function makeRect(x, y, width, height) {
  return makeSelrect(x, y, width, height);
}
function rectToPoints(rect) {
  const x = rect.x;
  const y = rect.y;
  const w = Math.max(rect.width || 0, 0.01);
  const h = Math.max(rect.height || 0, 0.01);
  if (typeof x !== "number" || typeof y !== "number") {
    return null;
  }
  return [
    point(x, y),
    point(x + w, y),
    point(x + w, y + h),
    point(x, y + h)
  ];
}
function pointsToRect(points) {
  if (!points || points.length === 0) {
    return null;
  }
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (const pt of points) {
    const x = pt.x;
    const y = pt.y;
    if (typeof x === "number" && typeof y === "number") {
      minx = Math.min(minx, x);
      miny = Math.min(miny, y);
      maxx = Math.max(maxx, x);
      maxy = Math.max(maxy, y);
    }
  }
  if (!isFinite(minx) || !isFinite(miny) || !isFinite(maxx) || !isFinite(maxy)) {
    return null;
  }
  return makeRect(minx, miny, maxx - minx, maxy - miny);
}
function rectToCenter(rect) {
  const x = rect.x;
  const y = rect.y;
  const w = rect.width;
  const h = rect.height;
  if (typeof x !== "number" || typeof y !== "number" || typeof w !== "number" || typeof h !== "number") {
    return null;
  }
  return point(x + w / 2, y + h / 2);
}
function joinRects(rects) {
  if (!rects || rects.length === 0) {
    return null;
  }
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (const rect of rects) {
    const x = rect.x;
    const y = rect.y;
    const x2 = rect.x2 ?? x + (rect.width || 0);
    const y2 = rect.y2 ?? y + (rect.height || 0);
    if (typeof x === "number" && typeof y === "number" && typeof x2 === "number" && typeof y2 === "number") {
      minx = Math.min(minx, x);
      miny = Math.min(miny, y);
      maxx = Math.max(maxx, x2);
      maxy = Math.max(maxy, y2);
    }
  }
  if (!isFinite(minx) || !isFinite(miny) || !isFinite(maxx) || !isFinite(maxy)) {
    return null;
  }
  return makeRect(minx, miny, maxx - minx, maxy - miny);
}
function containsRect(rectA, rectB) {
  const ax1 = rectA.x1 ?? rectA.x;
  const ax2 = rectA.x2 ?? rectA.x + (rectA.width || 0);
  const ay1 = rectA.y1 ?? rectA.y;
  const ay2 = rectA.y2 ?? rectA.y + (rectA.height || 0);
  const bx1 = rectB.x1 ?? rectB.x;
  const bx2 = rectB.x2 ?? rectB.x + (rectB.width || 0);
  const by1 = rectB.y1 ?? rectB.y;
  const by2 = rectB.y2 ?? rectB.y + (rectB.height || 0);
  return bx1 >= ax1 && bx2 <= ax2 && by1 >= ay1 && by2 <= ay2;
}
function shapesToRect(shapes) {
  const rects = shapes.map((shape) => {
    const points = shape.points;
    if (points && points.length > 0) {
      return pointsToRect(points);
    }
    return null;
  }).filter((rect) => rect !== null);
  return joinRects(rects);
}
function shapeToCenter(shape) {
  const selrect = shape.selrect;
  if (!selrect) {
    return null;
  }
  return rectToCenter(selrect);
}
function rectContainsShape(rect, shape) {
  const points = shape.points;
  if (!points || points.length === 0) {
    return false;
  }
  for (const point2 of points) {
    const px = point2.x;
    const py = point2.y;
    const x1 = rect.x;
    const y1 = rect.y;
    const x2 = rect.x2 ?? rect.x + (rect.width || 0);
    const y2 = rect.y2 ?? rect.y + (rect.height || 0);
    if (px < x1 || px > x2 || py < y1 || py > y2) {
      return false;
    }
  }
  return true;
}
function isTextShape(shape) {
  return shape != null && shape.type === "text";
}
function isFrameShape(shape) {
  return shape != null && shape.type === "frame";
}
function isBoolShape(shape) {
  return shape != null && shape.type === "bool";
}
function isRootFrame(shape) {
  return shape != null && shape.type === "frame" && shape.id !== ZERO_UUID && shape.frameId === ZERO_UUID;
}
function getImmediateChildren(objects, shapeId = ZERO_UUID) {
  const shape = objects[shapeId];
  if (!shape || !shape.shapes) {
    return [];
  }
  return shape.shapes.map((id) => objects[id]).filter(
    (child) => child != null && !child.hidden && !child.blocked
  );
}
function isIndexedShape(shape) {
  return shape != null;
}
function assignHierarchy(shape, id, parentId, frameId) {
  const out = { ...shape, parentId, frameId };
  if (id !== void 0) {
    out.id = id;
  }
  return out;
}
function ensureShapes(shape, childIds) {
  if (childIds !== void 0 && childIds !== null) {
    return { ...shape, shapes: childIds.length > 0 ? childIds : void 0 };
  }
  return shape;
}
function getParentId$1(objects, shapeId) {
  const shape = objects[shapeId];
  if (!shape) {
    return null;
  }
  const parentId = shape.parentId;
  if (!parentId || parentId === shapeId) {
    return null;
  }
  return parentId;
}
function getParentIds(objects, shapeId) {
  const result = [];
  let id = shapeId;
  while (id) {
    const parentId = getParentId$1(objects, id);
    if (parentId && parentId !== id) {
      result.push(parentId);
      id = parentId;
    } else {
      break;
    }
  }
  return result;
}
function generateIndexRecursive(index, objects, shapeId, parents) {
  const shape = objects[shapeId];
  if (!shape) {
    return index;
  }
  index[shapeId] = new Set(parents);
  const newParents = [shapeId, ...parents];
  const children = "shapes" in shape ? shape.shapes ?? [] : [];
  for (const childId of children) {
    index = generateIndexRecursive(index, objects, childId, newParents);
  }
  return index;
}
function generateChildAllParentsIndex(objects, shapes) {
  if (shapes) {
    const index = {};
    for (const shape of shapes) {
      const parentIds = getParentIds(objects, shape.id);
      index[shape.id] = new Set(parentIds);
    }
    return index;
  }
  return generateIndexRecursive({}, objects, ZERO_UUID, []);
}
function createClipIndex(objects, parentsIndex) {
  const clipIndex = {};
  function getClipParents(shape) {
    const result = [];
    if (isFrameShape(shape) && !shape.showContent && shape.id !== ZERO_UUID) {
      result.push(shape);
    }
    if (isBoolShape(shape)) {
      result.push(shape);
    }
    if (shape.maskedGroup && "shapes" in shape && shape.shapes && shape.shapes.length > 0) {
      const firstChild = objects[shape.shapes[0]];
      if (firstChild) {
        result.push(firstChild);
      }
    }
    return result;
  }
  for (const [shapeId, parents] of Object.entries(parentsIndex)) {
    const shape = objects[shapeId];
    if (!shape) {
      continue;
    }
    const clipParents = [];
    for (const parentId of parents) {
      const parent = objects[parentId];
      if (parent) {
        clipParents.push(...getClipParents(parent));
      }
    }
    if (clipParents.length > 0) {
      clipIndex[shapeId] = clipParents;
    }
  }
  return clipIndex;
}
function getChildrenIds(objects, shapeId) {
  const shape = objects[shapeId];
  if (!shape || !("shapes" in shape) || !shape.shapes) {
    return [];
  }
  const result = [];
  const stack = [...shape.shapes];
  while (stack.length > 0) {
    const id = stack.pop();
    result.push(id);
    const child = objects[id];
    if (child && "shapes" in child && child.shapes) {
      stack.push(...child.shapes);
    }
  }
  return result;
}
function normalizeShapes(shapes) {
  if (Array.isArray(shapes)) {
    return shapes.filter((s) => typeof s === "string");
  }
  if (typeof shapes === "string") {
    return [shapes];
  }
  return [];
}
function getParentId(c) {
  return c.parentId ?? void 0;
}
function getFrameId(c) {
  return c.frameId;
}
function insertAtIndex(arr, index, items) {
  const list = [...arr];
  if (index == null || index >= list.length) {
    return [...list, ...items];
  }
  list.splice(index, 0, ...items);
  return list;
}
function getDescendantIds(objects, shapeId) {
  const result = [];
  const stack = [shapeId];
  while (stack.length > 0) {
    const id = stack.pop();
    const shape = objects[id];
    const childIds = shape?.shapes;
    if (childIds?.length) {
      for (const cid of childIds) {
        result.push(cid);
        stack.push(cid);
      }
    }
  }
  return result;
}
function processOperation(shape, op) {
  switch (op.type) {
    case "assign": {
      const assignOp = op;
      const value = assignOp.value ?? {};
      return { ...shape, ...value };
    }
    case "set": {
      const setOp = op;
      const attr = setOp.attr;
      const val = setOp.val;
      return { ...shape, [attr]: val };
    }
    case "set-touched": {
      const touched = op.touched;
      if (touched == null || Array.isArray(touched) && touched.length === 0) {
        const { touched: _t, ...rest } = shape;
        return rest;
      }
      const touchedSet = Array.isArray(touched) ? new Set(touched) : touched;
      return { ...shape, touched: Array.from(touchedSet) };
    }
    case "set-remote-synced": {
      const remoteSynced = op.remoteSynced;
      if (!remoteSynced) {
        const { remoteSynced: _r, ...rest } = shape;
        return rest;
      }
      return { ...shape, remoteSynced: true };
    }
    default:
      return shape;
  }
}
function processAddObj(data, change) {
  const { id, obj } = change;
  const parentId = getParentId(change) ?? getFrameId(change) ?? ZERO_UUID;
  const frameId = getFrameId(change) ?? parentId;
  const index = change.index ?? null;
  const objects = { ...data.objects };
  const parent = objects[parentId];
  const resolvedParentId = parent ? parentId : ZERO_UUID;
  const resolvedFrameId = objects[frameId] ? frameId : ZERO_UUID;
  const childIds = obj.children?.map((c) => c.id).filter((sid) => sid != null);
  const frameIdForShape = obj.type === "frame" ? id ?? obj.id ?? resolvedFrameId : resolvedFrameId;
  const shapeWithMeta = ensureShapes(
    assignHierarchy(obj, id, resolvedParentId, frameIdForShape),
    childIds
  );
  objects[id] = shapeWithMeta;
  const parentShape = objects[resolvedParentId];
  if (parentShape) {
    const shapes = parentShape.shapes ?? [];
    const newShapes = shapes.includes(id) ? shapes : insertAtIndex(shapes, index, [id]).filter(Boolean);
    objects[resolvedParentId] = {
      ...parentShape,
      shapes: newShapes
    };
  }
  return { ...data, objects };
}
function processDelObj(data, change) {
  const { id } = change;
  const objects = { ...data.objects };
  const target = objects[id];
  if (!target) {
    return data;
  }
  const parentId = target.parentId ?? target.frameId ?? ZERO_UUID;
  const toRemove = [id, ...getDescendantIds(objects, id)];
  for (const rid of toRemove) {
    delete objects[rid];
  }
  const parent = objects[parentId];
  if (parent) {
    const shapes = (parent.shapes ?? []).filter((s) => !toRemove.includes(s));
    objects[parentId] = { ...parent, shapes };
  }
  return { ...data, objects };
}
function processModObj(data, change) {
  const { id, operations } = change;
  const objects = { ...data.objects };
  const shape = objects[id];
  if (!shape) {
    return data;
  }
  const updated = operations.reduce(processOperation, shape);
  objects[id] = updated;
  return { ...data, objects };
}
function processMovObjects(data, change) {
  const parentId = getParentId(change) ?? "";
  const shapeIds = normalizeShapes(change.shapes);
  const index = change.index ?? null;
  const afterShape = change.afterShape ?? null;
  const objects = { ...data.objects };
  const parent = objects[parentId];
  if (!parent || shapeIds.length === 0) {
    return data;
  }
  const frameId = !isIndexedShape(parent) ? ZERO_UUID : isFrameShape(parent) ? parent.id : parent.frameId ?? ZERO_UUID;
  const insertIndex = afterShape != null ? (parent.shapes?.indexOf(afterShape) ?? -1) + 1 : index;
  const parentShapes = parent.shapes ?? [];
  let newParentShapes = [...parentShapes];
  for (const shapeId of shapeIds) {
    if (!newParentShapes.includes(shapeId)) {
      newParentShapes = insertAtIndex(newParentShapes, insertIndex, [shapeId]);
    }
  }
  objects[parentId] = { ...parent, shapes: newParentShapes };
  for (const shapeId of shapeIds) {
    const shape = objects[shapeId];
    if (shape) {
      objects[shapeId] = {
        ...shape,
        parentId,
        frameId
      };
    }
  }
  for (const shapeId of shapeIds) {
    const shape = objects[shapeId];
    if (!shape) continue;
    const oldParentId = shape.parentId;
    if (oldParentId && oldParentId !== parentId) {
      const oldParent = objects[oldParentId];
      if (oldParent) {
        const oldShapes = (oldParent.shapes ?? []).filter((s) => s !== shapeId);
        objects[oldParentId] = { ...oldParent, shapes: oldShapes };
      }
    }
  }
  const updateFrameIdRec = (objs, fid, sid) => {
    const s = objs[sid];
    if (isIndexedShape(s)) {
      objs[sid] = { ...s, frameId: fid };
      const sShapes = s.shapes;
      if (sShapes && !isFrameShape(s)) {
        for (const cid of sShapes) {
          updateFrameIdRec(objs, fid, cid);
        }
      }
    }
  };
  for (const shapeId of shapeIds) {
    const shape = objects[shapeId];
    if (isIndexedShape(shape) && !isFrameShape(shape)) {
      const shapeShapes = shape.shapes;
      if (shapeShapes) {
        for (const cid of shapeShapes) {
          updateFrameIdRec(objects, frameId, cid);
        }
      }
    }
  }
  return { ...data, objects };
}
function processReorderChildren(data, change) {
  const parentId = getParentId(change) ?? "";
  const order = normalizeShapes(change.shapes);
  const objects = { ...data.objects };
  const parent = objects[parentId];
  if (!parent) {
    return data;
  }
  const oldShapes = parent.shapes ?? [];
  const idToIdx = /* @__PURE__ */ new Map();
  order.forEach((id, idx) => idToIdx.set(id, idx));
  const sorted = [...oldShapes].sort((a, b) => {
    const ia = idToIdx.get(a) ?? -1;
    const ib = idToIdx.get(b) ?? -1;
    return ia - ib;
  });
  if (JSON.stringify(sorted) === JSON.stringify(oldShapes)) {
    return data;
  }
  objects[parentId] = { ...parent, shapes: sorted };
  return { ...data, objects };
}
function processChange(data, change) {
  switch (change.type) {
    case "add-obj":
      return processAddObj(data, change);
    case "del-obj":
      return processDelObj(data, change);
    case "mod-obj":
      return processModObj(data, change);
    case "mov-objects":
      return processMovObjects(data, change);
    case "reorder-children":
      return processReorderChildren(data, change);
    default:
      return data;
  }
}
function processChanges(data, changes) {
  return changes.reduce(processChange, data);
}
const handlers = /* @__PURE__ */ new Map();
function registerHandler(cmd, handler2) {
  handlers.set(cmd, handler2);
}
function handler(message) {
  const cmd = message.cmd || (typeof message.payload === "object" && message.payload !== null && "cmd" in message.payload ? String(message.payload.cmd) : "") || "";
  const handlerFn = handlers.get(cmd);
  if (handlerFn) {
    return handlerFn(message);
  }
  console.warn("Unexpected message:", message);
  return null;
}
registerHandler("echo", (message) => message);
registerHandler("configure", (message) => {
  const config = typeof message.payload === "object" && message.payload !== null && "config" in message.payload ? message.payload.config : void 0;
  if (config) {
    console.info("Configure worker:", Object.keys(config));
  }
  return null;
});
function encode(message) {
  const cmd = message.cmd || (typeof message.payload === "object" && message.payload !== null && "cmd" in message.payload ? message.payload.cmd : "") || "";
  const cmdName = typeof cmd === "string" ? cmd : "";
  return {
    cmd: cmdName,
    replyTo: message.replyTo,
    payload: message.payload,
    buffer: message.buffer
  };
}
function decode(data) {
  const cmd = data.cmd;
  const replyTo = data.replyTo;
  const payload = data.payload;
  const buffer = data.buffer;
  const result = {
    cmd,
    replyTo: replyTo ?? ""
  };
  if (payload) {
    result.payload = payload;
  }
  if (buffer !== void 0) {
    result.buffer = buffer;
  }
  return result;
}
class Quadtree {
  maxObjects;
  maxLevels;
  level;
  bounds;
  objects;
  indexes;
  constructor(bounds, maxObjects = 10, maxLevels = 4, level = 0) {
    this.maxObjects = maxObjects;
    this.maxLevels = maxLevels;
    this.level = level;
    this.bounds = bounds;
    this.objects = [];
    this.indexes = [];
  }
  split() {
    const nextLevel = this.level + 1;
    const subWidth = this.bounds.width / 2;
    const subHeight = this.bounds.height / 2;
    const x = this.bounds.x;
    const y = this.bounds.y;
    this.indexes[0] = new Quadtree(
      makeSelrect(x + subWidth, y, subWidth, subHeight),
      this.maxObjects,
      this.maxLevels,
      nextLevel
    );
    this.indexes[1] = new Quadtree(
      makeSelrect(x, y, subWidth, subHeight),
      this.maxObjects,
      this.maxLevels,
      nextLevel
    );
    this.indexes[2] = new Quadtree(
      makeSelrect(x, y + subHeight, subWidth, subHeight),
      this.maxObjects,
      this.maxLevels,
      nextLevel
    );
    this.indexes[3] = new Quadtree(
      makeSelrect(x + subWidth, y + subHeight, subWidth, subHeight),
      this.maxObjects,
      this.maxLevels,
      nextLevel
    );
  }
  *getIndexes(rect) {
    const verticalMidpoint = this.bounds.x + this.bounds.width / 2;
    const horizontalMidpoint = this.bounds.y + this.bounds.height / 2;
    const startIsNorth = rect.y < horizontalMidpoint;
    const startIsWest = rect.x < verticalMidpoint;
    const endIsEast = rect.x + rect.width > verticalMidpoint;
    const endIsSouth = rect.y + rect.height > horizontalMidpoint;
    if (startIsNorth && endIsEast) {
      yield this.indexes[0];
    }
    if (startIsWest && startIsNorth) {
      yield this.indexes[1];
    }
    if (startIsWest && endIsSouth) {
      yield this.indexes[2];
    }
    if (endIsEast && endIsSouth) {
      yield this.indexes[3];
    }
  }
  insert(node) {
    if (this.indexes.length > 0) {
      for (const index of this.getIndexes(node.bounds)) {
        index.insert(node);
      }
    } else {
      this.objects.push(node);
      if (this.objects.length > this.maxObjects && this.level < this.maxLevels) {
        if (this.indexes.length === 0) {
          this.split();
        }
        for (const obj of this.objects) {
          for (const index of this.getIndexes(obj.bounds)) {
            index.insert(obj);
          }
        }
        this.objects = [];
      }
    }
  }
  count() {
    if (this.indexes.length === 0) {
      return this.objects.length;
    } else {
      let sum = 0;
      for (const index of this.indexes) {
        sum += index.count();
      }
      return sum;
    }
  }
  *search(rect) {
    if (this.indexes.length === 0) {
      yield* this.objects;
    } else {
      for (const index of this.getIndexes(rect)) {
        yield* index.search(rect);
      }
    }
  }
  clear() {
    this.objects = [];
    this.indexes = [];
  }
  getObjects() {
    return this.objects;
  }
}
function create(bounds) {
  return new Quadtree(bounds, 10, 4, 0);
}
function insert(index, id, bounds, data) {
  const node = { id, bounds, data };
  index.insert(node);
  return index;
}
function* search(index, rect) {
  const tmp = /* @__PURE__ */ new Set();
  for (const item of index.search(rect)) {
    if (!tmp.has(item.id)) {
      tmp.add(item.id);
      yield item;
    }
  }
}
function removeAll(index, ids) {
  const result = create(index.bounds);
  for (const node of search(index, index.bounds)) {
    if (!ids.has(node.id)) {
      insert(result, node.id, node.bounds, node.data);
    }
  }
  return result;
}
function inverseTransformPoint(world, t) {
  const det = t.a * t.d - t.b * t.c;
  if (Math.abs(det) < EPSILON) return world;
  const px = world.x - t.e;
  const py = world.y - t.f;
  return point(
    (t.d * px - t.c * py) / det,
    (-t.b * px + t.a * py) / det
  );
}
const EPSILON = 1e-10;
function almostZero(value) {
  return Math.abs(value) < EPSILON;
}
function isIdentityTransform(t) {
  if (!t) return true;
  return Math.abs(t.a - 1) < EPSILON && Math.abs(t.b) < EPSILON && Math.abs(t.c) < EPSILON && Math.abs(t.d - 1) < EPSILON && Math.abs(t.e) < EPSILON && Math.abs(t.f) < EPSILON;
}
function sq(value) {
  return value * value;
}
function sqrt(value) {
  return Math.sqrt(value);
}
function orientation(p1, p2, p3) {
  const v = (p2.y - p1.y) * (p3.x - p2.x) - (p3.y - p2.y) * (p2.x - p1.x);
  if (v > 0) return "clockwise";
  if (v < 0) return "counter-clockwise";
  return "coplanar";
}
function onSegment(q, p, r) {
  return q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) && q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y);
}
function intersectSegments([p1, q1], [p2, q2]) {
  const o1 = orientation(p1, q1, p2);
  const o2 = orientation(p1, q1, q2);
  const o3 = orientation(p2, q2, p1);
  const o4 = orientation(p2, q2, q1);
  return (
    // General case
    o1 !== o2 && o3 !== o4 || // p1, q1 and p2 colinear and p2 lies on p1q1
    o1 === "coplanar" && onSegment(p2, p1, q1) || // p1, q1 and q2 colinear and q2 lies on p1q1
    o2 === "coplanar" && onSegment(q2, p1, q1) || // p2, q2 and p1 colinear and p1 lies on p2q2
    o3 === "coplanar" && onSegment(p1, p2, q2) || // p2, q2 and p1 colinear and q1 lies on p2q2
    o4 === "coplanar" && onSegment(q1, p2, q2)
  );
}
function pointsToLines(points, closed = true) {
  if (points.length === 0) {
    return [];
  }
  const lines = [];
  for (let i = 0; i < points.length; i++) {
    const next = closed && i === points.length - 1 ? 0 : i + 1;
    if (next < points.length) {
      lines.push([points[i], points[next]]);
    }
  }
  return lines;
}
function intersectsLines(linesA, linesB) {
  for (const curLine of linesA) {
    for (const lineB of linesB) {
      if (intersectSegments(curLine, lineB)) {
        return true;
      }
    }
  }
  return false;
}
function intersectRay(p, [p1, p2]) {
  const { x: px, y: py } = p;
  const { x: x1, y: y1 } = p1;
  const { x: x2, y: y2 } = p2;
  if (y1 <= py && y2 > py || y1 > py && y2 <= py) {
    const vt = (py - y1) / (y2 - y1);
    const ix = x1 + vt * (x2 - x1);
    return px < ix;
  }
  return false;
}
function isPointInsideEvenOdd(p, lines) {
  const intersections = lines.filter((line) => intersectRay(p, line));
  return intersections.length % 2 === 1;
}
function nextWindup(wn, p, [p1, p2]) {
  const lineSide = (p2.x - p1.x) * (p.y - p1.y) - (p.x - p1.x) * (p2.y - p1.y);
  if (p1.y <= p.y) {
    if (p2.y > p.y && lineSide > 0) {
      return wn + 1;
    }
    return wn;
  } else {
    if (p2.y <= p.y && lineSide < 0) {
      return wn - 1;
    }
    return wn;
  }
}
function isPointInsideNonzero(p, lines) {
  let wn = 0;
  for (const line of lines) {
    wn = nextWindup(wn, p, line);
  }
  return wn !== 0;
}
function overlapsRectPoints(rect, points) {
  const rectPoints = rectToPoints(rect);
  if (!rectPoints || rectPoints.length === 0) {
    return false;
  }
  const rectLines = pointsToLines(rectPoints);
  const pointsLines = pointsToLines(points);
  return isPointInsideEvenOdd(rectPoints[0], pointsLines) || isPointInsideEvenOdd(points[0], rectLines) || intersectsLines(rectLines, pointsLines);
}
function overlapsPath(shape, rect, includeContent) {
  const content = "content" in shape ? shape.content : void 0;
  if (!content || Array.isArray(content) && content.length === 0) {
    return false;
  }
  const points = shape.points;
  if (!points || points.length === 0) {
    return false;
  }
  const rectPoints = rectToPoints(rect);
  if (!rectPoints) {
    return false;
  }
  const rectLines = pointsToLines(rectPoints);
  const pathLines = pointsToLines(points);
  if (intersectsLines(rectLines, pathLines)) {
    return true;
  }
  if (includeContent) {
    return isPointInsideNonzero(rectPoints[0], pathLines) || points.length > 0 && isPointInsideNonzero(points[0], rectLines);
  }
  return false;
}
function isPointInsideEllipse(pt, cx, cy, rx, ry) {
  const v = sq(pt.x - cx) / sq(rx) + sq(pt.y - cy) / sq(ry);
  return v <= 1;
}
function intersectsLineEllipse([p1, p2], cx, cy, rx, ry) {
  const { x: x1, y: y1 } = p1;
  const { x: x2, y: y2 } = p2;
  const a = sq(x2 - x1) / sq(rx) + sq(y2 - y1) / sq(ry);
  const b = (2 * x1 * (x2 - x1) - 2 * cx * (x2 - x1)) / sq(rx) + (2 * y1 * (y2 - y1) - 2 * cy * (y2 - y1)) / sq(ry);
  const c = (sq(x1) + sq(cx) - 2 * x1 * cx) / sq(rx) + (sq(y1) + sq(cy) - 2 * y1 * cy) / sq(ry) - 1;
  const determ = sq(b) - 4 * a * c;
  if (almostZero(a)) {
    if (almostZero(b)) {
      return false;
    }
    const t = -c / b;
    return t >= 0 && t <= 1;
  }
  if (determ < 0) {
    return false;
  }
  const t1 = (-b + sqrt(determ)) / (2 * a);
  const t2 = (-b - sqrt(determ)) / (2 * a);
  return t1 >= 0 && t1 <= 1 || t2 >= 0 && t2 <= 1;
}
function overlapsEllipse(shape, rect) {
  const x = shape.x;
  const y = shape.y;
  const width = shape.width;
  const height = shape.height;
  const rx = width / 2;
  const ry = height / 2;
  const transform = shape.transform;
  let rectPoints = rectToPoints(rect);
  if (!rectPoints) {
    return false;
  }
  let cx;
  let cy;
  let center;
  if (transform) {
    const sr = shape.selrect;
    const worldCenterX = sr != null && typeof sr.x === "number" && typeof sr.width === "number" ? sr.x + sr.width / 2 : x + width / 2;
    const worldCenterY = sr != null && typeof sr.y === "number" && typeof sr.height === "number" ? sr.y + sr.height / 2 : y + height / 2;
    const det = transform.a * transform.d - transform.b * transform.c;
    if (Math.abs(det) < EPSILON) return false;
    const transformLinear = { ...transform, e: 0, f: 0 };
    rectPoints = rectPoints.map(
      (p) => inverseTransformPoint(point(p.x - worldCenterX, p.y - worldCenterY), transformLinear)
    );
    cx = 0;
    cy = 0;
    center = point(0, 0);
  } else {
    cx = x + width / 2;
    cy = y + height / 2;
    center = point(cx, cy);
  }
  const rectLines = pointsToLines(rectPoints);
  if (isPointInsideEvenOdd(center, rectLines)) {
    return true;
  }
  for (const pt of rectPoints) {
    if (isPointInsideEllipse(pt, cx, cy, rx, ry)) {
      return true;
    }
  }
  for (const line of rectLines) {
    if (intersectsLineEllipse(line, cx, cy, rx, ry)) return true;
  }
  return false;
}
function overlapsText(shape, rect) {
  const positionData = shape.positionData;
  const points = shape.points;
  if (positionData && Array.isArray(positionData) && positionData.length > 0) {
    if (points && points.length > 0) {
      return overlapsRectPoints(rect, points);
    }
    return false;
  }
  if (points && points.length > 0) {
    return overlapsRectPoints(rect, points);
  }
  return false;
}
function getShapePointsForOverlap(shape) {
  if (shape.points && shape.points.length > 0) {
    return shape.points;
  }
  const sr = shape.selrect;
  if (!sr) return [];
  const x = sr.x;
  const y = sr.y;
  const width = sr.width ?? (typeof sr.x2 === "number" && typeof sr.x1 === "number" ? sr.x2 - sr.x1 : 0);
  const height = sr.height ?? (typeof sr.y2 === "number" && typeof sr.y1 === "number" ? sr.y2 - sr.y1 : 0);
  if (typeof x !== "number" || typeof y !== "number" || width <= 0 || height <= 0) return [];
  const rect = makeSelrect(x, y, width, height);
  const pts = rectToPoints(rect);
  return pts ?? [];
}
function getStrokePaddingOuter(shape) {
  const strokes = shape.strokes;
  if (!strokes || strokes.length === 0) return 0;
  let max = 0;
  for (const s of strokes) {
    const w = s.strokeWidth ?? 0;
    const align = s.strokeAlignment ?? "center";
    const padding = align === "center" ? w : align === "outer" ? 2 * w : 0;
    if (padding > max) max = padding;
  }
  return max;
}
function getStrokePaddingInner(shape) {
  const strokes = shape.strokes;
  if (!strokes || strokes.length === 0) return 0;
  let max = 0;
  for (const s of strokes) {
    const w = s.strokeWidth ?? 0;
    const align = s.strokeAlignment ?? "center";
    const padding = align === "center" ? w : align === "inner" ? 2 * w : 0;
    if (padding > max) max = padding;
  }
  return max;
}
function isPointInLocalRect(localX, localY, halfW, halfH) {
  return Math.abs(localX) <= halfW && Math.abs(localY) <= halfH;
}
function overlapsOuterShape(shape, rect, shapeType) {
  const bounds = shape.selrect;
  if (!bounds) return false;
  const padding = getStrokePaddingOuter(shape);
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const w = bounds.width + padding;
  const h = bounds.height + padding;
  const outerX = centerX - w / 2;
  const outerY = centerY - h / 2;
  if (shapeType === "rect") {
    const transform = shape.transform;
    if (transform && !isIdentityTransform(transform)) {
      const clickX = rect.x + rect.width / 2;
      const clickY = rect.y + rect.height / 2;
      const worldRel = point(clickX - centerX, clickY - centerY);
      const transformLinear = { ...transform, e: 0, f: 0 };
      const local = inverseTransformPoint(worldRel, transformLinear);
      const halfW = bounds.width / 2 + padding / 2;
      const halfH = bounds.height / 2 + padding / 2;
      return isPointInLocalRect(local.x, local.y, halfW, halfH);
    }
    const outerRect = makeSelrect(outerX, outerY, w, h);
    const outerPoints = rectToPoints(outerRect);
    if (!outerPoints) return false;
    return overlapsRectPoints(rect, outerPoints);
  }
  if (shapeType === "circle") {
    const synthetic = {
      x: outerX,
      y: outerY,
      width: w,
      height: h,
      selrect: makeSelrect(outerX, outerY, w, h),
      transform: shape.transform
    };
    return overlapsEllipse(synthetic, rect);
  }
  return false;
}
function overlapsInnerShape(shape, rect, shapeType) {
  const bounds = shape.selrect;
  if (!bounds) return false;
  const padding = getStrokePaddingInner(shape);
  const w = bounds.width - padding;
  const h = bounds.height - padding;
  if (w <= 0 || h <= 0) return false;
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const innerX = centerX - w / 2;
  const innerY = centerY - h / 2;
  if (shapeType === "rect") {
    const transform = shape.transform;
    if (transform && !isIdentityTransform(transform)) {
      const clickX = rect.x + rect.width / 2;
      const clickY = rect.y + rect.height / 2;
      const worldRel = point(clickX - centerX, clickY - centerY);
      const transformLinear = { ...transform, e: 0, f: 0 };
      const local = inverseTransformPoint(worldRel, transformLinear);
      const halfW = bounds.width / 2 - padding / 2;
      const halfH = bounds.height / 2 - padding / 2;
      return isPointInLocalRect(local.x, local.y, halfW, halfH);
    }
    const innerRect = makeSelrect(innerX, innerY, w, h);
    const innerPoints = rectToPoints(innerRect);
    if (!innerPoints) return false;
    return overlapsRectPoints(rect, innerPoints);
  }
  if (shapeType === "circle") {
    const synthetic = {
      x: innerX,
      y: innerY,
      width: w,
      height: h,
      selrect: makeSelrect(innerX, innerY, w, h),
      transform: shape.transform
    };
    return overlapsEllipse(synthetic, rect);
  }
  return false;
}
function overlaps(shape, rect, usingSelrect = false) {
  if (!shape) {
    return false;
  }
  const firstStroke = shape.strokes?.[0];
  const strokeWidth = firstStroke?.strokeWidth ?? 0;
  const swidth = strokeWidth / 2;
  const adjustedRect = makeSelrect(
    rect.x - swidth,
    rect.y - swidth,
    rect.width + 2 * swidth,
    rect.height + 2 * swidth
  );
  const svgAttrs = shape.svgAttrs;
  if (!usingSelrect && (!shape.fills || shape.fills.length === 0) && !svgAttrs?.fill && !svgAttrs?.style?.fill) {
    const shapeTypeInner = shape.type;
    if (shapeTypeInner === "rect" || shapeTypeInner === "circle") {
      const centerX = adjustedRect.x + adjustedRect.width / 2;
      const centerY = adjustedRect.y + adjustedRect.height / 2;
      const eps = 1e-6;
      const centerRect = makeSelrect(centerX - eps / 2, centerY - eps / 2, eps, eps);
      return overlapsOuterShape(shape, centerRect, shapeTypeInner) && !overlapsInnerShape(shape, centerRect, shapeTypeInner);
    }
    if (shapeTypeInner === "path" || shapeTypeInner === "bool") {
      return overlapsPath(shape, adjustedRect, false);
    }
  }
  switch (shape.type) {
    case "path":
    case "bool": {
      const points = shape.points || [];
      return overlapsRectPoints(adjustedRect, points) && overlapsPath(shape, adjustedRect, true);
    }
    case "circle":
      return overlapsEllipse(shape, adjustedRect);
    case "text":
      return overlapsText(shape, adjustedRect);
    default: {
      const points = getShapePointsForOverlap(shape);
      return points.length > 0 && overlapsRectPoints(adjustedRect, points);
    }
  }
}
const PADDING_PERCENT = 0.1;
function normalizeSelrect(sr) {
  if (!sr) return null;
  const x = sr.x;
  const y = sr.y;
  const width = sr.width;
  const height = sr.height;
  if (typeof x !== "number" || typeof y !== "number" || width <= 0 || height <= 0) return null;
  return makeSelrect(x, y, width, height);
}
function shapeToBounds(shape) {
  const positionData = "positionData" in shape ? shape.positionData : void 0;
  if (isTextShape(shape) && positionData && Array.isArray(positionData) && positionData.length > 0) {
    return normalizeSelrect(shape.selrect) || null;
  }
  const points = shape.points;
  if (points && points.length > 0) {
    return pointsToRect(points);
  }
  return normalizeSelrect(shape.selrect) || null;
}
function indexShape(objects, parentsIndex, clipIndex, index, shape) {
  const bounds = shapeToBounds(shape);
  if (!bounds) {
    return index;
  }
  const bound = makeSelrect(bounds.x, bounds.y, bounds.width, bounds.height);
  const shapeId = shape.id;
  const frameId = shape.frameId || ZERO_UUID;
  const shapeType = shape.type;
  const parents = parentsIndex[shapeId] || /* @__PURE__ */ new Set();
  const clipParents = clipIndex[shapeId] || [];
  let frame;
  if (shapeType !== "frame" && frameId !== ZERO_UUID) {
    frame = objects[frameId];
  }
  const shapeData = {
    ...shape,
    frame,
    clipParents,
    parents: Array.from(parents)
  };
  return insert(index, shapeId, bound, shapeData);
}
function objectsBounds(objects) {
  const shapes = Object.values(objects).filter((obj) => obj.id !== ZERO_UUID);
  return shapesToRect(shapes);
}
function addPaddingBounds(bounds) {
  const widthPad = bounds.width * PADDING_PERCENT;
  const heightPad = bounds.height * PADDING_PERCENT;
  return makeSelrect(
    bounds.x - widthPad,
    bounds.y - heightPad,
    bounds.width + 2 * widthPad,
    bounds.height + 2 * heightPad
  );
}
function createIndex(objects) {
  const parentsIndex = generateChildAllParentsIndex(objects);
  const clipIndex = createClipIndex(objects, parentsIndex);
  const rootShapes = getImmediateChildren(objects, ZERO_UUID);
  const contentBounds = objectsBounds(objects);
  const rootBounds = shapesToRect(rootShapes);
  const bounds = contentBounds ?? rootBounds;
  if (!bounds) {
    const defaultBounds = makeRect(0, 0, 1e4, 1e4);
    const index2 = create(defaultBounds);
    return {
      index: index2,
      bounds: defaultBounds,
      parentsIndex,
      clipIndex
    };
  }
  const paddedBounds = addPaddingBounds(bounds);
  let index = create(paddedBounds);
  for (const [id, shape] of Object.entries(objects)) {
    if (id !== ZERO_UUID) {
      index = indexShape(objects, parentsIndex, clipIndex, index, shape);
    }
  }
  return {
    index,
    bounds: paddedBounds,
    parentsIndex,
    clipIndex
  };
}
function updateIndex(data, oldObjects, newObjects) {
  function objectChanged(id) {
    return oldObjects[id] !== newObjects[id];
  }
  const allIds = /* @__PURE__ */ new Set([
    ...Object.keys(oldObjects),
    ...Object.keys(newObjects)
  ]);
  const changedIds = /* @__PURE__ */ new Set();
  for (const id of allIds) {
    if (id !== ZERO_UUID && objectChanged(id)) {
      changedIds.add(id);
      const children = getChildrenIds(newObjects, id);
      for (const childId of children) {
        changedIds.add(childId);
      }
    }
  }
  const shapes = [];
  for (const id of changedIds) {
    const shape = newObjects[id];
    if (shape) {
      shapes.push(shape);
    }
  }
  const partialParentsIndex = generateChildAllParentsIndex(newObjects, shapes);
  const partialClipIndex = createClipIndex(newObjects, partialParentsIndex);
  const parentsIndex = {};
  for (const [id, set] of Object.entries(data.parentsIndex)) {
    if (id in newObjects) parentsIndex[id] = set;
  }
  for (const [id, set] of Object.entries(partialParentsIndex)) {
    parentsIndex[id] = set;
  }
  const clipIndex = {};
  for (const [id, arr] of Object.entries(data.clipIndex)) {
    if (id in newObjects) clipIndex[id] = arr;
  }
  for (const [id, arr] of Object.entries(partialClipIndex)) {
    clipIndex[id] = arr;
  }
  let index = removeAll(data.index, changedIds);
  for (const shape of shapes) {
    index = indexShape(newObjects, parentsIndex, clipIndex, index, shape);
  }
  return {
    ...data,
    index,
    parentsIndex,
    clipIndex
  };
}
function updateIndexSingle(data, objects, shape) {
  const { index, parentsIndex, clipIndex } = data;
  let newIndex = removeAll(index, /* @__PURE__ */ new Set([shape.id]));
  newIndex = indexShape(objects, parentsIndex, clipIndex, newIndex, shape);
  return {
    ...data,
    index: newIndex
  };
}
function queryIndex(indexData, rect, frameId, fullFrame, includeFrames, ignoreGroups, clipChildren, usingSelrect) {
  const { index } = indexData;
  const result = /* @__PURE__ */ new Set();
  for (const node of search(index, rect)) {
    const shape = node.data;
    if (!shape) {
      continue;
    }
    if (shape.hidden) {
      continue;
    }
    if (isIndexedShape(shape) && !isFrameShape(shape) && shape.blocked) {
      continue;
    }
    if (frameId && shape.frameId !== frameId) {
      continue;
    }
    const shapeType = shape.type;
    if (shapeType === "frame" && !includeFrames) {
      continue;
    }
    if ((shapeType === "bool" || shapeType === "group") && ignoreGroups) {
      continue;
    }
    if (fullFrame) {
      if (!ignoreGroups && shape.componentId) ;
      else if (!ignoreGroups && !isRootFrame(shape)) ;
      else if ("shapes" in shape && shape.shapes && shape.shapes.length > 0) {
        if (!rectContainsShape(rect, shape)) {
          continue;
        }
      } else {
        if (!overlaps(shape, rect, usingSelrect)) {
          continue;
        }
      }
    }
    if (!overlaps(shape, rect, usingSelrect)) {
      continue;
    }
    if (clipChildren) {
      const clipParents = "clipParents" in shape && Array.isArray(shape.clipParents) ? shape.clipParents : [];
      let shouldInclude = true;
      for (const clipParent of clipParents) {
        if (!overlaps(clipParent, rect, usingSelrect)) {
          shouldInclude = false;
          break;
        }
      }
      if (!shouldInclude) {
        continue;
      }
    }
    result.add(shape.id);
  }
  return result;
}
function addPage(state2, page) {
  const index = createIndex(page.objects);
  return {
    ...state2,
    [page.id]: index
  };
}
function updatePage(state2, oldPage, newPage) {
  const pageId = oldPage.id;
  const existingIndex = state2[pageId];
  const oldObjects = oldPage.objects;
  const newObjects = newPage.objects;
  const oldBounds = existingIndex?.bounds;
  const newBounds = objectsBounds(newObjects);
  let newIndex;
  if (existingIndex && oldBounds && newBounds && containsRect(oldBounds, newBounds)) {
    newIndex = updateIndex(existingIndex, oldObjects, newObjects);
  } else {
    newIndex = createIndex(newObjects);
  }
  return {
    ...state2,
    [pageId]: newIndex
  };
}
function query(indexState, params) {
  const { pageId, rect, frameId, fullFrame, includeFrames, ignoreGroups, clipChildren, usingSelrect } = params;
  const index = indexState[pageId];
  if (!index) {
    return /* @__PURE__ */ new Set();
  }
  return queryIndex(
    index,
    rect,
    frameId,
    fullFrame ?? false,
    includeFrames ?? false,
    ignoreGroups ?? false,
    clipChildren ?? true,
    usingSelrect ?? false
  );
}
const state = {
  pagesIndex: {},
  selection: {},
  textRect: {}
};
function identityTransform() {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}
function transformPoint(pt, transform) {
  const { a, b, c, d, e, f } = transform;
  return point(a * pt.x + c * pt.y + e, b * pt.x + d * pt.y + f);
}
registerHandler("index/clear", () => {
  state.pagesIndex = {};
  state.selection = {};
  state.textRect = {};
  return null;
});
registerHandler("index/initialize", (message) => {
  console.log("index/initialize", message);
  const indexed = message.payload?.page;
  if (!indexed) {
    return null;
  }
  const startTime = performance.now();
  try {
    state.pagesIndex[indexed.id] = indexed;
    state.selection = addPage(state.selection, indexed);
    const elapsed = performance.now() - startTime;
    console.debug(`Page indexed: ${indexed.id}, elapsed: ${elapsed}ms`);
    return null;
  } catch (error) {
    console.error("Error initializing page index:", error);
    return null;
  }
});
registerHandler("index/update", (message) => {
  const payload = message.payload;
  const pageId = payload?.pageId;
  const changes = payload?.changes;
  const newPage = payload?.page;
  if (!pageId) {
    return null;
  }
  const startTime = performance.now();
  try {
    const oldPage = state.pagesIndex[pageId];
    if (!oldPage) {
      return null;
    }
    let indexedNew;
    if (changes && changes.length > 0) {
      indexedNew = processChanges(oldPage, changes);
      state.pagesIndex[pageId] = indexedNew;
      state.selection = updatePage(state.selection, oldPage, indexedNew);
    } else if (newPage) {
      indexedNew = newPage;
      state.pagesIndex[pageId] = indexedNew;
      state.selection = updatePage(state.selection, oldPage, indexedNew);
    } else {
      return null;
    }
    const elapsed = performance.now() - startTime;
    console.debug(`Page index updated: ${pageId}, elapsed: ${elapsed}ms`);
    return null;
  } catch (error) {
    console.error("Error updating page index:", error);
    return null;
  }
});
registerHandler("index/query-selection", (message) => {
  const params = message.payload;
  if (!params) {
    return [];
  }
  try {
    const result = query(state.selection, params);
    return Array.from(result);
  } catch (error) {
    console.error("Error querying selection:", error);
    return [];
  }
});
registerHandler("index/update-text-rect", (message) => {
  const payload = message.payload;
  const { pageId, shapeId, dimensions } = payload ?? {};
  if (!pageId || !shapeId || !dimensions) {
    return null;
  }
  try {
    const page = state.pagesIndex[pageId];
    if (!page) {
      return null;
    }
    const objects = page.objects;
    const shape = objects[shapeId];
    if (!shape) {
      return null;
    }
    const center = shapeToCenter(shape);
    if (!center) {
      return null;
    }
    const transform = shape.transform || identityTransform();
    const rect = makeRect(
      dimensions.x ?? 0,
      dimensions.y ?? 0,
      dimensions.width ?? 0,
      dimensions.height ?? 0
    );
    const rectPoints = rectToPoints(rect);
    if (!rectPoints) {
      return null;
    }
    const points = rectPoints.map((pt) => {
      const transformed = transformPoint(pt, transform);
      return point(transformed.x + center.x, transformed.y + center.y);
    });
    const selrect = pointsToRect(points);
    if (!selrect) {
      return null;
    }
    const updatedShape = {
      ...shape,
      positionData: void 0,
      points,
      selrect
    };
    const updatedObjects = {
      ...objects,
      [shapeId]: updatedShape
    };
    const updatedPage = {
      ...page,
      objects: updatedObjects
    };
    state.pagesIndex[pageId] = updatedPage;
    if (!state.textRect) {
      state.textRect = {};
    }
    if (!state.textRect[pageId]) {
      state.textRect[pageId] = {};
    }
    state.textRect[pageId][shapeId] = {
      positionData: void 0,
      points,
      selrect
    };
    const pageSelection = state.selection[pageId];
    if (pageSelection) {
      state.selection[pageId] = updateIndexSingle(pageSelection, updatedObjects, updatedShape);
    }
    return null;
  } catch (error) {
    console.error("Error updating text rect:", error);
    return null;
  }
});
self.addEventListener("message", (event) => {
  console.log("Worker message received:", event.data);
  const raw = event.data;
  const replyTo = raw?.replyTo;
  try {
    const message = decode(raw);
    const result = handler(message);
    if (replyTo) {
      const response = encode({
        cmd: message.cmd,
        replyTo,
        payload: result ?? null
      });
      self.postMessage(response);
    }
  } catch (error) {
    console.error("Error handling worker message:", error);
    self.postMessage({
      cmd: "error",
      replyTo: replyTo ?? null,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});
//# sourceMappingURL=worker.js.map
