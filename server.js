'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const G = require('./game');

const PORT = process.env.PORT || 3000;
const COUNTDOWN_MS = 60 * 1000; // 最初の宣言から
const EXEC_MS = 90 * 1000; // 1人の手番の持ち時間
const ROUND_END_MS = 6 * 1000;
// 成功後にロボットを元の位置へ戻すか。false=成功時の位置のまま次ラウンドへ(失敗時は常に手番開始前に戻す)
const RESET_ON_SUCCESS = false;
const MAX_PLAYERS = 12;

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') return res.end('ok');
  fs.readFile(path.join(__dirname, 'public', 'index.html'), (e, d) => {
    if (e) {
      res.statusCode = 500;
      return res.end('error');
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(d);
  });
});
const wss = new WebSocketServer({ server });

const rooms = new Map();
const clone = (o) => JSON.parse(JSON.stringify(o));
const uid = () => crypto.randomBytes(6).toString('hex');

function newRoom(code) {
  return {
    code, players: [], hostId: null, phase: 'lobby', board: null, startRobots: null, robots: null,
    deck: [], goal: null, directOne: false, decls: new Map(), bestN: null, queue: [], active: null,
    limit: 0, movesUsed: 0, history: [], deadline: 0, msg: '', round: 0, winScore: 0, roundResult: null, timer: null, gcTimer: null, skipVotes: new Set(), optimal: null, lastOpt: 0,
  };
}

function snapshot(room, p) {
  const decls = [...room.decls.entries()].map(([id, d]) => ({ id, n: d.n })).sort((a, b) => a.n - b.n);
  return {
    t: 'state', serverNow: Date.now(), room: room.code, phase: room.phase, hostId: room.hostId, you: p.id,
    players: room.players.map((q) => ({ id: q.id, name: q.name, score: q.score, connected: q.connected })),
    board: room.board, robots: room.robots, goal: room.goal, directOne: room.directOne,
    minDecl: room.directOne ? 2 : 1, bestN: room.bestN, chipsLeft: room.deck.length, winScore: room.winScore,
    decls, queue: room.queue, active: room.active, limit: room.limit, movesUsed: room.movesUsed,
    deadline: room.deadline, skipVotes: [...room.skipVotes], msg: room.msg, round: room.round, roundResult: room.roundResult,
  };
}

function broadcast(room) {
  for (const p of room.players) if (p.connected && p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(snapshot(room, p)));
}
const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
const nameOf = (room, id) => (room.players.find((p) => p.id === id) || {}).name || '?';
function setTimer(room, ms, fn) {
  clearTimeout(room.timer);
  room.timer = setTimeout(() => { fn(); broadcast(room); }, ms);
}

function startGame(room) {
  const n = room.players.length;
  room.winScore = n === 1 ? 8 : n === 2 ? 8 : n === 3 ? 6 : n === 4 ? 5 : Infinity;
  const { board, robots } = G.generateGame();
  room.board = board;
  room.startRobots = clone(robots);
  room.robots = clone(robots);
  room.deck = G.shuffle(board.targets.map((_, i) => i));
  room.players.forEach((p) => (p.score = 0));
  room.round = 0;
  startRound(room);
}

// 残りチップの最短手数を調べ、最短6手以上のものからランダムに出す
function pickGoal(room) {
  const info = room.deck.map((idx, pos) => {
    const t = room.board.targets[idx];
    const blocked = G.COLORS.some((c) => room.robots[c][0] === t.r && room.robots[c][1] === t.c && (t.color === 'wild' || t.color === c));
    return { pos, t, blocked, L: blocked ? -1 : G.solveLen(room.board, room.robots, t, 11, 400) };
  });
  const ok = info.filter((x) => !x.blocked && x.L > 0);
  // 最短5手以下は除外し、6手以上(確認できたもの)からランダム。見つからなければ一番長いものを使う
  const hard = ok.filter((x) => x.L >= 6);
  let pick;
  if (hard.length) pick = hard;
  else if (ok.length) pick = ok.filter((x) => x.L === Math.max(...ok.map((y) => y.L)));
  else pick = info.filter((x) => !x.blocked).length ? info.filter((x) => !x.blocked) : info;
  const c = pick[Math.floor(Math.random() * pick.length)];
  room.deck.splice(c.pos, 1);
  room.goal = c.t;
  room.optimal = c.L > 0 ? c.L : null;
  if (c.L > 0) room.lastOpt = c.L;
}

function startRound(room) {
  room.round++;
  room.robots = clone(room.startRobots);
  pickGoal(room);
  room.directOne = G.directOne(room.board, room.robots, room.goal);
  room.decls = new Map();
  room.bestN = null;
  room.queue = [];
  room.active = null;
  room.limit = 0;
  room.movesUsed = 0;
  room.deadline = 0;
  room.roundResult = null;
  room.skipVotes = new Set();
  room.phase = 'thinking';
  room.msg = `ラウンド${room.round}: 目標が公開されました`;
  clearTimeout(room.timer);
}

function declare(room, p, n) {
  if (room.phase !== 'thinking' && room.phase !== 'countdown') return 'いまは宣言できません';
  if (!Number.isInteger(n) || n < 1 || n > 99) return '手数が不正です';
  const min = room.directOne ? 2 : 1;
  if (n < min) return '1手で直接ゴールできるので、別の経路(2手以上)を探してください';
  if (room.bestN !== null && n >= room.bestN) return `${room.bestN}手より小さい手数のみ宣言できます`;
  room.decls.set(p.id, { n, t: Date.now() });
  room.bestN = n;
  room.skipVotes = new Set();
  room.msg = `${p.name}さんが ${n}手 を宣言!`;
  if (room.phase === 'thinking') {
    room.phase = 'countdown';
    room.deadline = Date.now() + COUNTDOWN_MS;
    setTimer(room, COUNTDOWN_MS, () => beginExecution(room));
  }
  return null;
}

function beginExecution(room) {
  room.queue = [...room.decls.entries()].sort((a, b) => a[1].n - b[1].n).map(([id]) => id);
  room.msg = 'タイマー終了!';
  startTurn(room);
}

function startTurn(room) {
  room.active = room.queue[0];
  room.limit = room.decls.get(room.active).n;
  room.movesUsed = 0;
  room.history = [];
  room.robots = clone(room.startRobots);
  room.phase = 'executing';
  room.deadline = Date.now() + EXEC_MS;
  room.msg = `${nameOf(room, room.active)}さんの番 (${room.limit}手以内)`;
  setTimer(room, EXEC_MS, () => failTurn(room, '時間切れ'));
}

function failTurn(room, why) {
  const who = nameOf(room, room.active);
  room.robots = clone(room.startRobots);
  room.queue.shift();
  if (room.queue.length) {
    startTurn(room);
    room.msg = `${who}さん失敗(${why}) → ${room.msg}`;
  } else {
    endRound(room, null, `${who}さん失敗(${why})。成功者なし`);
  }
}

function endRound(room, winner, msg) {
  clearTimeout(room.timer);
  room.phase = 'roundEnd';
  room.active = null;
  room.deadline = Date.now() + ROUND_END_MS;
  const optTxt = room.optimal ? ` (最短は${room.optimal}手でした)` : '';
  if (winner) {
    winner.score++;
    if (!RESET_ON_SUCCESS) room.startRobots = clone(room.robots);
    room.roundResult = { winnerId: winner.id, moves: room.movesUsed };
    room.msg = (msg || `${winner.name}さんがチップ獲得!`) + optTxt;
  } else {
    room.roundResult = { winnerId: null };
    room.msg = (msg || '成功者なし') + optTxt;
  }
  setTimer(room, ROUND_END_MS, () => nextRound(room));
}

function nextRound(room) {
  const reached = room.players.some((p) => p.score >= room.winScore);
  if (reached || room.deck.length === 0) {
    room.phase = 'gameEnd';
    room.deadline = 0;
    clearTimeout(room.timer);
    room.robots = clone(room.startRobots);
    const max = Math.max(...room.players.map((p) => p.score));
    const ws = room.players.filter((p) => p.score === max).map((p) => p.name);
    room.msg = `ゲーム終了! 優勝: ${ws.join('、')} (${max}枚)`;
    return;
  }
  if (RESET_ON_SUCCESS) room.robots = clone(room.startRobots);
  startRound(room);
}

function handleMove(room, p, robot, dir) {
  if (room.phase !== 'executing' || room.active !== p.id) return '手番ではありません';
  if (!G.COLORS.includes(robot) || !(dir >= 0 && dir <= 3)) return '不正な操作';
  const [r0, c0] = room.robots[robot];
  const [r, c] = G.slide(room.board.walls, G.occupiedSet(room.robots, robot), r0, c0, dir);
  if (r === r0 && c === c0) return 'その方向には動けません';
  room.history.push({ robot, from: [r0, c0] });
  room.robots[robot] = [r, c];
  room.movesUsed++;
  const g = room.goal;
  const onGoal = r === g.r && c === g.c && (g.color === 'wild' || g.color === robot);
  if (onGoal && !(room.directOne && room.movesUsed < 2)) {
    endRound(room, p, `${p.name}さんが ${room.movesUsed}手 で成功! チップ獲得`);
  } else if (room.movesUsed >= room.limit) {
    failTurn(room, '宣言手数オーバー');
  }
  return null;
}

function sweepRoom(room) {
  clearTimeout(room.gcTimer);
  if (room.players.every((p) => !p.connected)) {
    room.gcTimer = setTimeout(() => {
      if (room.players.every((p) => !p.connected)) {
        clearTimeout(room.timer);
        rooms.delete(room.code);
      }
    }, 10 * 60 * 1000);
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  let room = null;
  let me = null;

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'join') {
      const code = String(m.room || '').normalize('NFKC').trim().toLowerCase().slice(0, 30);
      const name = String(m.name || '').trim().slice(0, 12);
      if (!code || !name) return send(ws, { t: 'error', msg: '名前と合言葉を入力してください' });
      let rm = rooms.get(code);
      if (!rm) { rm = newRoom(code); rooms.set(code, rm); }
      let p = m.token ? rm.players.find((q) => q.token === m.token) : null;
      if (p) {
        if (p.ws && p.ws !== ws) try { p.ws.close(); } catch {}
        p.name = name;
      } else {
        if (rm.players.length >= MAX_PLAYERS) return send(ws, { t: 'error', msg: '満席です' });
        if (rm.players.some((q) => q.name === name && q.connected)) return send(ws, { t: 'error', msg: 'その名前は使われています' });
        p = { id: uid(), token: uid() + uid(), name, score: 0, connected: true, ws };
        rm.players.push(p);
        if (!rm.hostId) rm.hostId = p.id;
      }
      p.ws = ws; p.connected = true;
      room = rm; me = p;
      clearTimeout(rm.gcTimer);
      send(ws, { t: 'joined', token: p.token });
      return broadcast(rm);
    }
    if (!room || !me) return;
    let err = null;
    switch (m.t) {
      case 'start':
        if (me.id !== room.hostId) err = 'ホストのみ開始できます';
        else if (room.phase !== 'lobby' && room.phase !== 'gameEnd') err = 'すでに開始しています';
        else startGame(room);
        break;
      case 'declare': err = declare(room, me, Number(m.n)); break;
      case 'move': err = handleMove(room, me, m.robot, Number(m.dir)); break;
      case 'skiptimer':
        if (room.phase === 'countdown') {
          if (room.skipVotes.has(me.id)) room.skipVotes.delete(me.id); else room.skipVotes.add(me.id);
          const need = room.players.filter((p) => p.connected);
          if (need.length && need.every((p) => room.skipVotes.has(p.id))) { clearTimeout(room.timer); beginExecution(room); }
        }
        break;
      case 'undo':
        if (room.phase === 'executing' && room.active === me.id) {
          const h = room.history.pop();
          if (h) { room.robots[h.robot] = h.from; room.movesUsed--; } else err = 'これ以上戻せません';
        }
        break;
      case 'restart':
        if (room.phase === 'executing' && room.active === me.id) {
          room.robots = clone(room.startRobots); room.history = []; room.movesUsed = 0;
        }
        break;
      case 'giveup':
        if (room.phase === 'executing' && room.active === me.id) failTurn(room, 'ギブアップ');
        break;
      case 'skip':
        if (me.id !== room.hostId) err = 'ホストのみスキップできます';
        else if (room.phase === 'thinking' || room.phase === 'countdown') endRound(room, null, 'このチップはスキップされました');
        break;
      case 'lobby':
        if (me.id === room.hostId && room.phase !== 'lobby') {
          clearTimeout(room.timer);
          room.phase = 'lobby'; room.board = null; room.robots = null; room.goal = null;
          room.decls = new Map(); room.queue = []; room.active = null; room.bestN = null; room.deadline = 0; room.roundResult = null; room.skipVotes = new Set(); room.round = 0;
          room.players.forEach((p) => (p.score = 0));
          room.msg = '';
          room.players = room.players.filter((p) => p.connected);
          if (!room.players.some((p) => p.id === room.hostId)) room.hostId = room.players[0] ? room.players[0].id : null;
        }
        break;
    }
    if (err) send(ws, { t: 'error', msg: err });
    broadcast(room);
  });

  ws.on('close', () => {
    if (!room || !me || me.ws !== ws) return;
    me.connected = false;
    if (room.phase === 'lobby') {
      room.players = room.players.filter((p) => p !== me);
      if (room.hostId === me.id) room.hostId = room.players.length ? room.players[0].id : null;
    } else if (room.hostId === me.id) {
      const next = room.players.find((p) => p.connected);
      if (next) room.hostId = next.id;
    }
    broadcast(room);
    sweepRoom(room);
  });
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

server.listen(PORT, () => console.log('Hyper Robot server on :' + PORT));
