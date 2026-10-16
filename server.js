// Mafia party game server: Express serves the page, Socket.IO runs the lobbies and game.
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const MIN_PLAYERS = 3;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I
const ROLE_NAMES = { mafia: 'Mafia', medic: 'Medic', detective: 'Detective', villager: 'Villager' };

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

const lobbies = new Map();  // code -> lobby
const tokenIndex = new Map(); // private token -> lobby code (for rejoining)

// ---------- helpers ----------
function newCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  } while (lobbies.has(code));
  return code;
}
const newToken = () => crypto.randomBytes(16).toString('hex');
const newId = () => crypto.randomBytes(3).toString('hex');

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
function cleanName(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').slice(0, 16);
}
const alivePlayers = (l) => [...l.players.values()].filter((p) => p.alive);
const findById = (l, id) => [...l.players.values()].find((p) => p.id === id);
const NIGHT_ROLES = ['mafia', 'medic', 'detective'];

function log(l, text, kind = 'info') {
  l.log.push({ text, kind });
  if (l.log.length > 80) l.log.shift();
}

function broadcast(l) {
  for (const p of l.players.values()) {
    if (p.connected) io.to(p.socketId).emit('state', viewFor(l, p.token));
  }
}

function addPlayer(l, token, name, socket) {
  l.players.set(token, {
    token, id: newId(), name, socketId: socket.id, connected: true,
    role: null, alive: true, selfSaves: 1, checks: [],
  });
  tokenIndex.set(token, l.code);
  socket.data.token = token;
  socket.data.code = l.code;
}

// Returns { l, p } for the socket's player, or null.
function ctx(socket) {
  const l = lobbies.get(socket.data.code);
  if (!l) return null;
  const p = l.players.get(socket.data.token);
  return p ? { l, p } : null;
}

// ---------- game flow ----------
function assignRoles(l) {
  const players = shuffle([...l.players.values()]);
  const n = players.length;
  const mafiaCount = Math.min(l.settings.mafia, Math.max(1, n - 2));
  const roles = Array(mafiaCount).fill('mafia');
  if (l.settings.medic && roles.length < n) roles.push('medic');
  if (l.settings.detective && roles.length < n) roles.push('detective');
  while (roles.length < n) roles.push('villager');
  players.forEach((p, i) => {
    p.role = roles[i];
    p.alive = true;
    p.selfSaves = 1;
    p.checks = [];
  });
}

function startNight(l) {
  l.phase = 'night';
  l.dayVotes = new Map();
  l.night = { kills: new Map(), saves: [], done: new Set() };
  log(l, l.round === 1 ? 'Night falls. The first night has begun.' : `Night ${l.round} falls over the town.`, 'night');
  broadcast(l);
}

function nightPending(l) {
  return alivePlayers(l).filter((p) => NIGHT_ROLES.includes(p.role) && !l.night.done.has(p.token));
}

function resolveNight(l) {
  // Mafia: plurality of their picks, ties broken at random.
  const tally = new Map();
  for (const id of l.night.kills.values()) tally.set(id, (tally.get(id) || 0) + 1);
  let best = 0;
  let top = [];
  for (const [id, c] of tally) {
    if (c > best) { best = c; top = [id]; } else if (c === best) top.push(id);
  }
  const victim = top.length ? findById(l, top[crypto.randomInt(top.length)]) : null;
  const saved = l.night.saves.filter(Boolean).pop(); // medic's pick (id) or undefined

  if (victim && victim.id === saved) {
    log(l, 'Someone was attacked in the night, but a Medic saved them.', 'save');
  } else if (victim) {
    victim.alive = false;
    log(l, `${victim.name} was found dead at dawn.`, 'death');
  } else {
    log(l, 'The night passed quietly. Nobody died.', 'day');
  }

  if (checkWin(l)) return;
  startDay(l);
}

function startDay(l) {
  l.phase = 'day';
  l.dayVotes = new Map();
  log(l, 'Day time has started. Talk it out, then vote someone out.', 'day');
  broadcast(l);
}

function resolveDay(l) {
  l.phase = 'results';
  const tally = new Map();
  for (const id of l.dayVotes.values()) tally.set(id, (tally.get(id) || 0) + 1);
  let best = 0;
  let top = [];
  for (const [id, c] of tally) {
    if (c > best) { best = c; top = [id]; } else if (c === best) top.push(id);
  }

  if (top.length !== 1) {
    log(l, 'The vote ended in a tie. Nobody was voted out.', 'day');
  } else {
    const victim = findById(l, top[0]);
    victim.alive = false;
    log(l, `${victim.name} was voted out. They were ${ROLE_NAMES[victim.role]}.`, 'death');
    if (victim.role === 'mafia') {
      endGame(l, 'villagers', 'A Mafia member was voted out. The villagers win!');
      return;
    }
  }

  if (checkWin(l)) return;
  broadcast(l);
  l.timer = setTimeout(() => {
    l.timer = null;
    if (l.phase !== 'results') return;
    l.round += 1;
    startNight(l);
  }, 5000);
}

function checkWin(l) {
  const alive = alivePlayers(l);
  const mafiaAlive = alive.filter((p) => p.role === 'mafia').length;
  if (mafiaAlive === 0) {
    endGame(l, 'villagers', 'All the Mafia are gone. The villagers win!');
    return true;
  }
  if (alive.length <= 2 && mafiaAlive >= 1) {
    endGame(l, 'mafia', 'Only the Mafia and one other remain. The Mafia win!');
    return true;
  }
  return false;
}

function endGame(l, winner, text) {
  if (l.timer) clearTimeout(l.timer);
  l.timer = null;
  l.phase = 'ended';
  l.winner = winner;
  log(l, text, 'win');
  broadcast(l);
}

function resetLobby(l) {
  if (l.timer) clearTimeout(l.timer);
  l.timer = null;
  l.phase = 'lobby';
  l.round = 0;
  l.winner = null;
  l.night = null;
  l.dayVotes = new Map();
  for (const p of l.players.values()) {
    p.role = null; p.alive = true; p.selfSaves = 1; p.checks = [];
  }
  log(l, 'A new game is ready. Waiting for the host.', 'info');
  broadcast(l);
}

// ---------- what each player is allowed to see ----------
function viewFor(l, token) {
  const me = l.players.get(token);
  const ended = l.phase === 'ended';

  const players = [...l.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    alive: p.alive,
    isHost: p.token === l.hostToken,
    connected: p.connected,
    // Roles are public only once a player is out or the game is over.
    role: ended || !p.alive ? p.role : null,
    hasVoted: l.phase === 'day' ? l.dayVotes.has(p.token) : false,
  }));

  let you = null;
  let action = null;
  if (me) {
    you = {
      id: me.id,
      name: me.name,
      isHost: me.token === l.hostToken,
      role: l.phase === 'lobby' ? null : me.role,
      roleName: me.role ? ROLE_NAMES[me.role] : null,
      alive: me.alive,
      selfSavesLeft: me.selfSaves,
      checks: me.checks,
    };
    const alive = alivePlayers(l);
    if (l.phase === 'night' && me.alive && NIGHT_ROLES.includes(me.role)) {
      let targets = [];
      if (me.role === 'mafia') {
        targets = alive.filter((p) => p.role !== 'mafia');
      } else if (me.role === 'medic') {
        targets = alive.filter((p) => p !== me || me.selfSaves > 0);
      } else if (me.role === 'detective') {
        targets = alive.filter((p) => p !== me);
      }
      action = {
        type: me.role === 'mafia' ? 'kill' : me.role === 'medic' ? 'save' : 'check',
        done: l.night.done.has(token),
        targets: targets.map((p) => ({ id: p.id, name: p.name })),
      };
    } else if (l.phase === 'day' && me.alive) {
      action = {
        type: 'vote',
        done: l.dayVotes.has(token),
        targets: alive.filter((p) => p !== me).map((p) => ({ id: p.id, name: p.name })),
      };
    }
  }

  return {
    code: l.code,
    phase: l.phase,
    round: l.round,
    settings: l.settings,
    minPlayers: MIN_PLAYERS,
    winner: l.winner,
    isHost: !!me && me.token === l.hostToken,
    players,
    you,
    action,
    pendingCount: l.phase === 'night' && l.night ? nightPending(l).length : 0,
    log: l.log.slice(-40),
  };
}

// ---------- socket handlers ----------
io.on('connection', (socket) => {
  const reply = (cb, data) => { if (typeof cb === 'function') cb(data); };

  socket.on('create', (data, cb) => {
    const name = cleanName(data && data.name);
    if (!name) return reply(cb, { ok: false, error: 'Enter a name first.' });
    const s = (data && data.settings) || {};
    const settings = {
      mafia: clampInt(s.mafia, 1, 3, 1),
      medic: !!s.medic,
      detective: !!s.detective,
      maxPlayers: clampInt(s.maxPlayers, 4, 15, 8),
    };
    const specials = settings.mafia + (settings.medic ? 1 : 0) + (settings.detective ? 1 : 0);
    if (specials + MIN_PLAYERS - 1 > settings.maxPlayers) {
      return reply(cb, { ok: false, error: 'Max players is too small for those roles.' });
    }
    const code = newCode();
    const token = newToken();
    const l = {
      code, hostToken: token, settings, phase: 'lobby', round: 0, winner: null,
      players: new Map(), night: null, dayVotes: new Map(), log: [], timer: null,
      emptyTimer: null,
    };
    lobbies.set(code, l);
    addPlayer(l, token, name, socket);
    log(l, `${name} created the game.`, 'info');
    reply(cb, { ok: true, code, token });
    broadcast(l);
  });

  socket.on('join', (data, cb) => {
    data = data || {};
    const code = String(data.code || '').trim().toUpperCase();
    const l = lobbies.get(code);
    if (!l) return reply(cb, { ok: false, error: 'No game with that code.' });

    // Rejoin after a page refresh or dropped connection.
    const existing = data.token && l.players.get(data.token);
    if (existing) {
      existing.socketId = socket.id;
      existing.connected = true;
      socket.data.token = existing.token;
      socket.data.code = code;
      if (l.emptyTimer) { clearTimeout(l.emptyTimer); l.emptyTimer = null; }
      reply(cb, { ok: true, code, token: existing.token });
      return broadcast(l);
    }

    const name = cleanName(data && data.name);
    if (!name) return reply(cb, { ok: false, error: 'Enter a name first.' });
    if (l.phase !== 'lobby') return reply(cb, { ok: false, error: 'That game has already started.' });
    if (l.players.size >= l.settings.maxPlayers) return reply(cb, { ok: false, error: 'That game is full.' });
    const taken = [...l.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (taken) return reply(cb, { ok: false, error: 'That name is taken in this game.' });

    const token = newToken();
    addPlayer(l, token, name, socket);
    log(l, `${name} joined the game.`, 'join');
    reply(cb, { ok: true, code, token });
    broadcast(l);
  });

  socket.on('startGame', (cb) => {
    const c = ctx(socket);
    if (!c || c.p.token !== c.l.hostToken) return reply(cb, { ok: false, error: 'Only the host can start.' });
    const { l } = c;
    if (l.phase !== 'lobby') return reply(cb, { ok: false, error: 'The game is already running.' });
    if (l.players.size < MIN_PLAYERS) {
      return reply(cb, { ok: false, error: `You need at least ${MIN_PLAYERS} players.` });
    }
    assignRoles(l);
    l.round = 1;
    log(l, 'The host has started the game. Roles have been handed out.', 'info');
    startNight(l);
    reply(cb, { ok: true });
  });

  socket.on('nightAction', (data, cb) => {
    const c = ctx(socket);
    if (!c) return reply(cb, { ok: false });
    const { l, p } = c;
    if (l.phase !== 'night' || !p.alive || !NIGHT_ROLES.includes(p.role)) return reply(cb, { ok: false });
    if (l.night.done.has(p.token)) return reply(cb, { ok: false, error: 'You already chose tonight.' });
    const t = data && data.target ? findById(l, data.target) : null;

    if (p.role === 'mafia') {
      if (!t || !t.alive || t.role === 'mafia') return reply(cb, { ok: false, error: 'Pick a living target.' });
      l.night.kills.set(p.token, t.id);
    } else if (p.role === 'medic') {
      if (t && !t.alive) return reply(cb, { ok: false, error: 'Pick a living player.' });
      if (t === p) {
        if (p.selfSaves <= 0) return reply(cb, { ok: false, error: 'You can only save yourself once.' });
        p.selfSaves -= 1;
      }
      if (t) l.night.saves.push(t.id);
    } else if (p.role === 'detective') {
      if (!t || !t.alive || t === p) return reply(cb, { ok: false, error: 'Pick a living player.' });
      p.checks.push({ name: t.name, mafia: t.role === 'mafia' });
    }

    l.night.done.add(p.token);
    reply(cb, { ok: true });
    if (nightPending(l).length === 0) {
      resolveNight(l);
    } else {
      broadcast(l);
    }
  });

  socket.on('vote', (data, cb) => {
    const c = ctx(socket);
    if (!c) return reply(cb, { ok: false });
    const { l, p } = c;
    if (l.phase !== 'day' || !p.alive) return reply(cb, { ok: false });
    const t = data && data.target ? findById(l, data.target) : null;
    if (!t || !t.alive || t === p) return reply(cb, { ok: false, error: 'Pick a living player.' });
    l.dayVotes.set(p.token, t.id);
    reply(cb, { ok: true });
    const aliveCount = alivePlayers(l).length;
    if (l.dayVotes.size >= aliveCount) {
      resolveDay(l);
    } else {
      broadcast(l);
    }
  });

  socket.on('playAgain', (cb) => {
    const c = ctx(socket);
    if (!c || c.p.token !== c.l.hostToken) return reply(cb, { ok: false });
    if (c.l.phase !== 'ended') return reply(cb, { ok: false });
    resetLobby(c.l);
    reply(cb, { ok: true });
  });

  socket.on('disconnect', () => {
    const c = ctx(socket);
    if (!c) return;
    const { l, p } = c;
    if (p.socketId !== socket.id) return; // already rejoined on another socket
    p.connected = false;
    broadcast(l);
    if ([...l.players.values()].every((x) => !x.connected)) {
      // Clean up empty games after 10 minutes.
      l.emptyTimer = setTimeout(() => {
        if (l.timer) clearTimeout(l.timer);
        for (const x of l.players.values()) tokenIndex.delete(x.token);
        lobbies.delete(l.code);
      }, 10 * 60 * 1000);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Mafia game running at http://localhost:${PORT}`);
});
