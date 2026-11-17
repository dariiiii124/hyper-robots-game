'use strict';
// ハイパーロボット ゲームロジック
const N = 16;
// 方向: 0=上 1=右 2=下 3=左  (壁ビット: N=1 E=2 S=4 W=8)
const DIRS = [
  { dr: -1, dc: 0, bit: 1 },
  { dr: 0, dc: 1, bit: 2 },
  { dr: 1, dc: 0, bit: 4 },
  { dr: 0, dc: -1, bit: 8 },
];
const COLORS = ['red', 'green', 'blue', 'yellow'];
const SHAPES = ['circle', 'square', 'triangle', 'star'];

const isCenter = (r, c) => (r === 7 || r === 8) && (c === 7 || c === 8);
const rnd = (n) => Math.floor(Math.random() * n);
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 8x8 の 1/4 盤面を生成 (中央の角が (7,7) になる向き = 左上象限)
function genQuadrant(nL) {
  const w = Array.from({ length: 8 }, () => Array(8).fill(0));
  const add = (r, c, d) => {
    w[r][c] |= DIRS[d].bit;
    const nr = r + DIRS[d].dr, nc = c + DIRS[d].dc;
    if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) w[nr][nc] |= DIRS[(d + 2) % 4].bit;
  };
  const Ls = [];
  let tries = 0;
  while (Ls.length < nL && tries++ < 1000) {
    const r = 1 + rnd(6), c = 1 + rnd(6);
    if (Math.max(Math.abs(r - 7), Math.abs(c - 7)) < 2) continue;
    if (Ls.some((l) => Math.max(Math.abs(l.r - r), Math.abs(l.c - c)) < 2)) continue;
    const o = rnd(4);
    add(r, c, o);
    add(r, c, (o + 1) % 4);
    Ls.push({ r, c });
  }
  if (Ls.length < nL) return null;
  // 外周(上辺・左辺)に出っ張りの壁
  add(0, 1 + rnd(5), 1);
  add(1 + rnd(5), 0, 2);
  // 追加の単独壁
  const extra = 2 + rnd(2);
  let placed = 0;
  tries = 0;
  while (placed < extra && tries++ < 300) {
    const r = 1 + rnd(6), c = 1 + rnd(6), d = rnd(4);
    if (Ls.some((l) => Math.max(Math.abs(l.r - r), Math.abs(l.c - c)) < 1)) continue;
    const nr = r + DIRS[d].dr, nc = c + DIRS[d].dc;
    if (nr < 0 || nr > 6 || nc < 0 || nc > 6) continue;
    if (w[r][c] || w[nr][nc]) continue;
    if (Ls.some((l) => l.r === nr && l.c === nc)) continue;
    add(r, c, d);
    placed++;
  }
  return { w, Ls };
}

// 時計回りに90度回転
function rotQuadrant(q) {
  const w = Array.from({ length: 8 }, () => Array(8).fill(0));
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++) {
      const m = q.w[r][c];
      w[c][7 - r] = ((m << 1) | (m >> 3)) & 15;
    }
  const Ls = q.Ls.map((l) => ({ r: l.c, c: 7 - l.r }));
  return { w, Ls };
}

function slide(walls, occ, r, c, d) {
  const { dr, dc, bit } = DIRS[d];
  for (;;) {
    if (walls[r * N + c] & bit) break;
    const nr = r + dr, nc = c + dc;
    if (nr < 0 || nr >= N || nc < 0 || nc >= N) break;
    if (isCenter(nr, nc)) break;
    if (occ && occ.has(nr * N + nc)) break;
    r = nr;
    c = nc;
  }
  return [r, c];
}

// 空盤面で start から止まれるマスの集合
function reach(walls, sr, sc) {
  const seen = new Set([sr * N + sc]);
  const q = [[sr, sc]];
  while (q.length) {
    const [r, c] = q.pop();
    for (let d = 0; d < 4; d++) {
      const [nr, nc] = slide(walls, null, r, c, d);
      const k = nr * N + nc;
      if (!seen.has(k)) {
        seen.add(k);
        q.push([nr, nc]);
      }
    }
  }
  return seen;
}

function buildBoard() {
  const wildQ = rnd(4);
  const walls = new Array(N * N).fill(0);
  const targets = [];
  for (let qi = 0; qi < 4; qi++) {
    let q = null;
    while (!q) q = genQuadrant(qi === wildQ ? 5 : 4);
    for (let k = 0; k < qi; k++) q = rotQuadrant(q);
    const r0 = qi === 0 || qi === 1 ? 0 : 8;
    const c0 = qi === 0 || qi === 3 ? 0 : 8;
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 8; c++) walls[(r0 + r) * N + (c0 + c)] = q.w[r][c];
    const items = shuffle(COLORS.map((color, i) => ({ color, shape: SHAPES[(i + qi) % 4] })));
    const Ls = shuffle(q.Ls.slice());
    Ls.forEach((l, i) => {
      const it = items[i] || { color: 'wild', shape: 'wild' };
      targets.push({ r: r0 + l.r, c: c0 + l.c, color: it.color, shape: it.shape });
    });
  }
  return { walls, targets };
}

// どの出発点からでも (ほぼ) 全ての目標に到達できる盤面のみ採用
function boardOk(b) {
  const cnt = new Map();
  let total = 0;
  for (let r = 0; r < N; r++)
    for (let c = 0; c < N; c++) {
      if (isCenter(r, c)) continue;
      total++;
      for (const k of reach(b.walls, r, c)) cnt.set(k, (cnt.get(k) || 0) + 1);
    }
  return b.targets.every((t) => (cnt.get(t.r * N + t.c) || 0) >= total * 0.9);
}

function generateBoard() {
  for (let i = 0; i < 500; i++) {
    const b = buildBoard();
    if (boardOk(b)) return b;
  }
  return buildBoard();
}

function placeRobots(board) {
  const tset = new Set(board.targets.map((t) => t.r * N + t.c));
  for (let attempt = 0; attempt < 200; attempt++) {
    const used = new Set();
    const robots = {};
    for (const col of COLORS) {
      for (;;) {
        const r = rnd(N), c = rnd(N);
        const k = r * N + c;
        if (isCenter(r, c) || tset.has(k) || used.has(k)) continue;
        used.add(k);
        robots[col] = [r, c];
        break;
      }
    }
    const reaches = {};
    for (const col of COLORS) reaches[col] = reach(board.walls, robots[col][0], robots[col][1]);
    const ok = board.targets.every((t) => {
      const k = t.r * N + t.c;
      return t.color === 'wild' ? COLORS.some((c) => reaches[c].has(k)) : reaches[t.color].has(k);
    });
    if (ok) return robots;
  }
  return null;
}

function generateGame() {
  for (;;) {
    const board = generateBoard();
    const robots = placeRobots(board);
    if (robots) return { board, robots };
  }
}

function occupiedSet(robots, exceptColor) {
  const s = new Set();
  for (const col of COLORS) if (col !== exceptColor) s.add(robots[col][0] * N + robots[col][1]);
  return s;
}

// 目標へ1手で直接行ける?
function directOne(board, robots, goal) {
  const cols = goal.color === 'wild' ? COLORS : [goal.color];
  for (const col of cols)
    for (let d = 0; d < 4; d++) {
      const [r, c] = slide(board.walls, occupiedSet(robots, col), robots[col][0], robots[col][1], d);
      if (r === goal.r && c === goal.c) return true;
    }
  return false;
}

// 最短手数(全ロボット操作可)をBFSで求める。maxD手以内に無い/時間切れは -1
function solveLen(board, robots, goal, maxD, ms) {
  const t0 = Date.now();
  const gi = goal.r * N + goal.c;
  const gc = goal.color === 'wild' ? -1 : COLORS.indexOf(goal.color);
  const d1 = directOne(board, robots, goal);
  const enc = (p) => ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
  const start = COLORS.map((c) => robots[c][0] * N + robots[c][1]);
  let fr = [start];
  const seen = new Set([enc(start)]);
  const occ = new Set();
  for (let d = 1; d <= maxD; d++) {
    const nx = [];
    for (const s of fr) {
      for (let i = 0; i < 4; i++) {
        occ.clear();
        for (let j = 0; j < 4; j++) if (j !== i) occ.add(s[j]);
        for (let dir = 0; dir < 4; dir++) {
          const [r, c] = slide(board.walls, occ, s[i] >> 4, s[i] & 15, dir);
          const k = r * N + c;
          if (k === s[i]) continue;
          if (k === gi && (gc < 0 || gc === i) && !(d1 && d < 2)) return d;
          const n = s.slice();
          n[i] = k;
          const e = enc(n);
          if (!seen.has(e)) { seen.add(e); nx.push(n); }
        }
      }
      if (Date.now() - t0 > ms) return -1;
    }
    fr = nx;
  }
  return -1;
}

module.exports = { solveLen, N, DIRS, COLORS, SHAPES, isCenter, shuffle, slide, reach, generateBoard, placeRobots, generateGame, occupiedSet, directOne };
