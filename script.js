(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  const RANK_KEY = 'qpc_ranking';
  const NAME_KEY = 'qpc_name';

  const DIFFS = {
    '3x3': { rows: 3, cols: 3, label: 'Fácil' },
    '4x4': { rows: 4, cols: 4, label: 'Médio' },
    '5x5': { rows: 5, cols: 5, label: 'Difícil' },
    '6x6': { rows: 6, cols: 6, label: 'Insano' },
  };

  /* ================= state ================= */
  let images = [];
  let selDiff = '4x4';
  let game = null; // { imgSrc, imgName, rows, cols, total, pieceSize, pieces[], tray[], lockedCount, finished }
  let timer = { running: false, elapsedMs: 0, last: 0, interval: null };
  let dragging = null;
  let selected = null;
  let paused = false;

  /* ================= helpers ================= */
  function showScreen(id) {
    $$('.screen').forEach((s) => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
  }

  function fmtTime(ms) {
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  function getRanking() {
    try { return JSON.parse(localStorage.getItem(RANK_KEY)) || []; }
    catch { return []; }
  }
  function saveRanking(list) {
    localStorage.setItem(RANK_KEY, JSON.stringify(list));
  }
  function getPlayerName() {
    return localStorage.getItem(NAME_KEY) || '';
  }

  /* ================= image discovery ================= */
  function tryLoad(src) {
    return new Promise((res) => {
      const im = new Image();
      im.onload = () => res(true);
      im.onerror = () => res(false);
      im.src = src;
    });
  }

  async function discoverImages() {
    const found = [];
    const exts = ['jpg', 'jpeg', 'png', 'webp'];
    for (let i = 1; i <= 99; i++) {
      for (const e of exts) {
        const src = `IMG/${i}.${e}`;
        if (await tryLoad(src)) {
          found.push({ src, name: `${i}.${e}` });
          break;
        }
      }
    }
    return found;
  }

  /* ================= menu ================= */
  function buildMenu() {
    if (images.length === 0) {
      $('#noImages').classList.remove('hidden');
      $('#btnPlay').disabled = true;
      $('#btnPlay').style.opacity = 0.5;
    } else {
      $('#noImages').classList.add('hidden');
      $('#btnPlay').disabled = false;
      $('#btnPlay').style.opacity = 1;
    }
  }

  function buildDifficulties() {
    const wrap = $('#difficultyOptions');
    wrap.innerHTML = '';
    Object.entries(DIFFS).forEach(([key, d]) => {
      const b = document.createElement('button');
      b.className = 'diff-option' + (key === selDiff ? ' selected' : '');
      b.textContent = `${d.label} ${d.cols}x${d.rows}`;
      b.addEventListener('click', () => {
        selDiff = key;
        $$('.diff-option').forEach((o) => o.classList.remove('selected'));
        b.classList.add('selected');
        updateMenuBest();
      });
      wrap.appendChild(b);
    });
  }

  function updateMenuBest() {
    const el = $('#menuBest');
    const best = getRanking()
      .filter((r) => r.diff === selDiff)
      .sort((a, b) => a.time - b.time)[0];
    if (best) {
      el.classList.remove('hidden');
      el.innerHTML = `Melhor tempo em <b>${DIFFS[selDiff].label}</b>: <b>${fmtTime(best.time)}</b> — ${best.name}`;
    } else {
      el.classList.add('hidden');
    }
  }

  /* ================= game ================= */
  const boardEl = $('#board');
  const boardImageEl = $('#boardImage');
  const boardCellsEl = $('#boardCells');
  const trayInnerEl = $('#trayInner');
  const piecesLayerEl = $('#piecesLayer');
  const timerEl = $('#timerDisplay');

  function newGame() {
    if (!images.length) return;
    stopTimer();
    paused = false;
    clearSelection();
    $('#pauseOverlay').classList.add('hidden');
    $('#winOverlay').classList.add('hidden');
    $('#boardImage').classList.remove('show');
    $('#btnPause').classList.remove('paused');
    $('#btnSaveRecord').classList.remove('hidden');
    $('#btnViewRanking').classList.add('hidden');

    const img = images[Math.floor(Math.random() * images.length)];
    const d = DIFFS[selDiff];
    game = {
      imgSrc: img.src,
      imgName: img.name,
      rows: d.rows,
      cols: d.cols,
      total: d.rows * d.cols,
      pieceSize: 0,
      pieces: [],
      tray: [],
      cellsEl: [],
      lockedCount: 0,
      finished: false,
    };

    boardImageEl.style.backgroundImage = `url("${game.imgSrc}")`;
    createCells();
    createPieces();
    measure();
    shuffleAndDeal();
    startTimer();
  }

  function createCells() {
    boardCellsEl.innerHTML = '';
    boardCellsEl.style.gridTemplateColumns = `repeat(${game.cols}, 1fr)`;
    boardCellsEl.style.gridTemplateRows = `repeat(${game.rows}, 1fr)`;
    game.cellsEl = [];
    const total = game.cols * game.rows;
    for (let i = 0; i < total; i++) {
      const el = document.createElement('div');
      el.className = 'cell';
      el.dataset.cell = i;
      el.addEventListener('click', () => onCellClick(i));
      boardCellsEl.appendChild(el);
      game.cellsEl.push(el);
    }
  }

  function onCellClick(index) {
    if (!game || game.finished || paused) return;
    if (!selected) return;
    if (selected.cell === index) {
      clearSelection();
      relayout();
      return;
    }
    const ok = placeAt(selected, index);
    if (ok) {
      clearSelection();
    } else {
      toast('Esse quadrado já tem uma peça travada');
    }
    relayout();
  }

  function clearSelection() {
    if (selected) {
      selected.el.classList.remove('selected');
      selected = null;
      updateCells();
    }
  }

  function setSelected(piece) {
    clearSelection();
    selected = piece;
    piece.el.classList.add('selected');
    updateCells();
  }

  function updateCells() {
    game.cellsEl.forEach((el, i) => {
      const hasLocked = game.pieces.some((p) => p.cell === i && p.locked);
      el.classList.toggle('ready', !!selected && !hasLocked);
      el.classList.toggle('busy', !!selected && hasLocked);
    });
  }

  function createPieces() {
    piecesLayerEl.innerHTML = '';
    game.pieces = [];
    const { rows, cols } = game;
    const total = rows * cols;
    for (let id = 0; id < total; id++) {
      const r = Math.floor(id / cols);
      const c = id % cols;
      const el = document.createElement('div');
      el.className = 'piece';
      el.style.backgroundImage = `url("${game.imgSrc}")`;
      el.style.backgroundSize = `${cols * 100}% ${rows * 100}%`;
      el.style.backgroundPosition = `${cols === 1 ? 0 : (c / (cols - 1)) * 100}% ${rows === 1 ? 0 : (r / (rows - 1)) * 100}%`;
      const piece = {
        id,
        el,
        locked: false,
        cell: -1,
        inTray: true,
        rot: (Math.random() * 6 - 3),
      };
      piece.el.dataset.id = id;
      piece.el.addEventListener('pointerdown', (e) => onPointerDown(e, piece));
      piecesLayerEl.appendChild(el);
      game.pieces.push(piece);
      game.tray.push(piece);
    }
    shuffleArray(game.tray);
  }

  function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  function measure() {
    game.pieceSize = boardEl.clientWidth / game.cols;
    game.boardRect = boardEl.getBoundingClientRect();
    boardEl.style.backgroundSize = `${game.pieceSize * 2}px ${game.pieceSize * 2}px`;
    game.pieces.forEach((p) => {
      p.el.style.width = game.pieceSize + 'px';
      p.el.style.height = game.pieceSize + 'px';
    });
    trayInnerEl.style.height = `${game.pieceSize + 12}px`;
  }

  function boardCellCenter(index) {
    const { cols, pieceSize, boardRect } = game;
    const r = Math.floor(index / cols);
    const c = index % cols;
    return {
      x: boardRect.left + c * pieceSize + pieceSize / 2,
      y: boardRect.top + r * pieceSize + pieceSize / 2,
    };
  }

  function trayPosFor(index) {
    const tr = trayInnerEl.getBoundingClientRect();
    const size = game.pieceSize;
    const gap = 8;
    const y = tr.top + tr.height / 2;
    const x = tr.left + 14 + index * (size + gap) + size / 2;
    return { x, y };
  }

  function applyTransform(piece, x, y, rot = 0, scale = 1) {
    const size = piece.el.offsetWidth;
    piece.el.style.setProperty('--px', `${x - size / 2}px`);
    piece.el.style.setProperty('--py', `${y - size / 2}px`);
    piece.el.style.setProperty('--rot', `${rot}deg`);
    piece.el.style.setProperty('--scale', scale);
  }

  function relayout() {
    measure();
    game.pieces.forEach((p) => {
      if (p === dragging?.piece) return;
      if (p.locked || p.cell >= 0) {
        const c = boardCellCenter(p.cell);
        applyTransform(p, c.x, c.y, 0, 1);
      } else {
        const i = game.tray.indexOf(p);
        const t = trayPosFor(i);
        applyTransform(p, t.x, t.y, p.rot, 1);
      }
    });
  }

  function shuffleAndDeal() {
    const size = game.pieceSize;
    game.pieces.forEach((p) => {
      const start = { x: game.boardRect.left + size / 2, y: game.boardRect.top + size / 2 };
      applyTransform(p, start.x, start.y, p.rot, 0.2);
      p.el.style.opacity = 0;
    });
    requestAnimationFrame(() => {
      game.pieces.forEach((p) => { p.el.style.opacity = 1; });
      setTimeout(relayout, 30);
    });
  }

  /* ---------- timer ---------- */
  function startTimer() {
    timer.elapsedMs = 0;
    timer.last = performance.now();
    timer.running = true;
    clearInterval(timer.interval);
    timer.interval = setInterval(tick, 100);
    tick();
  }
  function pauseTimer() {
    if (!timer.running) return;
    timer.elapsedMs += performance.now() - timer.last;
    timer.running = false;
    clearInterval(timer.interval);
    tick();
  }
  function resumeTimer() {
    if (timer.running) return;
    timer.last = performance.now();
    timer.running = true;
    clearInterval(timer.interval);
    timer.interval = setInterval(tick, 100);
    tick();
  }
  function stopTimer() {
    timer.running = false;
    clearInterval(timer.interval);
  }
  function tick() {
    if (timer.running) timer.elapsedMs = performance.now() - timer.last;
    timerEl.textContent = fmtTime(timer.elapsedMs);
  }

  /* ---------- pause ---------- */
  function setPaused(v) {
    paused = v;
    $('#pauseOverlay').classList.toggle('hidden', !v);
    $('#btnPause').classList.toggle('paused', v);
    if (v) pauseTimer(); else resumeTimer();
  }

  /* ---------- drag & drop ---------- */
  function onPointerDown(e, piece) {
    if (!game || game.finished || paused) return;
    if (piece.locked) return;
    e.preventDefault();
    const rect = piece.el.getBoundingClientRect();
    dragging = {
      piece,
      dx: e.clientX - (rect.left + rect.width / 2),
      dy: e.clientY - (rect.top + rect.height / 2),
      moved: false,
      startX: e.clientX,
      startY: e.clientY,
    };
    piece.el.setPointerCapture(e.pointerId);
    piece.el.classList.add('dragging');
    moveDragged(e.clientX, e.clientY);
  }

  function moveDragged(x, y) {
    const d = dragging;
    if (!d.moved && Math.hypot(x - d.startX, y - d.startY) > 6) {
      d.moved = true;
      clearSelection();
    }
    if (d.moved) {
      applyTransform(d.piece, x - d.dx, y - d.dy, 0, 1.08);
    }
  }

  function onPointerUp() {
    if (!dragging) return;
    const { piece, moved } = dragging;
    piece.el.classList.remove('dragging');
    dragging = null;

    if (!moved) {
      handlePieceClick(piece);
      return;
    }

    const x = piece.el.getBoundingClientRect().left + piece.el.offsetWidth / 2;
    const y = piece.el.getBoundingClientRect().top + piece.el.offsetHeight / 2;
    dropPiece(piece, x, y);
    relayout();
  }

  function handlePieceClick(piece) {
    if (piece.locked) return;
    if (selected === piece) {
      clearSelection();
    } else {
      setSelected(piece);
    }
    relayout();
  }

  function dropPiece(piece, x, y) {
    const { boardRect, cols, rows, pieceSize } = game;
    const insideBoard =
      x >= boardRect.left && x <= boardRect.right && y >= boardRect.top && y <= boardRect.bottom;

    if (!insideBoard) {
      if (piece.cell >= 0) {
        piece.cell = -1;
        piece.inTray = true;
        if (game.tray.indexOf(piece) === -1) game.tray.push(piece);
      }
      return;
    }

    const c = clamp(Math.floor((x - boardRect.left) / pieceSize), 0, cols - 1);
    const r = clamp(Math.floor((y - boardRect.top) / pieceSize), 0, rows - 1);
    placeAt(piece, r * cols + c);
  }

  function placeAt(piece, cell) {
    const occupant = game.pieces.find((p) => p.cell === cell && p !== piece);
    if (occupant) {
      if (occupant.locked) return false;
      occupant.cell = -1;
      occupant.inTray = true;
      if (game.tray.indexOf(occupant) === -1) game.tray.push(occupant);
    }

    piece.cell = cell;
    piece.inTray = false;
    removeFromTray(piece);

    if (piece.id === cell) {
      lockPiece(piece, cell);
    } else {
      piece.el.classList.remove('wrong');
      void piece.el.offsetWidth;
      piece.el.classList.add('wrong');
    }
    return true;
  }

  function removeFromTray(piece) {
    const i = game.tray.indexOf(piece);
    if (i !== -1) game.tray.splice(i, 1);
  }

  function lockPiece(piece, cell) {
    piece.locked = true;
    piece.el.classList.add('locked');
    game.lockedCount++;
    const c = boardCellCenter(cell);
    applyTransform(piece, c.x, c.y, 0, 1);
    if (game.lockedCount === game.total) finishGame();
  }

  function finishGame() {
    game.finished = true;
    stopTimer();
    const finalMs = timer.elapsedMs;
    setTimeout(() => {
      $('#winTime').textContent = fmtTime(finalMs);
      $('#winInfo').textContent = `${DIFFS[selDiff].label} — ${game.imgName}`;
      $('#playerName').value = getPlayerName();
      $('#btnViewRanking').classList.add('hidden');
      $('#winOverlay').classList.remove('hidden');
      startConfetti();
    }, 450);
  }

  /* ---------- pointer events on layer ---------- */
  piecesLayerEl.addEventListener('pointermove', (e) => {
    if (dragging) moveDragged(e.clientX, e.clientY);
  });
  piecesLayerEl.addEventListener('pointerup', onPointerUp);
  piecesLayerEl.addEventListener('pointercancel', onPointerUp);

  window.addEventListener('resize', () => {
    if (game) relayout();
  });

  /* ---------- win actions ---------- */
  $('#btnSaveRecord').addEventListener('click', () => {
    const name = ($('#playerName').value.trim() || 'Jogador').slice(0, 20);
    localStorage.setItem(NAME_KEY, name);
    const rec = { name, time: timer.elapsedMs, diff: selDiff, img: game.imgName, date: Date.now() };
    const list = getRanking();
    list.push(rec);
    list.sort((a, b) => a.time - b.time);
    const top = list.slice(0, 10);
    saveRanking(top);
    const pos = top.indexOf(rec) + 1;
    toast(pos > 0 ? `Recorde salvo! Posição #${pos}` : 'Recorde salvo!');
    $('#btnViewRanking').classList.remove('hidden');
    $('#btnSaveRecord').classList.add('hidden');
    updateMenuBest();
  });

  /* ================= ranking ================= */
  const RANK_FILTERS = ['todos', ...Object.keys(DIFFS)];
  let rankFilter = 'todos';

  function buildRankFilters() {
    const wrap = $('#rankFilters');
    wrap.innerHTML = '';
    RANK_FILTERS.forEach((key) => {
      const b = document.createElement('button');
      b.className = 'rank-filter' + (key === rankFilter ? ' selected' : '');
      b.textContent = key === 'todos' ? 'Todos' : DIFFS[key].label;
      b.addEventListener('click', () => {
        rankFilter = key;
        $$('.rank-filter').forEach((o) => o.classList.remove('selected'));
        b.classList.add('selected');
        renderRanking();
      });
      wrap.appendChild(b);
    });
  }

  function renderRanking() {
    const list = getRanking()
      .filter((r) => rankFilter === 'todos' || r.diff === rankFilter)
      .sort((a, b) => a.time - b.time)
      .slice(0, 10);

    const wrap = $('#rankList');
    wrap.innerHTML = '';
    $('#rankEmpty').classList.toggle('hidden', list.length > 0);

    list.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'rank-row' + (i < 3 ? ` top${i + 1}` : '');
      row.style.animationDelay = `${i * 0.05}s`;
      const d = new Date(r.date);
      row.innerHTML = `
        <div class="rank-pos">${i + 1}</div>
        <div class="rank-name">${escapeHtml(r.name)}</div>
        <div class="rank-meta">
          <div class="rank-time">${fmtTime(r.time)}</div>
          <span class="rank-chip">${DIFFS[r.diff]?.label || r.diff} · ${escapeHtml(r.img)}</span>
          <span class="rank-date">${d.toLocaleDateString('pt-BR')}</span>
        </div>`;
      wrap.appendChild(row);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /* ---------- confetti ---------- */
  let confettiCtx = null;
  function startConfetti() {
    const cv = $('#confetti');
    cv.width = window.innerWidth;
    cv.height = window.innerHeight;
    confettiCtx = cv.getContext('2d');
    const colors = ['#8b5cf6', '#ec4899', '#fbbf24', '#34d399', '#60a5fa', '#f472b6'];
    const parts = Array.from({ length: 160 }, () => ({
      x: Math.random() * cv.width,
      y: -20 - Math.random() * cv.height * 0.5,
      w: 6 + Math.random() * 8,
      h: 8 + Math.random() * 10,
      vy: 2 + Math.random() * 3.5,
      vx: -1.5 + Math.random() * 3,
      rot: Math.random() * Math.PI,
      vr: -0.12 + Math.random() * 0.24,
      color: colors[Math.floor(Math.random() * colors.length)],
    }));
    const t0 = performance.now();
    (function frame() {
      const elapsed = performance.now() - t0;
      if (elapsed > 4000) { confettiCtx.clearRect(0, 0, cv.width, cv.height); return; }
      confettiCtx.clearRect(0, 0, cv.width, cv.height);
      parts.forEach((p) => {
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        confettiCtx.save();
        confettiCtx.translate(p.x, p.y);
        confettiCtx.rotate(p.rot);
        confettiCtx.fillStyle = p.color;
        confettiCtx.globalAlpha = Math.max(0, 1 - (p.y + 20) / cv.height * 0.8);
        confettiCtx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        confettiCtx.restore();
      });
      requestAnimationFrame(frame);
    })();
  }

  /* ================= event wiring ================= */
  $('#btnPlay').addEventListener('click', () => {
    if (!selImage) { toast('Selecione uma imagem primeiro'); return; }
    showScreen('screen-game');
    newGame();
  });

  $('#btnRanking').addEventListener('click', () => {
    showScreen('screen-ranking');
    renderRanking();
  });  $('#btnRankBack').addEventListener('click', () => showScreen('screen-menu'));
  $('#btnRankClear').addEventListener('click', () => {
    if (confirm('Apagar todos os recordes?')) {
      saveRanking([]);
      renderRanking();
      toast('Ranking limpo');
    }
  });

  $('#btnHome').addEventListener('click', () => {
    stopTimer();
    showScreen('screen-menu');
    updateMenuBest();
  });

  $('#btnPause').addEventListener('click', () => {
    if (game.finished) return;
    setPaused(!paused);
  });

  $('#btnResume').addEventListener('click', () => setPaused(false));
  $('#btnRestart').addEventListener('click', () => newGame());
  $('#btnQuit').addEventListener('click', () => {
    setPaused(false);
    stopTimer();
    showScreen('screen-menu');
    updateMenuBest();
  });

  $('#btnPreview').addEventListener('click', () => {
    $('#boardImage').classList.toggle('show');
  });

  $('#btnViewRanking').addEventListener('click', () => {
    $('#winOverlay').classList.add('hidden');
    showScreen('screen-ranking');
    renderRanking();
  });

  $('#btnPlayAgain').addEventListener('click', () => {
    $('#winOverlay').classList.add('hidden');
    newGame();
  });

  $('#btnWinMenu').addEventListener('click', () => {
    $('#winOverlay').classList.add('hidden');
    stopTimer();
    showScreen('screen-menu');
    updateMenuBest();
  });

  /* ================= install gate (PWA) ================= */
  let deferredPrompt = null;
  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    window.navigator.standalone === true;
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);

  function isInstalled() {
    return isStandalone || localStorage.getItem('qpc_installed') === '1';
  }

  function initInstallGate() {
    const screen = $('#installScreen');
    const btnInstall = $('#btnInstall');
    const iosBox = $('#installIos');
    const fallback = $('#installFallback');

    if (isInstalled()) {
      localStorage.setItem('qpc_installed', '1');
      screen.classList.add('hidden');
      return;
    }

    if (!isMobile) {
      screen.classList.add('hidden');
      return;
    }

    screen.classList.remove('hidden');
    btnInstall.disabled = true;
    btnInstall.textContent = 'Verificando...';

    const tryPrompt = () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then((choice) => {
          if (choice.outcome === 'accepted') {
            localStorage.setItem('qpc_installed', '1');
            screen.classList.add('hidden');
            toast('Instalado! Jogo em tela cheia');
          }
        });
      } else if (isIOS) {
        iosBox.classList.remove('hidden');
        btnInstall.classList.add('hidden');
      } else {
        fallback.classList.remove('hidden');
        btnInstall.classList.add('hidden');
      }
    };

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      btnInstall.disabled = false;
      btnInstall.textContent = 'Instalar agora';
    });

    window.addEventListener('appinstalled', () => {
      localStorage.setItem('qpc_installed', '1');
      screen.classList.add('hidden');
    });

    btnInstall.addEventListener('click', tryPrompt);

    $('#btnPlayAnyway').addEventListener('click', (e) => {
      e.preventDefault();
      screen.classList.add('hidden');
    });

    const btnInstallApp = $('#btnInstallApp');
    if (isInstalled()) {
      btnInstallApp.classList.add('hidden');
    }
    btnInstallApp.addEventListener('click', () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then((choice) => {
          if (choice.outcome === 'accepted') {
            localStorage.setItem('qpc_installed', '1');
            toast('Instalado! Agora abra pelo ícone em tela cheia');
          }
        });
      } else if (isIOS) {
        toast('No iPhone: Compartilhar > Adicionar à Tela de Início');
      } else {
        toast('Instalação disponível em https (ou via localhost)');
      }
    });

    setTimeout(() => {
      if (!screen.classList.contains('hidden') && btnInstall.disabled) {
        btnInstall.disabled = false;
        btnInstall.textContent = 'Instalar agora';
        tryPrompt();
      }
    }, 1500);
  }

  /* ================= init ================= */
  buildDifficulties();
  buildRankFilters();
  initInstallGate();
  discoverImages().then((found) => {
    images = found;
    buildMenu();
    updateMenuBest();
  });
})();
