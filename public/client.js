const $ = (q) => document.querySelector(q);
const $list = (q) => document.querySelectorAll(q);

const socket = io();
let state = {
  roomId: null,
  isHost: false,
  lastQuestion: null,
  answerLocked: false,
  countdown: null,
  buzz: { lockedBy: null, youAreBuzzer: false }
};

// UI helpers
function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }
function setText(id, t) { $(id).textContent = t; }
function clearChildren(el) { while (el.firstChild) el.removeChild(el.firstChild); }

$('#createBtn').onclick = () => {
  const name = $('#hostName').value || 'Host';
  socket.emit('createRoom', { name }, (res) => {
    if (res?.roomId) enterLobby(res.roomId, true, res.players);
    else alert(res?.error || '作成に失敗しました');
  });
};

$('#joinBtn').onclick = () => {
  const name = $('#joinName').value || 'Player';
  const roomId = ($('#roomId').value || '').toUpperCase().trim();
  socket.emit('joinRoom', { roomId, name }, (res) => {
    if (res?.ok) enterLobby(roomId, res.isHost, res.players);
    else alert(res?.error || '参加に失敗しました');
  });
};

$('#startBtn').onclick = () => {
  socket.emit('startGame', { roomId: state.roomId }, (res) => {
    if (res?.error) alert(res.error);
  });
};

$('#nextBtn').onclick = () => {
  socket.emit('nextQuestion', { roomId: state.roomId }, (res) => {
    if (res?.error) alert(res.error);
  });
};

function enterLobby(roomId, isHost, players) {
  state.roomId = roomId;
  state.isHost = isHost;
  hide('#setup'); show('#lobby');
  setText('#labelRoomId', roomId);
  setText('#shareUrl', `${location.origin}?room=${roomId}`);
  $('#startBtn').classList.toggle('hidden', !isHost);
  renderPlayers(players);
}

function renderPlayers(players) {
  const ul = $('#playerList');
  clearChildren(ul);
  players.forEach(p => {
    const li = document.createElement('li');
    li.textContent = `${p.name} ${p.isHost ? '👑' : ''} — ${p.score}`;
    ul.appendChild(li);
  });
}

// ソケットイベント
socket.on('lobbyUpdate', ({ players }) => {
  if ($('#lobby').classList.contains('hidden')) return;
  renderPlayers(players);
});

socket.on('hostChanged', () => { /* 表示のみ */ });

socket.on('question', (q) => {
  state.lastQuestion = q;
  state.answerLocked = false;

  hide('#lobby'); show('#game');
  $('#nextBtn').classList.add('hidden');
  $('#reveal').classList.add('hidden');
  clearChildren($('#choices'));
  $('#choices').classList.remove('order-mode', 'video-mode');

  setText('#progress', `Q${q.index}/${q.total}`);
  setText('#prompt', q.payload.prompt);

  // 4択
  if (q.type === 'mcq' && Array.isArray(q.payload.choices)) {
    q.payload.choices.forEach((c, i) => {
      const btn = document.createElement('button');
      btn.className = 'choice';
      btn.textContent = c;
      btn.onclick = () => answerMCQ(i);
      $('#choices').appendChild(btn);
    });
  }

  // 並び替え
  if (q.type === 'order' && Array.isArray(q.payload.items)) {
    $('#choices').classList.add('order-mode');
    const list = document.createElement('ul');
    list.className = 'order-list';
    q.payload.items.forEach((text, originalIdx) => {
      const li = document.createElement('li');
      li.className = 'order-item';
      li.draggable = true;
      li.dataset.idx = String(originalIdx); // 元インデックス
      li.innerHTML = `<span class="grip">≡</span><span class="label">${text}</span>`;
      list.appendChild(li);
    });
    $('#choices').appendChild(list);

    // DnD handlers
    let dragging = null;
    list.addEventListener('dragstart', (e) => {
      const target = e.target.closest('.order-item');
      if (target) { dragging = target; target.classList.add('dragging'); }
    });
    list.addEventListener('dragend', () => { if (dragging) dragging.classList.remove('dragging'); dragging = null; });
    list.addEventListener('dragover', (e) => {
      e.preventDefault();
      const after = getDragAfterElement(list, e.clientY);
      if (!dragging) return;
      if (after == null) list.appendChild(dragging);
      else list.insertBefore(dragging, after);
    });

    // 確定ボタン
    const submit = document.createElement('button');
    submit.textContent = 'この順で確定';
    submit.onclick = () => answerOrder();
    $('#choices').appendChild(submit);
  }

  // 映像早押し
  if (q.type === 'video-buzz' && q.payload.videoSrc) {
    $('#choices').classList.add('video-mode');
    state.buzz = { lockedBy: null, youAreBuzzer: false };

    const box = document.createElement('div');
    box.className = 'video-box';

    const video = document.createElement('video');
    video.src = q.payload.videoSrc;
    video.setAttribute('playsinline', 'true');
    video.muted = true;          // モバイル初回自動再生のため
    video.autoplay = true;
    video.controls = true;
    box.appendChild(video);

    const hint = document.createElement('div');
    hint.className = 'buzz-hint';
    hint.textContent = q.payload.buzzHint || '分かったら早押し！';
    box.appendChild(hint);

    const ctrl = document.createElement('div');
    ctrl.className = 'buzz-ctrl';
    const buzzBtn = document.createElement('button');
    buzzBtn.textContent = '🔴 早押しする';
    buzzBtn.onclick = () => {
      socket.emit('buzz', { roomId: state.roomId }, (res) => {
        if (res?.error) return alert(res.error);
        if (res?.ok && res.youAreBuzzer) {
          state.buzz.youAreBuzzer = true;
          showAnswerInput();
        }
      });
    };
    ctrl.appendChild(buzzBtn);
    box.appendChild(ctrl);
    $('#choices').appendChild(box);

    function showAnswerInput() {
      ctrl.innerHTML = '';
      const inp = document.createElement('input');
      inp.placeholder = '解答を入力';
      const submit = document.createElement('button');
      submit.textContent = '送信';
      submit.onclick = () => {
        submit.disabled = true;
        socket.emit('submitBuzzAnswer', { roomId: state.roomId, answer: inp.value || '' }, (res) => {
          if (res?.error) alert(res.error);
        });
      };
      ctrl.appendChild(inp);
      ctrl.appendChild(submit);
      inp.focus();
    }
  }

  // 同期タイマー
  if (state.countdown) clearInterval(state.countdown);
  const startAt = q.serverStartAt;
  const endAt = startAt + q.timeLimitMs;

  state.countdown = setInterval(() => {
    const t = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
    setText('#timer', String(t));
    if (Date.now() >= endAt) {
      clearInterval(state.countdown);
      lockAnswers();
    }
  }, 100);
});

socket.on('reveal', ({ correctIndex, leaderboard }) => {
  $('#reveal').classList.remove('hidden');
  const rev = $('#reveal');
  // 4択
  if (typeof correctIndex === 'number') {
    rev.textContent = `正解は：選択肢 ${correctIndex + 1}`;
    highlightCorrect(correctIndex);
  }
  // 並び替え
  else if (Array.isArray(arguments[0]?.correctOrder)) {
    const correctOrder = arguments[0].correctOrder;
    rev.textContent = '正解順：';
    const ul = document.createElement('ol');
    ul.className = 'order-answer';
    const items = state.lastQuestion?.payload?.items || [];
    correctOrder.forEach((origIdx) => {
      const li = document.createElement('li');
      li.textContent = items[Number(origIdx)];
      ul.appendChild(li);
    });
    rev.appendChild(ul);
  }
  // 映像早押し
  else if (typeof arguments[0]?.correctText === 'string') {
    const text = arguments[0].correctText;
    rev.innerHTML = '';
    const p = document.createElement('p');
    p.textContent = `正解：${text}`;
    rev.appendChild(p);
  }
  renderLeaderboard(leaderboard);
  if (state.isHost) $('#nextBtn').classList.remove('hidden');
});

// 早押しロック通知
socket.on('buzzLocked', ({ buzzerId, name }) => {
  state.buzz.lockedBy = buzzerId;
  const ctrl = document.querySelector('.buzz-ctrl');
  if (ctrl) {
    ctrl.querySelectorAll('button').forEach(b => b.disabled = true);
    const tag = document.createElement('div');
    tag.className = 'buzz-locked';
    tag.textContent = `🛎️ ${name} さんが解答中…`;
    ctrl.appendChild(tag);
  }
});

// 早押しの判定結果
socket.on('buzzResult', ({ name, correct, gained }) => {
  toast(`${name}：${correct ? '正解！' : '不正解…'} ${correct ? `+${gained}点` : ''}`);
});

socket.on('gameFinished', ({ leaderboard }) => {
  $('#reveal').classList.remove('hidden');
  $('#nextBtn').classList.add('hidden');
  $('#reveal').textContent = 'ゲーム終了！最終結果：';
  renderLeaderboard(leaderboard);
});

function answerMCQ(choiceIndex) {
  if (state.answerLocked) return;
  lockAnswers();
  socket.emit('answerMCQ', { roomId: state.roomId, choiceIndex }, (res) => {
    if (res?.error) alert(res.error);
    if (res?.ok) toast(res.correct ? `正解！ +${res.gained}点` : 'はずれ…');
  });
}

function answerOrder() {
  if (state.answerLocked) return;
  const list = $('.order-list');
  if (!list) return;
  const order = [...list.querySelectorAll('.order-item')].map(li => Number(li.dataset.idx));
  lockAnswers();
  socket.emit('answerOrder', { roomId: state.roomId, order }, (res) => {
    if (res?.error) alert(res.error);
    if (res?.ok) {
      const { correctCount, total, gained } = res;
      toast(`一致 ${correctCount}/${total} 個 +${gained}点`);
    }
  });
}

function lockAnswers() {
  state.answerLocked = true;
  $list('.choice').forEach(b => b.disabled = true);
  const btn = $('#choices button');
  if (btn) btn.disabled = true;
  const list = $('.order-list');
  if (list) list.classList.add('locked');
}

function highlightCorrect(idx) {
  $list('.choice').forEach((b, i) => b.classList.toggle('correct', i === idx));
}

function renderLeaderboard(players) {
  const box = $('#leaderboard');
  clearChildren(box);
  const title = document.createElement('h3');
  title.textContent = 'Leaderboard';
  box.appendChild(title);
  const ol = document.createElement('ol');
  players.forEach(p => {
    const li = document.createElement('li');
    li.textContent = `${p.name} — ${p.score}`;
    ol.appendChild(li);
  });
  box.appendChild(ol);
}

function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1500);
}

// DnD 補助
function getDragAfterElement(container, y) {
  const els = [...container.querySelectorAll('.order-item:not(.dragging)')];
  return els
    .map(el => {
      const rect = el.getBoundingClientRect();
      return { el, offset: y - rect.top - rect.height / 2 };
    })
    .filter(x => x.offset < 0)
    .sort((a, b) => b.offset - a.offset)[0]?.el || null;
}

// 共有URLから自動補完
window.addEventListener('DOMContentLoaded', () => {
  const url = new URL(location.href);
  const room = url.searchParams.get('room');
  if (room) $('#roomId').value = room;
});
