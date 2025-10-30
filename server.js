import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import fs from 'fs';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static('public'));

const { customAlphabet } = await import('nanoid');
const nanoid = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);

const questions = JSON.parse(fs.readFileSync('./questions.json', 'utf8'));
const rooms = new Map();

const now = () => Date.now();
const safeRoom = (roomId) => rooms.get(roomId);
const toLower = (s) => (s ?? '').toString().trim().toLowerCase();

function calcScore(sentAt, answeredAt) {
  const elapsed = Math.max(0, answeredAt - sentAt);
  const raw = 1000 - Math.floor(elapsed / 10);
  return Math.max(200, raw);
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name }, cb) => {
    const roomId = nanoid();
    rooms.set(roomId, {
      hostId: socket.id,
      players: new Map([[socket.id, { name: name?.trim() || 'Host', score: 0 }]]),
      status: 'lobby',
      qIndex: 0,
      startedAt: null,
      lock: {},
      timers: {},
    });
    socket.join(roomId);
    cb?.({ roomId, isHost: true, players: serializePlayers(roomId) });
    io.to(roomId).emit('lobbyUpdate', { players: serializePlayers(roomId) });
  });

  socket.on('joinRoom', ({ roomId, name }, cb) => {
    const room = safeRoom(roomId);
    if (!room) return cb?.({ error: 'ルームが見つかりません。' });
    if (room.status !== 'lobby') return cb?.({ error: 'ゲームは既に開始済みです。' });
    socket.join(roomId);
    room.players.set(socket.id, { name: name?.trim() || 'Player', score: 0 });
    cb?.({ ok: true, isHost: socket.id === room.hostId, players: serializePlayers(roomId) });
    io.to(roomId).emit('lobbyUpdate', { players: serializePlayers(roomId) });
  });

  socket.on('startGame', ({ roomId }, cb) => {
    const room = safeRoom(roomId);
    if (!room) return cb?.({ error: 'ルームが見つかりません。' });
    if (socket.id !== room.hostId) return cb?.({ error: '開始できるのはホストだけです。' });
    room.status = 'in_game';
    room.qIndex = 0;
    room.startedAt = now();
    resetPerQuestionFlags(roomId);
    sendCurrentQuestion(roomId);
    cb?.({ ok: true });
  });

  socket.on('answerMCQ', ({ roomId, choiceIndex }, cb) => {
    const room = safeRoom(roomId);
    if (!room || room.status !== 'in_game') return cb?.({ error: '無効な状態です。' });
    const q = questions[room.qIndex];
    if (!q || q.type !== 'mcq') return cb?.({ error: '現在は4択問題ではありません。' });
    socket.data.answered ??= false;
    if (socket.data.answered) return cb?.({ error: 'すでに回答済みです。' });
    socket.data.answered = true;
    const answeredAt = now();
    const correct = Number(choiceIndex) === q.data.correctIndex;
    let gained = 0;
    if (correct) {
      gained = calcScore(room.timers.sentAt, answeredAt);
      const p = room.players.get(socket.id);
      if (p) p.score += gained;
    }
    cb?.({ ok: true, correct, gained });
  });

  socket.on('answerOrder', ({ roomId, order }, cb) => {
    const room = safeRoom(roomId);
    if (!room || room.status !== 'in_game') return cb?.({ error: '無効な状態です。' });
    const q = questions[room.qIndex];
    if (!q || q.type !== 'order') return cb?.({ error: '現在は並び替え問題ではありません。' });
    socket.data.answered ??= false;
    if (socket.data.answered) return cb?.({ error: 'すでに回答済みです。' });
    socket.data.answered = true;
    const answeredAt = now();
    const correctOrder = q.data.answer;
    let correctCount = 0;
    for (let i = 0; i < correctOrder.length; i++) {
      if (Number(order[i]) === Number(correctOrder[i])) correctCount++;
    }
    const ratio = correctCount / correctOrder.length;
    let gained = Math.round(calcScore(room.timers.sentAt, answeredAt) * ratio);
    if (ratio === 0) gained = 0;
    const p = room.players.get(socket.id);
    if (p && gained > 0) p.score += gained;
    cb?.({ ok: true, correctCount, total: correctOrder.length, gained });
  });

  socket.on('buzz', ({ roomId }, cb) => {
    const room = safeRoom(roomId);
    if (!room || room.status !== 'in_game') return cb?.({ error: '無効な状態です。' });
    const q = questions[room.qIndex];
    if (!q || q.type !== 'video-buzz') return cb?.({ error: '現在は映像早押しではありません。' });
    room.lock ??= {};
    if (room.lock.buzzerId) return cb?.({ ok: false, lockedBy: room.lock.buzzerId });
    room.lock.buzzerId = socket.id;
    const player = room.players.get(socket.id);
    io.to(roomId).emit('buzzLocked', { buzzerId: socket.id, name: player?.name || 'Player' });
    cb?.({ ok: true, youAreBuzzer: true });
  });

  socket.on('submitBuzzAnswer', ({ roomId, answer }, cb) => {
    const room = safeRoom(roomId);
    if (!room || room.status !== 'in_game') return cb?.({ error: '無効な状態です。' });
    const q = questions[room.qIndex];
    if (!q || q.type !== 'video-buzz') return cb?.({ error: '現在は映像早押しではありません。' });
    if (!room.lock?.buzzerId) return cb?.({ error: 'まだ誰も早押ししていません。' });
    if (socket.id !== room.lock.buzzerId) return cb?.({ error: 'あなたには解答権がありません。' });
    const acceptable = (q.data.answers || []).map(toLower);
    const userAns = toLower(answer);
    const correct = acceptable.includes(userAns);
    const answeredAt = now();
    let gained = 0;
    if (correct) {
      gained = Math.max(250, calcScore(room.timers.sentAt, answeredAt) + 200);
      const p = room.players.get(socket.id);
      if (p) p.score += gained;
    }
    io.to(roomId).emit('buzzResult', {
      buzzerId: socket.id,
      name: room.players.get(socket.id)?.name || 'Player',
      correct,
      gained
    });
    cb?.({ ok: true, correct, gained });
  });

  socket.on('nextQuestion', ({ roomId }, cb) => {
    const room = safeRoom(roomId);
    if (!room) return cb?.({ error: 'ルームが見つかりません。' });
    if (socket.id !== room.hostId) return cb?.({ error: 'ホストのみ操作できます。' });
    room.qIndex += 1;
    if (room.qIndex >= questions.length) {
      room.status = 'finished';
      io.to(roomId).emit('gameFinished', { leaderboard: serializePlayers(roomId, true) });
      return cb?.({ ok: true, finished: true });
    }
    resetPerQuestionFlags(roomId);
    sendCurrentQuestion(roomId);
    cb?.({ ok: true });
  });

  socket.on('disconnect', () => {
    for (const [roomId, room] of rooms.entries()) {
      if (room.players.has(socket.id)) {
        room.players.delete(socket.id);
        io.to(roomId).emit('lobbyUpdate', { players: serializePlayers(roomId) });
        if (room.players.size === 0) rooms.delete(roomId);
        break;
      }
    }
  });
});

function serializePlayers(roomId, sort = false) {
  const room = safeRoom(roomId);
  if (!room) return [];
  const arr = [...room.players.entries()].map(([id, p]) => ({
    id, name: p.name, score: p.score, isHost: id === room.hostId
  }));
  if (sort) arr.sort((a, b) => b.score - a.score);
  return arr;
}

function resetPerQuestionFlags(roomId) {
  const room = safeRoom(roomId);
  if (!room) return;
  room.lock = {};
  for (const [sid] of room.players) {
    const sock = io.sockets.sockets.get(sid);
    if (sock) sock.data.answered = false;
  }
}

function sendCurrentQuestion(roomId) {
  const room = safeRoom(roomId);
  if (!room) return;
  const q = questions[room.qIndex];
  if (!q) return;
  const timeLimitMs = (q.timeLimitSec ?? 15) * 1000;
  const sentAt = now() + 800;
  room.timers.sentAt = sentAt;
  io.to(roomId).emit('question', {
    index: room.qIndex + 1,
    total: questions.length,
    type: q.type,
    payload: {
      prompt: q.data.prompt,
      choices: q.type === 'mcq' ? q.data.choices : undefined,
      items: q.type === 'order' ? q.data.items : undefined,
      videoSrc: q.type === 'video-buzz' ? q.data.videoSrc : undefined,
      buzzHint: q.type === 'video-buzz' ? (q.data.buzzHint || '分かったら早押し！') : undefined
    },
    timeLimitMs,
    serverStartAt: sentAt
  });
  clearTimeout(room.timers.endQ);
  room.timers.endQ = setTimeout(() => {
    const leaderboard = serializePlayers(roomId, true);
    const revealPayload =
      q.type === 'mcq'
        ? { correctIndex: q.data.correctIndex }
        : q.type === 'order'
        ? { correctOrder: q.data.answer }
        : q.type === 'video-buzz'
        ? { correctText: q.data.revealText || (q.data.answers?.[0] ?? '') }
        : {};
    io.to(roomId).emit('reveal', { ...revealPayload, leaderboard });
  }, timeLimitMs + 1000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Quiz app running on http://localhost:' + PORT));
