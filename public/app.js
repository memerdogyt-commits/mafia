// The Family: browser side. Talks to the server over Socket.IO and draws whatever state it sends.
(() => {
  const $ = (id) => document.getElementById(id);
  const SESSION_KEY = 'mafia-session';
  const ROLE_NAMES = { mafia: 'Mafia', medic: 'Medic', detective: 'Detective', villager: 'Villager' };
  const ROLE_DESC = {
    mafia: 'Each night, pick a villager to eliminate. Stay hidden.',
    medic: 'Each night, protect one person from the Mafia. You may save yourself once.',
    detective: 'Each night, investigate one player to learn whether they are Mafia.',
    villager: 'You have no night power. Use your wits and your vote.',
  };

  const socket = io();
  let session = loadSession();   // { code, token, name }
  let view = null;               // latest state from the server
  let picked = null;             // { key, id } so the chosen target stays highlighted
  let revealedRole = null;       // role we already animated

  // ---------- small helpers ----------
  function loadSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null; } catch { return null; }
  }
  function saveSession(s) {
    session = s;
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  }
  function clearSession() {
    session = null;
    localStorage.removeItem(SESSION_KEY);
  }
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function initials(name) {
    return name.split(/\s+/).map((w) => w[0] || '').join('').slice(0, 2).toUpperCase();
  }
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 2600);
  }
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  }
  function homeError(msg) { $('home-error').textContent = msg || ''; }
  function myName() { return $('home-name').value.trim(); }
  function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

  // ---------- home screen ----------
  if (session && session.name) $('home-name').value = session.name;

  $('btn-host').addEventListener('click', () => {
    if (!myName()) return homeError('Enter your name first.');
    homeError('');
    $('settings-error').textContent = '';
    $('modal-settings').hidden = false;
  });

  $('btn-join').addEventListener('click', () => {
    if (!myName()) return homeError('Enter your name first.');
    homeError('');
    $('join-box').hidden = false;
    $('join-code').focus();
  });

  function confirmJoin() {
    const name = myName();
    const code = $('join-code').value.trim().toUpperCase();
    if (!name) return homeError('Enter your name first.');
    if (code.length !== 4) return homeError('Table codes are 4 characters.');
    homeError('');
    socket.emit('join', { code, name }, (res) => {
      if (!res || !res.ok) return homeError(res ? res.error : 'Could not reach the table.');
      saveSession({ code: res.code, token: res.token, name });
    });
  }
  $('btn-join-confirm').addEventListener('click', confirmJoin);
  $('join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmJoin(); });
  $('join-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });

  // ---------- settings modal ----------
  const settings = { mafia: 1, medic: true, detective: true, maxPlayers: 8 };
  function paintSettings() { $('set-mafia').textContent = settings.mafia; }

  document.querySelectorAll('[data-step="mafia"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      settings.mafia = clamp(settings.mafia + Number(btn.dataset.dir), 1, 3);
      paintSettings();
    });
  });
  $('btn-settings-cancel').addEventListener('click', () => { $('modal-settings').hidden = true; });
  $('modal-settings').addEventListener('click', (e) => {
    if (e.target === $('modal-settings')) $('modal-settings').hidden = true;
  });

  $('btn-create').addEventListener('click', () => {
    const name = myName();
    if (!name) return ($('settings-error').textContent = 'Enter your name first.');
    settings.medic = $('set-medic').checked;
    settings.detective = $('set-detective').checked;
    settings.maxPlayers = clamp(parseInt($('set-max').value, 10) || 8, 4, 15);
    $('settings-error').textContent = '';
    socket.emit('create', { name, settings: { ...settings } }, (res) => {
      if (!res || !res.ok) return ($('settings-error').textContent = res ? res.error : 'Could not reach the table.');
      $('modal-settings').hidden = true;
      saveSession({ code: res.code, token: res.token, name });
    });
  });

  // ---------- lobby ----------
  $('btn-start').addEventListener('click', () => {
    $('btn-start').disabled = true;
    socket.emit('startGame', (res) => {
      if (res && !res.ok) toast(res.error);
      $('btn-start').disabled = false;
    });
  });

  // ---------- game ----------
  $('btn-again').addEventListener('click', () => {
    socket.emit('playAgain', (res) => { if (res && !res.ok) toast('Only the host can reset.'); });
  });

  function choose(id) {
    if (!view || !view.action) return;
    const a = view.action;
    const ev = a.type === 'vote' ? 'vote' : 'nightAction';
    picked = { key: keyFor(), id };
    socket.emit(ev, { target: id }, (res) => {
      if (!res || !res.ok) {
        picked = null;
        toast((res && res.error) || 'Not now.');
        render();
      }
    });
  }

  function keyFor() {
    return `${view.phase}-${view.round}-${view.action ? view.action.type : ''}`;
  }

  function seat(p) {
    const li = el('li', 'seat');
    if (!p.alive) li.classList.add('dead');
    if (p.connected === false) li.classList.add('offline');
    if (view.you && p.id === view.you.id) li.classList.add('is-you');
    if (view.phase === 'day' && p.hasVoted) li.classList.add('voted');
    if (p.role === 'mafia') li.classList.add('role-mafia');

    const body = el('div');
    body.append(el('div', 'name', p.name + (view.you && p.id === view.you.id ? ' (you)' : '')));

    let tag;
    if (view.phase === 'lobby') tag = p.isHost ? 'Host' : 'Seated';
    else {
      tag = p.role ? ROLE_NAMES[p.role] : p.alive ? 'Alive' : 'Out';
      if (p.isHost) tag += ' · Host';
    }
    if (p.connected === false) tag += ' · Offline';
    body.append(el('div', 'tag', tag));

    li.append(el('div', 'avatar', initials(p.name)), body);
    return li;
  }

  function emptySeat() {
    const li = el('li', 'seat');
    li.style.borderStyle = 'dashed';
    li.style.background = 'transparent';
    li.style.opacity = '.55';
    li.append(el('div', 'avatar', '?'), el('div', null, 'Open seat'));
    return li;
  }

  function renderLobby() {
    showScreen('screen-lobby');
    const s = view.settings;
    $('lobby-code').textContent = view.code;
    $('lobby-count').textContent = `${view.players.length} / ${s.maxPlayers}`;
    $('lobby-count').className = 'pill' + (view.players.length >= view.minPlayers ? ' good' : '');

    const list = $('lobby-players');
    list.replaceChildren(...view.players.map(seat));
    for (let i = view.players.length; i < s.maxPlayers; i++) list.append(emptySeat());

    $('lobby-rules').textContent =
      `${s.mafia} Mafia  ·  ${s.medic ? 'Medic' : 'No Medic'}  ·  ${s.detective ? 'Detective' : 'No Detective'}  ·  Villagers fill the rest`;

    const enough = view.players.length >= view.minPlayers;
    const startBtn = $('btn-start');
    startBtn.hidden = !view.isHost;
    startBtn.disabled = !enough;
    if (view.isHost) {
      $('lobby-hint').textContent = enough
        ? 'Everyone seated? Start the first night when you are ready.'
        : `Need ${view.minPlayers - view.players.length} more player(s) before you can start.`;
    } else {
      $('lobby-hint').textContent = 'Sit tight. The host will start the first night.';
    }
  }

  function renderBanner() {
    const banner = $('phase-banner');
    const title = $('phase-title');
    const sub = $('phase-sub');
    const you = view.you;
    const pending = view.pendingCount;

    if (view.phase === 'night') {
      banner.className = 'phase-banner night';
      title.textContent = view.round === 1 ? 'The first night falls' : 'Night falls';
      if (you && !you.alive) sub.textContent = 'You are out of the game. Watch in silence.';
      else if (you && you.role === 'villager') sub.textContent = 'The town sleeps. Stay still.';
      else sub.textContent = pending > 0 ? `${pending} still deciding...` : 'All choices are in.';
    } else if (view.phase === 'day') {
      banner.className = 'phase-banner day';
      title.textContent = 'Day time has started';
      sub.textContent = 'Talk it out, then vote someone out.';
    } else if (view.phase === 'results') {
      banner.className = 'phase-banner day';
      title.textContent = 'The votes are in';
      sub.textContent = 'Night is coming...';
    } else if (view.phase === 'ended') {
      banner.className = 'phase-banner end';
      title.textContent = view.winner === 'mafia' ? 'The Mafia wins' : 'The Villagers win';
      sub.textContent = 'The game is over. Roles are revealed below.';
    } else {
      banner.className = 'phase-banner';
      title.textContent = 'Waiting';
      sub.textContent = '';
    }

    const pill = $('game-phase');
    pill.textContent = view.phase === 'night' ? `Night ${view.round}`
      : view.phase === 'day' ? `Day ${view.round}`
      : view.phase === 'results' ? 'Votes in'
      : 'Game over';
    pill.className = 'pill' + (view.phase === 'night' ? ' danger' : view.phase === 'ended' ? '' : ' good');
  }

  function renderRoleCard() {
    const card = $('role-card');
    const you = view.you;
    if (!you || !you.roleName) { card.hidden = true; return; }
    card.hidden = false;
    card.className = 'card role-card' + (you.role === 'mafia' ? ' mafia' : '');
    if (revealedRole !== you.role) {
      revealedRole = you.role;
      card.classList.add('reveal');
    }
    $('role-name').textContent = you.roleName;
    $('role-desc').textContent = ROLE_DESC[you.role];
    let status = '';
    if (!you.alive) status = 'You are out of the game.';
    else if (view.action && view.action.done && view.phase === 'night') status = 'Your choice is locked in.';
    $('role-status').textContent = status;
  }

  function renderActionPanel() {
    const panel = $('action-panel');
    const a = view.action;
    if (!a) { panel.hidden = true; return; }
    panel.hidden = false;
    const key = keyFor();
    const titles = { kill: "Choose tonight's target", save: 'Who do you protect?', check: 'Who do you investigate?', vote: 'Vote someone out' };
    const subs = {
      kill: 'Pick a villager to eliminate. The other Mafia will see your choice.',
      save: view.you.selfSavesLeft > 0
        ? `You can still save yourself ${view.you.selfSavesLeft} more time.`
        : 'You have already used your one self-save.',
      check: 'You will learn whether they are Mafia. Keep it quiet.',
      vote: 'Tap a name to vote. Tap again to change it. A tie means nobody goes.',
    };
    $('action-title').textContent = titles[a.type];
    $('action-sub').textContent = subs[a.type];

    const grid = $('action-targets');
    grid.replaceChildren();
    const locked = a.done && a.type !== 'vote';
    a.targets.forEach((t) => {
      const b = el('button', 'target-btn', t.name);
      b.type = 'button';
      if (picked && picked.key === key && picked.id === t.id) b.classList.add('picked');
      b.disabled = locked;
      b.addEventListener('click', () => choose(t.id));
      grid.append(b);
    });
    if (a.type === 'save' && !a.done) {
      const skip = el('button', 'target-btn', 'Save nobody');
      skip.type = 'button';
      skip.addEventListener('click', () => choose(null));
      grid.append(skip);
    }

    const note = $('action-done');
    if (a.done) {
      note.hidden = false;
      note.textContent = a.type === 'vote'
        ? 'Vote cast. Waiting for the rest of the table.'
        : 'Locked in. Waiting for the others.';
    } else {
      note.hidden = true;
    }
  }

  function renderChecks() {
    const checks = (view.you && view.you.checks) || [];
    const box = $('check-results');
    box.hidden = checks.length === 0;
    const list = $('check-list');
    list.replaceChildren();
    checks.forEach((c) => {
      const li = el('li');
      li.append(`${c.name}: `, el('span', c.mafia ? 'guilty' : 'innocent', c.mafia ? 'MAFIA' : 'Not Mafia'));
      list.append(li);
    });
  }

  function renderGame() {
    showScreen('screen-game');
    $('game-code').textContent = view.code;
    renderBanner();
    renderRoleCard();
    renderActionPanel();
    renderChecks();

    $('game-players').replaceChildren(...view.players.map(seat));

    const log = $('log');
    log.replaceChildren(...[...view.log].reverse().map((e) => el('li', e.kind, e.text)));

    const again = $('btn-again');
    again.hidden = !(view.phase === 'ended' && view.isHost);
  }

  function render() {
    if (!view || !session || view.code !== session.code) return showScreen('screen-home');
    if (view.phase === 'lobby') renderLobby();
    else renderGame();
  }

  // ---------- connection ----------
  socket.on('state', (data) => {
    view = data;
    render();
  });

  socket.on('connect', () => {
    if (!session) return;
    socket.emit('join', { code: session.code, token: session.token, name: session.name }, (res) => {
      if (!res || !res.ok) {
        clearSession();
        view = null;
        showScreen('screen-home');
        toast((res && res.error) || 'That table is gone.');
      }
    });
  });

  socket.on('disconnect', () => toast('Connection lost. Trying to reconnect...'));

  showScreen('screen-home');
  paintSettings();
})();
