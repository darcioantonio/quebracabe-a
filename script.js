(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  const RANK_KEY = 'qpc_ranking';
  const NAME_KEY = 'qpc_name';

  const DIFFS = {
    '4x4': { rows: 4, cols: 4, label: 'Fácil', sub: '16 pcs' },
    '6x6': { rows: 6, cols: 6, label: 'Médio', sub: '36 pcs' },
    '8x8': { rows: 8, cols: 8, label: 'Difícil', sub: '64 pcs' },
    '10x10': { rows: 10, cols: 10, label: 'Insano', sub: '100 pcs' },
  };

  /* ================= state ================= */
  let images = [];
  let selDiff = '4x4';
  let game = null; // { imgSrc, imgName, rows, cols, total, pieceSize, pieces[], tray[], score, streak, lockedCount, finished }
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
    if (!t) return;
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

  /* ================= haptics & sound ================= */
  function haptic(pattern) {
    if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch {} }
  }

  let soundOn = localStorage.getItem('qpc_sound') !== '0';
  let audioCtx = null;
  function ensureAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) { try { audioCtx = new AC(); } catch {} }
    }
    if (audioCtx && audioCtx.state === 'suspended') { audioCtx.resume().catch(() => {}); }
  }

  function playSeq(notes) {
    if (!soundOn) return;
    ensureAudio();
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    notes.forEach((n) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = n.type || 'sine';
      osc.frequency.value = n.f;
      const start = now + (n.t || 0);
      const dur = n.d || 0.12;
      const vol = n.g || 0.08;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(vol, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(start);
      osc.stop(start + dur + 0.03);
    });
  }

  const SFX = {
    pick:  () => playSeq([{ f: 620, d: 0.07, type: 'triangle', g: 0.05 }]),
    wrong: () => {
      if (game) game.streak = 0;
      playSeq([
        { f: 180, d: 0.1, type: 'sawtooth', g: 0.06 },
        { f: 130, t: 0.08, d: 0.15, type: 'sawtooth', g: 0.06 }
      ]);
    },
    lock:  (streak = 1, neighborCount = 0) => {
      const baseF = 480 + Math.min(streak, 10) * 35;
      const notes = [
        { f: baseF, d: 0.08, type: 'sine', g: 0.08 },
        { f: baseF * 1.25, t: 0.06, d: 0.12, type: 'sine', g: 0.08 }
      ];
      if (neighborCount > 0) {
        notes.push({ f: baseF * 1.5, t: 0.12, d: 0.2, type: 'triangle', g: 0.09 });
      }
      playSeq(notes);
    },
    win:   () => playSeq([
      { f: 523, d: 0.14, type: 'triangle', g: 0.09 },
      { f: 659, t: 0.12, d: 0.14, type: 'triangle', g: 0.09 },
      { f: 784, t: 0.24, d: 0.14, type: 'triangle', g: 0.09 },
      { f: 1047, t: 0.38, d: 0.35, type: 'sine', g: 0.1 },
      { f: 1318, t: 0.52, d: 0.45, type: 'sine', g: 0.1 }
    ]),
  };

  function updateSoundUI() {
    const btn = $('#btnSound');
    if (btn) btn.classList.toggle('muted', !soundOn);
  }

  /* ================= image discovery & fallbacks ================= */
  function tryLoad(src) {
    return new Promise((res) => {
      const im = new Image();
      im.onload = () => res(true);
      im.onerror = () => res(false);
      im.src = src;
    });
  }

  function generateFallbackArtworks() {
    const arts = [
      { name: 'Galáxia Neon', draw: (ctx, w, h) => {
        const g = ctx.createRadialGradient(w/2, h/2, 10, w/2, h/2, w*0.7);
        g.addColorStop(0, '#8b5cf6'); g.addColorStop(0.5, '#ec4899'); g.addColorStop(1, '#0a0b1e');
        ctx.fillStyle = g; ctx.fillRect(0,0,w,h);
        for(let i=0; i<120; i++) {
          ctx.fillStyle = `rgba(255,255,255,${Math.random()*0.8})`;
          ctx.beginPath(); ctx.arc(Math.random()*w, Math.random()*h, Math.random()*2.5, 0, Math.PI*2); ctx.fill();
        }
      }},
      { name: 'Pôr do Sol Retro', draw: (ctx, w, h) => {
        const g = ctx.createLinearGradient(0,0,0,h);
        g.addColorStop(0, '#3b0764'); g.addColorStop(0.5, '#f43f5e'); g.addColorStop(1, '#fbbf24');
        ctx.fillStyle = g; ctx.fillRect(0,0,w,h);
        ctx.fillStyle = '#fef08a'; ctx.beginPath(); ctx.arc(w/2, h*0.5, h*0.22, 0, Math.PI*2); ctx.fill();
      }},
      { name: 'Oceano Cristalino', draw: (ctx, w, h) => {
        const g = ctx.createLinearGradient(0,0,w,h);
        g.addColorStop(0, '#0284c7'); g.addColorStop(0.5, '#06b6d4'); g.addColorStop(1, '#10b981');
        ctx.fillStyle = g; ctx.fillRect(0,0,w,h);
        for(let i=0; i<8; i++) {
          ctx.strokeStyle = `rgba(255,255,255,${0.15 + i*0.08})`; ctx.lineWidth = 6 + i*4;
          ctx.beginPath(); ctx.arc(w*0.3, h*0.4, 40 + i*35, 0, Math.PI*2); ctx.stroke();
        }
      }},
      { name: 'Arte Abstrata Fluid', draw: (ctx, w, h) => {
        const g = ctx.createLinearGradient(0,0,w,h);
        g.addColorStop(0, '#8b5cf6'); g.addColorStop(0.5, '#6366f1'); g.addColorStop(1, '#ec4899');
        ctx.fillStyle = g; ctx.fillRect(0,0,w,h);
        ctx.fillStyle = 'rgba(251, 191, 36, 0.4)';
        ctx.beginPath(); ctx.ellipse(w*0.6, h*0.4, w*0.3, h*0.2, Math.PI/4, 0, Math.PI*2); ctx.fill();
      }}
    ];

    return arts.map((art, idx) => {
      const cv = document.createElement('canvas');
      cv.width = 600; cv.height = 600;
      const ctx = cv.getContext('2d');
      art.draw(ctx, 600, 600);
      const dataUrl = cv.toDataURL('image/jpeg', 0.9);
      return { src: dataUrl, name: art.name, id: `art-${idx+1}` };
    });
  }

  async function discoverImages() {
    const found = [];
    const exts = ['jpg', 'jpeg', 'png', 'webp'];
    const cacheBuster = `v=${Date.now()}`;
    
    for (let i = 1; i <= 50; i++) {
      let imageFoundInGroup = false;
      for (const e of exts) {
        const rawSrc = `IMG/${i}.${e}`;
        const srcWithBuster = `${rawSrc}?${cacheBuster}`;
        if (await tryLoad(srcWithBuster)) {
          found.push({ src: srcWithBuster, rawSrc, name: `Imagem ${i}`, id: `img-${i}` });
          imageFoundInGroup = true;
          break;
        }
      }
      if (!imageFoundInGroup && i > 10 && found.length > 0) {
        let missingStreak = true;
        for (let next = i; next <= Math.min(i + 2, 50); next++) {
          for (const e of exts) {
            if (await tryLoad(`IMG/${next}.${e}?${cacheBuster}`)) {
              missingStreak = false; break;
            }
          }
        }
        if (missingStreak) break;
      }
    }
    if (found.length < 4) {
      const fallbacks = generateFallbackArtworks();
      found.push(...fallbacks);
    }
    return found;
  }

  /* ================= JIGSAW PUZZLE PIECE MESH & CANVAS DRAWING ================= */
  function generateJigsawMesh(rows, cols) {
    const hEdges = Array.from({ length: rows - 1 }, () =>
      Array.from({ length: cols }, () => (Math.random() < 0.5 ? 1 : -1))
    );
    const vEdges = Array.from({ length: rows }, () =>
      Array.from({ length: cols - 1 }, () => (Math.random() < 0.5 ? 1 : -1))
    );

    const mesh = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        mesh.push({
          top: r === 0 ? 0 : -hEdges[r - 1][c],
          right: c === cols - 1 ? 0 : vEdges[r][c],
          bottom: r === rows - 1 ? 0 : hEdges[r][c],
          left: c === 0 ? 0 : -vEdges[r][c - 1],
        });
      }
    }
    return mesh;
  }

  function drawJigsawEdge(ctx, x1, y1, x2, y2, edgeVal) {
    if (edgeVal === 0) {
      ctx.lineTo(x2, y2);
      return;
    }
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy * edgeVal;
    const ny =  ux * edgeVal;

    const tabH = len * 0.22;

    const p = (t, n) => ({
      x: x1 + ux * (t * len) + nx * (n * tabH),
      y: y1 + uy * (t * len) + ny * (n * tabH),
    });

    const p35 = p(0.35, 0);
    const p38 = p(0.38, 0.05);
    const p42 = p(0.40, 0.35);
    const p44 = p(0.42, 0.85);
    const p56 = p(0.58, 0.85);
    const p58 = p(0.60, 0.35);
    const p62 = p(0.62, 0.05);
    const p65 = p(0.65, 0);

    ctx.lineTo(p35.x, p35.y);
    ctx.bezierCurveTo(p38.x, p38.y, p42.x, p42.y, p44.x, p44.y);
    ctx.bezierCurveTo(p(0.44, 1.18).x, p(0.44, 1.18).y, p(0.56, 1.18).x, p(0.56, 1.18).y, p56.x, p56.y);
    ctx.bezierCurveTo(p58.x, p58.y, p62.x, p62.y, p65.x, p65.y);
    ctx.lineTo(x2, y2);
  }

  function renderJigsawPieceCanvas(imgEl, r, c, rows, cols, w, h, edges) {
    const tabMargin = Math.ceil(Math.max(w, h) * 0.28);
    const cvW = Math.ceil(w + 2 * tabMargin);
    const cvH = Math.ceil(h + 2 * tabMargin);

    const cv = document.createElement('canvas');
    cv.width = cvW;
    cv.height = cvH;
    const ctx = cv.getContext('2d');

    const x0 = tabMargin;
    const y0 = tabMargin;
    const x1 = tabMargin + w;
    const y1 = tabMargin + h;

    ctx.beginPath();
    ctx.moveTo(x0, y0);
    drawJigsawEdge(ctx, x0, y0, x1, y0, edges.top);
    drawJigsawEdge(ctx, x1, y0, x1, y1, edges.right);
    drawJigsawEdge(ctx, x1, y1, x0, y1, edges.bottom);
    drawJigsawEdge(ctx, x0, y1, x0, y0, edges.left);
    ctx.closePath();

    ctx.save();
    ctx.clip();

    const origW = imgEl.naturalWidth || imgEl.width || 600;
    const origH = imgEl.naturalHeight || imgEl.height || 600;
    const cellW = origW / cols;
    const cellH = origH / rows;

    const srcX = c * cellW - (tabMargin / w) * cellW;
    const srcY = r * cellH - (tabMargin / h) * cellH;
    const srcW = (cvW / w) * cellW;
    const srcH = (cvH / h) * cellH;

    ctx.drawImage(imgEl, srcX, srcY, srcW, srcH, 0, 0, cvW, cvH);

    // 3D tactile bevel stroke
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.lineWidth = Math.max(1.8, w * 0.045);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = Math.max(1.0, w * 0.022);
    ctx.stroke();

    ctx.restore();

    return { dataUrl: cv.toDataURL(), cvW, cvH, tabMargin };
  }

  /* ================= menu ================= */
  function buildDifficulties() {
    const wrap = $('#difficultyOptions');
    if (!wrap) return;
    wrap.innerHTML = '';
    Object.entries(DIFFS).forEach(([key, d]) => {
      const b = document.createElement('button');
      b.className = 'diff-option' + (key === selDiff ? ' selected' : '');
      b.innerHTML = `<b>${d.label}</b><span>${d.cols}x${d.rows} (${d.rows * d.cols} pcs)</span>`;
      b.addEventListener('click', () => {
        selDiff = key;
        $$('.diff-option').forEach((o) => o.classList.remove('selected'));
        b.classList.add('selected');
        updateMenuBest();
        SFX.pick();
      });
      wrap.appendChild(b);
    });
  }

  function updateMenuBest() {
    const el = $('#menuBest');
    const best = getRanking()
      .filter((r) => r.diff === selDiff)
      .sort((a, b) => (b.score || 0) - (a.score || 0) || a.time - b.time)[0];
    if (best) {
      el.classList.remove('hidden');
      el.innerHTML = `Melhor em <b>${DIFFS[selDiff].label}</b>: <b>${(best.score || 0).toLocaleString('pt-BR')} PTS</b> (${fmtTime(best.time)}) — ${escapeHtml(best.name)}`;
    } else {
      el.classList.add('hidden');
    }
  }

  /* ================= game ================= */
  const boardEl = $('#board');
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
    $('#btnPause').classList.remove('paused');
    $('#btnSaveRecord').classList.remove('hidden');
    $('#btnViewRanking').classList.add('hidden');

    const chosenImg = images[Math.floor(Math.random() * images.length)];

    const d = DIFFS[selDiff];
    game = {
      imgSrc: chosenImg.src,
      imgName: chosenImg.name,
      rows: d.rows,
      cols: d.cols,
      total: d.rows * d.cols,
      pieceSize: 0,
      pieces: [],
      tray: [],
      cellsEl: [],
      mesh: generateJigsawMesh(d.rows, d.cols),
      score: 0,
      streak: 0,
      lockedCount: 0,
      finished: false,
    };

    updateScoreUI();
    createCells();

    const loadedImg = new Image();
    loadedImg.crossOrigin = 'anonymous';
    loadedImg.onload = () => {
      createPieces(loadedImg);
      measure();
      updateProgress();
      shuffleAndDeal();
      startTimer();
    };
    loadedImg.onerror = () => {
      createPieces(null);
      measure();
      updateProgress();
      shuffleAndDeal();
      startTimer();
    };
    loadedImg.src = game.imgSrc;
  }

  function updateScoreUI() {
    if (!game) return;
    const scoreBadge = $('#scoreDisplay');
    if (scoreBadge) {
      scoreBadge.textContent = `${game.score.toLocaleString('pt-BR')} PTS`;
    }
  }

  function updateProgress() {
    if (!game) return;
    const count = game.lockedCount;
    const total = game.total;
    const pct = Math.round((count / total) * 100);
    const fill = $('#progressFill');
    const text = $('#progressText');
    if (fill) fill.style.width = `${pct}%`;
    if (text) text.textContent = `${count} / ${total} (${pct}%)`;
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
      SFX.wrong();
      toast('Quadrado ocupado por peça travada');
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
    SFX.pick();
    updateCells();
  }

  function updateCells() {
    game.cellsEl.forEach((el, i) => {
      const hasLocked = game.pieces.some((p) => p.cell === i && p.locked);
      el.classList.toggle('ready', !!selected && !hasLocked);
      el.classList.toggle('busy', !!selected && hasLocked);
    });
  }

  function createPieces(loadedImg) {
    piecesLayerEl.innerHTML = '';
    game.pieces = [];
    const { rows, cols } = game;
    const total = rows * cols;
    const pieceW = boardEl.clientWidth / cols || 40;
    const pieceH = boardEl.clientHeight / rows || 40;

    for (let id = 0; id < total; id++) {
      const r = Math.floor(id / cols);
      const c = id % cols;
      const el = document.createElement('div');
      el.className = 'piece';

      let cvW = pieceW;
      let cvH = pieceH;
      let tabMargin = 0;

      if (loadedImg) {
        const rendered = renderJigsawPieceCanvas(
          loadedImg, r, c, rows, cols, pieceW, pieceH, game.mesh[id]
        );
        el.style.backgroundImage = `url("${rendered.dataUrl}")`;
        el.style.backgroundSize = '100% 100%';
        cvW = rendered.cvW;
        cvH = rendered.cvH;
        tabMargin = rendered.tabMargin;
      } else {
        el.style.backgroundImage = `url("${game.imgSrc}")`;
        el.style.backgroundSize = `${cols * 100}% ${rows * 100}%`;
        el.style.backgroundPosition = `${cols === 1 ? 0 : (c / (cols - 1)) * 100}% ${rows === 1 ? 0 : (r / (rows - 1)) * 100}%`;
      }

      const piece = {
        id,
        el,
        cvW,
        cvH,
        tabMargin,
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

    const { rows, cols } = game;
    const pieceW = game.pieceSize;
    const pieceH = game.pieceSize;

    game.pieces.forEach((p) => {
      const tabMargin = Math.ceil(Math.max(pieceW, pieceH) * 0.28);
      p.cvW = Math.ceil(pieceW + 2 * tabMargin);
      p.cvH = Math.ceil(pieceH + 2 * tabMargin);
      p.tabMargin = tabMargin;
      p.el.style.width = p.cvW + 'px';
      p.el.style.height = p.cvH + 'px';
    });

    trayInnerEl.style.height = `${game.pieceSize * 1.5 + 20}px`;
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
    const gap = 12;
    const y = tr.top + tr.height / 2;
    const x = tr.left + 20 + index * (size * 1.2 + gap) + (size * 1.2) / 2 - trayInnerEl.scrollLeft;
    return { x, y };
  }

  function applyTransform(piece, x, y, rot = 0, scale = 1) {
    const sizeW = piece.cvW || game.pieceSize;
    const sizeH = piece.cvH || game.pieceSize;
    piece.el.style.setProperty('--px', `${x - sizeW / 2}px`);
    piece.el.style.setProperty('--py', `${y - sizeH / 2}px`);
    piece.el.style.setProperty('--rot', `${rot}deg`);
    piece.el.style.setProperty('--scale', scale);
  }

  function relayout() {
    if (!game) return;
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

  /* ---------- drag & drop with finger offset ---------- */
  function onPointerDown(e, piece) {
    if (!game || game.finished || paused) return;
    if (piece.locked) return;
    e.preventDefault();
    
    const isTouch = e.pointerType === 'touch' || e.pointerType === 'pen';
    const fingerOffsetY = isTouch ? 55 : 0;

    const rect = piece.el.getBoundingClientRect();
    dragging = {
      piece,
      dx: e.clientX - (rect.left + rect.width / 2),
      dy: e.clientY - (rect.top + rect.height / 2) + fingerOffsetY,
      fingerOffsetY,
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
    if (!d) return;
    if (!d.moved && Math.hypot(x - d.startX, y - d.startY) > 5) {
      d.moved = true;
      clearSelection();
    }
    if (d.moved) {
      const targetY = y - d.dy;
      const targetX = x - d.dx;
      applyTransform(d.piece, targetX, targetY, 0, 1.12);
      checkMagnetHighlight(targetX, targetY);
    }
  }

  function checkMagnetHighlight(x, y) {
    if (!game) return;
    const { cols, rows, pieceSize } = game;
    let closestCell = -1;
    let minDist = pieceSize * 0.75;

    for (let i = 0; i < game.total; i++) {
      const center = boardCellCenter(i);
      const dist = Math.hypot(x - center.x, y - center.y);
      if (dist < minDist) {
        minDist = dist;
        closestCell = i;
      }
    }

    game.cellsEl.forEach((cellEl, idx) => {
      const isMagnet = idx === closestCell && !game.pieces.some(p => p.cell === idx && p.locked);
      cellEl.classList.toggle('magnet-highlight', isMagnet);
    });
  }

  function clearMagnetHighlights() {
    if (game && game.cellsEl) {
      game.cellsEl.forEach(el => el.classList.remove('magnet-highlight'));
    }
  }

  function onPointerUp() {
    if (!dragging) return;
    const { piece, moved } = dragging;
    piece.el.classList.remove('dragging');
    clearMagnetHighlights();
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
      x >= boardRect.left - pieceSize * 0.4 &&
      x <= boardRect.right + pieceSize * 0.4 &&
      y >= boardRect.top - pieceSize * 0.4 &&
      y <= boardRect.bottom + pieceSize * 0.4;

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
    const oldCell = piece.cell; // Célula anterior da peça (ou -1 se veio da bandeja)
    const occupant = game.pieces.find((p) => p.cell === cell && p !== piece);

    if (occupant) {
      if (occupant.locked) return false;

      // Troca de posição (Swap):
      if (oldCell >= 0) {
        // Se a peça veio de outra célula do tabuleiro, a ocupante vai para a célula antiga!
        occupant.cell = oldCell;
        occupant.inTray = false;
        removeFromTray(occupant);

        // Se a peça trocada por acaso estiver certa na posição antiga, ela trava!
        if (occupant.id === oldCell) {
          lockPiece(occupant, oldCell);
        }
      } else {
        // Se veio da bandeja, a peça ocupante volta para a bandeja
        occupant.cell = -1;
        occupant.inTray = true;
        if (game.tray.indexOf(occupant) === -1) game.tray.push(occupant);
      }
    }

    piece.cell = cell;
    piece.inTray = false;
    removeFromTray(piece);

    if (piece.id === cell) {
      lockPiece(piece, cell);
    } else {
      SFX.wrong();
      haptic(50);
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

  /* ---------- Lock piece & calculate score ---------- */
  function lockPiece(piece, cell) {
    piece.locked = true;
    piece.el.classList.add('locked');
    game.lockedCount++;

    const { rows, cols } = game;
    const r = Math.floor(cell / cols);
    const c = cell % cols;

    // Check adjacent neighbor cells (Top, Right, Bottom, Left)
    const neighborIndices = [
      r > 0 ? (r - 1) * cols + c : -1,         // Top neighbor
      c < cols - 1 ? r * cols + (c + 1) : -1,   // Right neighbor
      r < rows - 1 ? (r + 1) * cols + c : -1,   // Bottom neighbor
      c > 0 ? r * cols + (c - 1) : -1,         // Left neighbor
    ];

    let neighborCount = 0;
    neighborIndices.forEach((nIdx) => {
      if (nIdx >= 0) {
        const neighborPiece = game.pieces.find(p => p.cell === nIdx && p.locked);
        if (neighborPiece) neighborCount++;
      }
    });

    game.streak = (game.streak || 0) + 1;
    const basePts = 100;
    const neighborBonus = neighborCount * 50;
    const streakBonus = (game.streak - 1) * 25;
    const addedPoints = basePts + neighborBonus + streakBonus;

    game.score = (game.score || 0) + addedPoints;
    updateScoreUI();
    updateProgress();

    SFX.lock(game.streak, neighborCount);
    haptic([30, 40, 30]);

    const center = boardCellCenter(cell);
    spawnFloatingScore(center.x, center.y, addedPoints, neighborCount, game.streak);
    applyTransform(piece, center.x, center.y, 0, 1);

    if (game.lockedCount === game.total) finishGame();
  }

  function spawnFloatingScore(x, y, points, neighborCount, streak) {
    const stage = $('.game-stage');
    if (!stage) return;
    const stageRect = stage.getBoundingClientRect();
    const relX = x - stageRect.left;
    const relY = y - stageRect.top;

    const el = document.createElement('div');
    el.className = 'floating-score' + (neighborCount > 0 ? ' combo-bonus' : '');
    el.style.left = `${relX}px`;
    el.style.top = `${relY}px`;

    let label = `+${points}`;
    if (neighborCount === 1) label += ' PAR! 🧩';
    else if (neighborCount >= 2) label += ` COMBO x${neighborCount}! 🔥`;
    else if (streak > 2) label += ` STREAK x${streak}! ⭐`;

    el.textContent = label;
    stage.appendChild(el);

    setTimeout(() => el.remove(), 850);
  }

  function finishGame() {
    game.finished = true;
    stopTimer();
    SFX.win();
    haptic([80, 50, 80, 50, 120]);

    const finalMs = timer.elapsedMs;
    const finalScore = game.score;

    setTimeout(() => {
      $('#winTime').textContent = fmtTime(finalMs);
      const winScoreEl = $('#winScore');
      if (winScoreEl) winScoreEl.textContent = `${finalScore.toLocaleString('pt-BR')} PTS`;
      $('#winInfo').textContent = `${DIFFS[selDiff].label} (${game.cols}x${game.rows} - ${game.total} pcs) — ${game.imgName}`;
      $('#playerName').value = getPlayerName();
      $('#btnViewRanking').classList.add('hidden');
      $('#winOverlay').classList.remove('hidden');
      startConfetti();
    }, 400);
  }

  /* ---------- pointer events on layer ---------- */
  piecesLayerEl.addEventListener('pointermove', (e) => {
    if (dragging) moveDragged(e.clientX, e.clientY);
  });
  piecesLayerEl.addEventListener('pointerup', onPointerUp);
  piecesLayerEl.addEventListener('pointercancel', onPointerUp);

  trayInnerEl.addEventListener('scroll', () => {
    if (game) relayout();
  });

  window.addEventListener('resize', () => {
    if (game) relayout();
  });

  /* ---------- sound toggle ---------- */
  $('#btnSound').addEventListener('click', () => {
    soundOn = !soundOn;
    localStorage.setItem('qpc_sound', soundOn ? '1' : '0');
    updateSoundUI();
    if (soundOn) SFX.pick();
  });

  /* ---------- win actions ---------- */
  $('#btnSaveRecord').addEventListener('click', () => {
    const name = ($('#playerName').value.trim() || 'Jogador').slice(0, 20);
    localStorage.setItem(NAME_KEY, name);
    const rec = {
      name,
      time: timer.elapsedMs,
      score: game.score,
      diff: selDiff,
      img: game.imgName,
      date: Date.now()
    };
    const list = getRanking();
    list.push(rec);
    list.sort((a, b) => (b.score || 0) - (a.score || 0) || a.time - b.time);
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
    if (!wrap) return;
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
        SFX.pick();
      });
      wrap.appendChild(b);
    });
  }

  function renderRanking() {
    const list = getRanking()
      .filter((r) => rankFilter === 'todos' || r.diff === rankFilter)
      .sort((a, b) => (b.score || 0) - (a.score || 0) || a.time - b.time)
      .slice(0, 10);

    const wrap = $('#rankList');
    wrap.innerHTML = '';
    $('#rankEmpty').classList.toggle('hidden', list.length > 0);

    list.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'rank-row' + (i < 3 ? ` top${i + 1}` : '');
      const d = new Date(r.date);
      const scoreTxt = r.score ? `${r.score.toLocaleString('pt-BR')} PTS` : fmtTime(r.time);
      row.innerHTML = `
        <div class="rank-pos">${i + 1}</div>
        <div class="rank-name">${escapeHtml(r.name)}</div>
        <div class="rank-meta">
          <div class="rank-time">${scoreTxt}</div>
          <span class="rank-chip">${DIFFS[r.diff]?.label || r.diff} · ${fmtTime(r.time)}</span>
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
    showScreen('screen-game');
    newGame();
  });

  $('#btnRanking').addEventListener('click', () => {
    showScreen('screen-ranking');
    renderRanking();
  });

  $('#btnRankBack').addEventListener('click', () => showScreen('screen-menu'));
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
    if (game && game.finished) return;
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

  /* ================= fullscreen toggle ================= */
  const btnFS = $('#btnFullscreen');
  if (btnFS) {
    btnFS.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    });
  }

  /* ================= install gate (PWA) ================= */
  let deferredPrompt = null;
  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    window.navigator.standalone === true;
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);

  function isInstalled() {
    return isStandalone || localStorage.getItem('qpc_installed') === '1';
  }

  function initInstallGate() {
    const screen = $('#installScreen');
    const btnInstall = $('#btnInstall');
    const iosBox = $('#installIos');
    const fallback = $('#installFallback');
    const btnClose = $('#btnCloseInstall');
    const btnPlayAnyway = $('#btnPlayAnyway');

    const dismissScreen = () => {
      if (screen) screen.classList.add('hidden');
    };

    if (btnClose) btnClose.addEventListener('click', dismissScreen);
    if (btnPlayAnyway) btnPlayAnyway.addEventListener('click', dismissScreen);

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      if (btnInstall) {
        btnInstall.disabled = false;
        btnInstall.textContent = 'Instalar agora';
      }
    });

    window.addEventListener('appinstalled', () => {
      localStorage.setItem('qpc_installed', '1');
      dismissScreen();
      toast('App Instalado com Sucesso!');
    });

    if (btnInstall) {
      btnInstall.addEventListener('click', () => {
        if (deferredPrompt) {
          deferredPrompt.prompt();
          deferredPrompt.userChoice.then((choice) => {
            if (choice.outcome === 'accepted') {
              localStorage.setItem('qpc_installed', '1');
              dismissScreen();
              toast('Instalado! Jogo em tela cheia');
            }
          });
        } else if (isIOS) {
          if (iosBox) iosBox.classList.remove('hidden');
        } else {
          if (fallback) fallback.classList.remove('hidden');
        }
      });
    }

    const btnInstallApp = $('#btnInstallApp');
    if (btnInstallApp) {
      btnInstallApp.addEventListener('click', () => {
        if (deferredPrompt) {
          deferredPrompt.prompt();
          deferredPrompt.userChoice.then((choice) => {
            if (choice.outcome === 'accepted') {
              localStorage.setItem('qpc_installed', '1');
              toast('Instalado! Abra pelo ícone na tela inicial');
            }
          });
        } else {
          if (screen) screen.classList.remove('hidden');
        }
      });
    }
  }

  function clearAppCache() {
    if ('caches' in window) {
      caches.keys().then((keys) => {
        keys.forEach((key) => {
          caches.delete(key);
        });
      }).catch(() => {});
    }
  }

  /* ================= init ================= */
  clearAppCache();
  updateSoundUI();
  buildDifficulties();
  buildRankFilters();
  initInstallGate();

  images = generateFallbackArtworks();
  updateMenuBest();

  discoverImages().then((found) => {
    if (found && found.length > 0) {
      const localOnly = found.filter(f => !f.id.startsWith('art-'));
      if (localOnly.length > 0) {
        images = [...localOnly, ...generateFallbackArtworks()];
        updateMenuBest();
      }
    }
  }).catch(() => {});
})();
