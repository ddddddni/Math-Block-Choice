const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: "*", methods: ["GET","POST"] }
});

app.use(cors());
app.get('/', (req, res) => res.send('Math Block Server ✅ ทำงานอยู่'));

// ── เก็บข้อมูลห้องทั้งหมด ──
const rooms = {};

// ── HELPER ──
function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function rnd(a, b) {
  return Math.floor(Math.random() * (b - a + 1)) + a;
}

function generateQuestion(difficulty) {
  const ops =
    difficulty === 'hard'   ? ['+', '-', '×', '÷'] :
    difficulty === 'normal' ? ['+', '-', '×'] :
                              ['+', '-'];
  const op = ops[Math.floor(Math.random() * ops.length)];
  let a, b, ans;

  if (op === '+') { a = rnd(1,30); b = rnd(1,30); ans = a + b; }
  else if (op === '-') { a = rnd(10,40); b = rnd(1,a); ans = a - b; }
  else if (op === '×') { a = rnd(2,12);  b = rnd(2,12); ans = a * b; }
  else { b = rnd(2,9); ans = rnd(2,9); a = b * ans; }

  const wrong = new Set();
  while (wrong.size < 3) {
    const w = ans + rnd(-10, 10);
    if (w !== ans && w >= 0) wrong.add(w);
  }
  const choices = [...wrong, ans].sort(() => Math.random() - 0.5);
  return { text: `${a} ${op} ${b}`, answer: ans, choices };
}

function generateQuestions(difficulty, count) {
  return Array.from({ length: count }, () => generateQuestion(difficulty));
}

// ── LOG ──
function log(msg) {
  const t = new Date().toLocaleTimeString('th-TH');
  console.log(`[${t}] ${msg}`);
}

// ────────────────────────────────────────────────
// SOCKET.IO
// ────────────────────────────────────────────────
io.on('connection', (socket) => {
  log(`เชื่อมต่อ: ${socket.id}`);

  // ── สร้างห้อง ──────────────────────────────────
  socket.on('createRoom', ({ playerName, difficulty, maxQ, mode }) => {
    let code;
    do { code = makeCode(); } while (rooms[code]); // กันรหัสซ้ำ

    rooms[code] = {
      code,
      host:       socket.id,
      mode:       mode || 'group',   // '1v1' | 'group'
      difficulty: difficulty || 'normal',
      maxQ:       maxQ || 10,
      players:    {},
      status:     'waiting',
      questions:  [],
      currentQ:   0,
      finishedPlayers: 0,
    };

    // เพิ่ม host เป็นผู้เล่นคนแรก
    rooms[code].players[socket.id] = {
      id: socket.id, name: playerName || 'ผู้เล่น',
      score: 0, heart: 3, answers: [], joinedAt: Date.now()
    };

    socket.join(code);
    socket.emit('roomCreated', { code, room: safeRoom(rooms[code]) });
    log(`สร้างห้อง ${code} โดย ${playerName}`);
  });

  // ── เข้าห้อง ───────────────────────────────────
  socket.on('joinRoom', ({ code, playerName }) => {
    const room = rooms[code];
    if (!room)                                    return socket.emit('roomError', 'ไม่พบห้องรหัส ' + code);
    if (room.status !== 'waiting')                return socket.emit('roomError', 'เกมเริ่มไปแล้ว');
    if (Object.keys(room.players).length >= 8)    return socket.emit('roomError', 'ห้องเต็ม (สูงสุด 8 คน)');

    room.players[socket.id] = {
      id: socket.id, name: playerName || 'ผู้เล่น',
      score: 0, heart: 3, answers: [], joinedAt: Date.now()
    };

    socket.join(code);
    socket.emit('roomJoined', { code, room: safeRoom(room) });
    io.to(code).emit('playersUpdated', { players: room.players });
    log(`${playerName} เข้าห้อง ${code}`);
  });

  // ── เริ่มเกม (เฉพาะ host) ──────────────────────
  socket.on('startGame', ({ code }) => {
    const room = rooms[code];
    if (!room)                      return socket.emit('roomError', 'ไม่พบห้อง');
    if (room.host !== socket.id)    return socket.emit('roomError', 'เฉพาะ host เท่านั้น');
    if (room.status !== 'waiting')  return;

    room.questions       = generateQuestions(room.difficulty, room.maxQ);
    room.status          = 'playing';
    room.startedAt       = Date.now();
    room.finishedPlayers = 0;

    // Reset คะแนนทุกคน
    for (const id in room.players) {
      room.players[id].score = 0;
      room.players[id].heart = 3;
    }

    log(`ห้อง ${code} เริ่มเกม — ${Object.keys(room.players).length} ผู้เล่น`);

    // ส่งโจทย์ทั้งหมดให้ทุกคนพร้อมกัน
    io.to(code).emit('gameStarted', {
      questions: room.questions,
      totalQ:    room.maxQ,
      startAt:   Date.now() + 1000,  // เริ่มใน 1 วินาที (sync เวลา)
    });
  });

  // ── ส่งคำตอบ ───────────────────────────────────
  socket.on('submitAnswer', ({ code, qIndex, isCorrect, heartsLeft }) => {
    const room = rooms[code];
    if (!room || room.status !== 'playing') return;
    const player = room.players[socket.id];
    if (!player) return;

    if (isCorrect) player.score += 10;
    player.heart = heartsLeft;

    // ส่งคะแนน live ให้ทุกคนในห้องเห็น
    io.to(code).emit('scoreUpdate', {
      players: room.players,
      updatedId: socket.id,
    });
  });

  // ── ผู้เล่นจบเกม ────────────────────────────────
  socket.on('playerFinished', ({ code, finalScore, heartsLeft, timeMs, reason }) => {
    const room = rooms[code];
    if (!room) return;
    const player = room.players[socket.id];
    if (player) {
      player.score = finalScore;
      player.heart = heartsLeft ?? player.heart;
      player.timeMs = timeMs || 0;
      player.finished = true;
    }

    room.finishedPlayers++;
    log(`${player?.name} จบเกมในห้อง ${code} — ${finalScore} คะแนน (${reason})`);

    // แจ้งทุกคนว่าคนนี้จบแล้ว
    io.to(code).emit('playerFinished', {
      playerId: socket.id,
      players:  room.players,
    });

    // ถ้าทุกคนจบแล้ว → จบเกมทั้งห้อง
    if (room.finishedPlayers >= Object.keys(room.players).length) {
      room.status = 'finished';
      const sorted = Object.values(room.players).sort((a,b) => b.score - a.score);
      io.to(code).emit('gameOver', { players: sorted, winner: sorted[0] });
      log(`ห้อง ${code} จบเกม — ชนะ: ${sorted[0]?.name}`);
      
      // ✅ รีเซ็ตห้องกลับเป็น waiting หลัง 3 วินาที
      setTimeout(() => {
        if (rooms[code]) {
          rooms[code].status = 'waiting';
          rooms[code].finishedPlayers = 0;
          rooms[code].questions = [];
          for (const id in rooms[code].players) {
            rooms[code].players[id].score = 0;
            rooms[code].players[id].heart = 3;
            rooms[code].players[id].finished = false;
          }
          io.to(code).emit('playersUpdated', { players: rooms[code].players, newHost: rooms[code].host });
          log(`ห้อง ${code} รีเซ็ตกลับเป็น waiting`);
        }
      }, 3000);
    }
  });

  // ── ออกห้อง ─────────────────────────────────────
  socket.on('leaveRoom', ({ code }) => handleLeave(socket, code));

  // ── กลับห้องรอหลังเกมจบ ────────────────────────
  socket.on('rejoinRoom', ({ code }) => {
    const room = rooms[code];
    if (!room) return socket.emit('roomError', 'ห้องนี้ถูกปิดไปแล้ว');
    const isHost = room.host === socket.id;
    // ส่ง roomRejoined กลับเฉพาะคนนี้
    socket.emit('roomRejoined', { room: safeRoom(room), isHost });
    // แจ้งทุกคนในห้องด้วย
    io.to(code).emit('playersUpdated', { players: room.players, newHost: room.host });
    log(`${room.players[socket.id]?.name || '?'} กลับห้อง ${code} (host: ${isHost})`);
  });

  socket.on('disconnect', () => {
    log(`ตัดการเชื่อมต่อ: ${socket.id}`);
    for (const code in rooms) {
      if (rooms[code].players[socket.id]) {
        handleLeave(socket, code);
        break;
      }
    }
  });

  // ────────────────────────────────────────────────
  function handleLeave(socket, code) {
    const room = rooms[code];
    if (!room) return;
    const name = room.players[socket.id]?.name || '?';
    delete room.players[socket.id];
    socket.leave(code);
    log(`${name} ออกจากห้อง ${code}`);

    if (Object.keys(room.players).length === 0) {
      delete rooms[code];
      log(`ลบห้อง ${code} — ไม่มีผู้เล่น`);
    } else {
      if (room.host === socket.id) {
        room.host = Object.keys(room.players)[0];
        log(`เปลี่ยน host ห้อง ${code} → ${room.players[room.host].name}`);
      }
      io.to(code).emit('playersUpdated', {
        players: room.players,
        newHost: room.host,
      });
    }
  }
});

// ── ลบห้องเก่าทุก 30 นาที (ป้องกัน memory leak) ──
setInterval(() => {
  const now = Date.now();
  for (const code in rooms) {
    const age = now - (rooms[code].startedAt || now);
    if (age > 30 * 60 * 1000) {
      delete rooms[code];
      log(`ลบห้องเก่า ${code}`);
    }
  }
}, 10 * 60 * 1000);

// ── START ──
function safeRoom(room) {
  // ส่งแค่ข้อมูลที่ client ต้องการ ไม่ส่งโจทย์ล่วงหน้า
  const { questions, ...rest } = room;
  return rest;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  log(`🚀 Server รันที่ http://localhost:${PORT}`);
  log(`📡 รอการเชื่อมต่อ...`);
});