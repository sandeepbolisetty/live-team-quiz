
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');

const PORT = Number(process.env.PORT || 3000);
const HOST_PIN =
  process.env.HOST_PIN || 'change-this-to-a-long-private-password';

const DB_PATH =
  process.env.DATABASE_PATH ||
  path.join(__dirname, 'data', 'quiz.sqlite');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  members_json TEXT NOT NULL,
  rep_index INTEGER NOT NULL DEFAULT 0,
  token_hash TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  options_json TEXT NOT NULL,
  correct INTEGER NOT NULL,
  points INTEGER NOT NULL,
  category TEXT NOT NULL,
  time_limit INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS score_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT NOT NULL,
  question_id TEXT,
  points INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(team_id) REFERENCES teams(id) ON DELETE CASCADE
);
`);

const getSetting = (key, fallback) => {
  const row = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(key);

  return row ? row.value : fallback;
};

const setSetting = (key, value) =>
  db.prepare(`
    INSERT INTO settings(key, value)
    VALUES(?, ?)
    ON CONFLICT(key)
    DO UPDATE SET value = excluded.value
  `).run(key, String(value));

if (!getSetting('room_code')) {
  setSetting('room_code', crypto.randomBytes(3).toString('hex').toUpperCase());
}

if (!getSetting('current_index')) setSetting('current_index', '0');
if (!getSetting('buzzer_open')) setSetting('buzzer_open', '0');
if (!getSetting('revealed')) setSetting('revealed', '0');

let buzzes = [];
let hostSocketId = null;
let answerModeOpen = false;
let buzzerDeadline = null;
let buzzerTimer = null;

function stopBuzzerTimer() {
  if (buzzerTimer) clearTimeout(buzzerTimer);
  buzzerTimer = null;
  buzzerDeadline = null;
}

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: true }
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => res.json({ ok: true }));

for (const page of ['host', 'projector', 'register', 'buzzer']) {
  app.get(`/${page}`, (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });
}

const now = () => new Date().toISOString();

const id = () => crypto.randomBytes(12).toString('hex');

const hashToken = token =>
  crypto.createHash('sha256').update(token).digest('hex');

function allQuestions() {
  return db
    .prepare('SELECT * FROM questions ORDER BY position, id')
    .all()
    .map(q => ({
      id: q.id,
      text: q.text,
      options: JSON.parse(q.options_json),
      correct: q.correct,
      points: q.points,
      category: q.category,
      time: q.time_limit,
      position: q.position
    }));
}

function allTeams(includePrivate = false) {
  return db.prepare('SELECT * FROM teams ORDER BY created_at')
    .all()
    .map(t => {
      const members = JSON.parse(t.members_json);

      return {
        id: t.id,
        name: t.name,
        members: includePrivate ? members : undefined,
        memberCount: members.length,
        repIndex: t.rep_index,
        score: t.score,
        createdAt: t.created_at
      };
    });
}

function currentQuestion() {
  const questions = allQuestions();

  const index = Math.max(
    0,
    Math.min(
      Number(getSetting('current_index', '0')),
      questions.length - 1
    )
  );

  return questions[index] || null;
}

function publicState(forHost = false) {
  const questions = allQuestions();
  const index = Number(getSetting('current_index', '0'));
  const question = questions[index] || null;
  const revealed = getSetting('revealed', '0') === '1';

  return {
    roomCode: getSetting('room_code', 'QUIZ'),

    questions: forHost
      ? questions
      : questions.map(({ correct, ...safe }) => safe),

    currentIndex: index,

    currentQuestion: question
      ? (forHost || revealed
          ? question
          : (({ correct, ...safe }) => safe)(question))
      : null,

    buzzerOpen: getSetting('buzzer_open', '0') === '1',
    buzzerDeadline,
    answerModeOpen,
    revealed,

    teams: allTeams(forHost),

    buzzes: buzzes.map(b => ({
      teamId: b.teamId,
      teamName:
        db.prepare('SELECT name FROM teams WHERE id = ?')
          .get(b.teamId)?.name || 'Team',
      order: b.order,
      awarded: b.awarded,
      submitted: Boolean(b.submitted),
      selectedOption: forHost ? b.selectedOption : undefined,
      isCorrect: revealed ? Boolean(b.isCorrect) : undefined
    })),

    history: forHost
      ? db.prepare(`
          SELECT h.*, t.name AS team_name
          FROM score_history h
          JOIN teams t ON t.id = h.team_id
          ORDER BY h.id DESC
          LIMIT 100
        `).all()
      : []
  };
}

function broadcast() {
  io.emit('state', publicState(false));

  if (hostSocketId) {
    io.to(hostSocketId).emit('host:state', publicState(true));
  }
}

function requireHost(socket) {
  return socket.data.isHost === true;
}

function emitError(socket, message) {
  socket.emit('app:error', { message });
}

io.on('connection', socket => {
  socket.emit('state', publicState(false));

  // HOST LOGIN
  socket.on('host:login', ({ pin } = {}) => {
    if (typeof pin !== 'string' || pin !== HOST_PIN) {
      return emitError(socket, 'Incorrect host PIN.');
    }

    if (hostSocketId && hostSocketId !== socket.id) {
      const old = io.sockets.sockets.get(hostSocketId);

      if (old) {
        old.emit('app:error', {
          message:
            'Host dashboard opened in another browser. ' +
            'This session is now the active host.'
        });
      }
    }

    hostSocketId = socket.id;
    socket.data.isHost = true;

    socket.emit('host:login-ok', publicState(true));
    broadcast();
  });

  // TEAM REGISTRATION
  socket.on('team:register', ({ name, members, repIndex } = {}) => {
    if (
      typeof name !== 'string' ||
      !name.trim() ||
      name.trim().length > 50
    ) {
      return emitError(
        socket,
        'Enter a team name (maximum 50 characters).'
      );
    }

    if (!Array.isArray(members) || members.length < 1 || members.length > 10) {
      return emitError(socket, 'A team must have 1–10 members.');
    }

    const clean = members.map(member => ({
      name: String(member?.name || '').trim(),
      reg: String(member?.reg || '').trim()
    }));

    if (
      clean.some(
        member =>
          !member.name ||
          !member.reg ||
          member.name.length > 100 ||
          member.reg.length > 40
      )
    ) {
      return emitError(
        socket,
        'Every member needs a full name and registration number.'
      );
    }

    if (
      new Set(clean.map(member => member.reg.toLowerCase())).size !==
      clean.length
    ) {
      return emitError(
        socket,
        'Registration numbers must be unique within the team.'
      );
    }

    const representative = Number(repIndex);

    if (
      !Number.isInteger(representative) ||
      representative < 0 ||
      representative >= clean.length
    ) {
      return emitError(socket, 'Choose a valid representative.');
    }

    const teamId = id();
    const token = crypto.randomBytes(32).toString('hex');

    try {
      db.prepare(`
        INSERT INTO teams(
          id, name, members_json, rep_index,
          token_hash, score, created_at
        )
        VALUES(?, ?, ?, ?, ?, ?, ?)
      `).run(
        teamId,
        name.trim(),
        JSON.stringify(clean),
        representative,
        hashToken(token),
        0,
        now()
      );
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) {
        return emitError(socket, 'That team name is already registered.');
      }

      return emitError(socket, 'Could not register team.');
    }

    socket.emit('team:registered', {
      teamId,
      token,
      teamName: name.trim()
    });

    broadcast();
  });

  // RESUME REGISTERED TEAM
  socket.on('team:resume', ({ teamId, token } = {}) => {
    const team = db
      .prepare('SELECT id, name, token_hash FROM teams WHERE id = ?')
      .get(teamId);

    if (!team || !token || hashToken(token) !== team.token_hash) {
      return emitError(
        socket,
        'Team session not found. Ask the host to remove and re-register your team.'
      );
    }

    socket.data.teamId = team.id;

    socket.emit('team:resume-ok', {
      teamId: team.id,
      teamName: team.name
    });
  });

  // TEAM BUZZER: ONLY FIRST TWO TEAMS ARE ACCEPTED
  socket.on('team:buzz', ({ teamId, token } = {}) => {
    const team = db
      .prepare('SELECT id, name, token_hash FROM teams WHERE id = ?')
      .get(teamId);

    if (!team || !token || hashToken(token) !== team.token_hash) {
      return emitError(
        socket,
        'Team authentication failed. Reopen the registration device.'
      );
    }

    if (getSetting('buzzer_open', '0') !== '1') {
      return emitError(socket, 'The host has not opened the buzzer.');
    }

    if (getSetting('revealed', '0') === '1') {
      return emitError(socket, 'The answer has already been revealed.');
    }

    if (!currentQuestion()) {
      return emitError(socket, 'The host has not published a question.');
    }

    if (buzzes.some(b => b.teamId === team.id)) {
      return emitError(
        socket,
        'Your team has already buzzed for this question.'
      );
    }

    if (buzzes.length >= 2) {
      return emitError(
        socket,
        'The first two teams have already buzzed.'
      );
    }

    const entry = {
      teamId: team.id,
      at: Date.now(),
      order: buzzes.length + 1,
      awarded: false,
      selectedOption: null,
      submitted: false,
      isCorrect: false
    };

    buzzes.push(entry);

    io.emit('buzz:accepted', {
      teamId: team.id,
      teamName: team.name,
      order: entry.order
    });

    broadcast();
  });

  // ADD OR EDIT QUESTION
  socket.on('host:question:save', payload => {
    if (!requireHost(socket)) {
      return emitError(socket, 'Host login required.');
    }

    const q = payload || {};

    if (
      typeof q.text !== 'string' ||
      !q.text.trim() ||
      !Array.isArray(q.options) ||
      q.options.length !== 4 ||
      q.options.some(option => !String(option).trim())
    ) {
      return emitError(socket, 'Enter a question and all four options.');
    }

    const questionId = q.id || id();

    const existing = db
      .prepare('SELECT id, position FROM questions WHERE id = ?')
      .get(questionId);

    const position = existing
      ? existing.position
      : db.prepare(
          'SELECT COALESCE(MAX(position), -1) + 1 AS n FROM questions'
        ).get().n;

    db.prepare(`
      INSERT INTO questions(
        id, position, text, options_json,
        correct, points, category, time_limit
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        text = excluded.text,
        options_json = excluded.options_json,
        correct = excluded.correct,
        points = excluded.points,
        category = excluded.category,
        time_limit = excluded.time_limit
    `).run(
      questionId,
      position,
      q.text.trim(),
      JSON.stringify(q.options.map(option => String(option).trim())),
      Math.max(0, Math.min(3, Number(q.correct) || 0)),
      Math.max(1, Number(q.points) || 10),
      String(q.category || 'General').slice(0, 60),
      Math.max(5, Number(q.time) || 30)
    );

    if (!currentQuestion()) {
      setSetting('current_index', '0');
    }

    broadcast();
  });

  // DELETE QUESTION
  socket.on('host:question:delete', ({ id: questionId } = {}) => {
    if (!requireHost(socket)) {
      return emitError(socket, 'Host login required.');
    }

    const index = allQuestions().findIndex(q => q.id === questionId);

    if (index < 0) return;

    db.prepare('DELETE FROM questions WHERE id = ?').run(questionId);

    const count = allQuestions().length;

    setSetting(
      'current_index',
      String(
        Math.max(
          0,
          Math.min(Number(getSetting('current_index', '0')), count - 1)
        )
      )
    );

    buzzes = [];
    setSetting('buzzer_open', '0');
    setSetting('revealed', '0');
    answerModeOpen = false;
    stopBuzzerTimer();

    broadcast();
  });

  // MOVE QUESTION
  socket.on('host:question:move', ({ id: questionId, delta } = {}) => {
    if (!requireHost(socket)) {
      return emitError(socket, 'Host login required.');
    }

    const questions = allQuestions();
    const current = questions.findIndex(q => q.id === questionId);
    const target = current + Number(delta);

    if (
      current < 0 ||
      target < 0 ||
      target >= questions.length
    ) {
      return;
    }

    const first = questions[current];
    const second = questions[target];

    const update = db.prepare(
      'UPDATE questions SET position = ? WHERE id = ?'
    );

    const temporaryPosition = -999999;

    db.transaction(() => {
      update.run(temporaryPosition, first.id);
      update.run(first.position, second.id);
      update.run(second.position, first.id);
    })();

    const currentIndex = Number(getSetting('current_index', '0'));

    setSetting(
      'current_index',
      String(
        currentIndex === current
          ? target
          : currentIndex === target
            ? current
            : currentIndex
      )
    );

    broadcast();
  });

  // OPEN BUZZER FOR A QUESTION
  socket.on('host:quiz:start-buzzer', () => {
    if (!requireHost(socket)) {
      return emitError(socket, 'Host login required.');
    }

    if (!currentQuestion()) {
      return emitError(socket, 'Add a question first.');
    }

    buzzes = [];
    answerModeOpen = false;
    stopBuzzerTimer();

    setSetting('buzzer_open', '1');
    setSetting('revealed', '0');
    buzzerDeadline = Date.now() + 15000;
    buzzerTimer = setTimeout(() => {
      setSetting('buzzer_open', '0');
      stopBuzzerTimer();
      broadcast();
    }, 15000);

    broadcast();
  });

  // CLOSE BUZZER
  socket.on('host:quiz:close-buzzer', () => {
    if (!requireHost(socket)) {
      return emitError(socket, 'Host login required.');
    }

    setSetting('buzzer_open', '0');
    stopBuzzerTimer();
    broadcast();
  });

  // HOST UNLOCKS ANSWER ENTRY ON ELIGIBLE TEAM DEVICES
  socket.on('host:answer-mode:unlock', () => {
    if (!requireHost(socket)) return emitError(socket, 'Host login required.');
    if (getSetting('revealed', '0') === '1') return emitError(socket, 'The answer has already been revealed.');
    if (!buzzes.length) return emitError(socket, 'Wait for at least one team to buzz first.');
    setSetting('buzzer_open', '0');
    stopBuzzerTimer();
    answerModeOpen = true;
    broadcast();
  });

  // TEAM SUBMITS ITS OWN ANSWER AFTER HOST UNLOCKS ANSWER MODE
  socket.on('team:answer:submit', ({ teamId, token, optionIndex } = {}) => {
    const team = db.prepare('SELECT id, token_hash FROM teams WHERE id = ?').get(teamId);
    if (!team || !token || hashToken(token) !== team.token_hash) return emitError(socket, 'Team authentication failed.');
    if (!answerModeOpen || getSetting('revealed', '0') === '1') return emitError(socket, 'The host has not unlocked answer mode.');
    const buzz = buzzes.find(entry => entry.teamId === team.id && entry.order <= 2);
    const choice = Number(optionIndex);
    if (!buzz) return emitError(socket, 'Only the first two teams to buzz can answer.');
    if (buzz.submitted) return emitError(socket, 'Your team has already submitted its answer.');
    if (!Number.isInteger(choice) || choice < 0 || choice > 3) return emitError(socket, 'Choose option A, B, C, or D.');
    buzz.selectedOption = choice;
    buzz.submitted = true;
    socket.emit('team:answer:submitted', { teamId: team.id });
    broadcast();
  });

  // HOST RECORDS EACH TEAM'S ORAL ANSWER (legacy event; team UI submits directly)
  // optionIndex: A = 0, B = 1, C = 2, D = 3
  socket.on('host:answer:set', ({ teamId, optionIndex } = {}) => {
    if (!requireHost(socket)) {
      return emitError(socket, 'Host login required.');
    }

    if (getSetting('revealed', '0') === '1') {
      return emitError(socket, 'The answer is already revealed.');
    }

    const buzz = buzzes.find(entry => entry.teamId === teamId);
    const choice = Number(optionIndex);

    if (
      !buzz ||
      buzz.order > 2 ||
      !Number.isInteger(choice) ||
      choice < 0 ||
      choice > 3
    ) {
      return emitError(
        socket,
        'Choose an option for one of the first two teams.'
      );
    }

    buzz.selectedOption = choice;

    broadcast();
  });

  // REVEAL ANSWER AND AWARD POINTS AUTOMATICALLY
  socket.on('host:quiz:reveal', () => {
    if (!requireHost(socket)) {
      return emitError(socket, 'Host login required.');
    }

    if (getSetting('revealed', '0') === '1') {
      return emitError(socket, 'The answer has already been revealed.');
    }

    const question = currentQuestion();

    if (!question) {
      return emitError(socket, 'There is no current question.');
    }

    const answeringTeams = buzzes.filter(entry => entry.order <= 2);

    if (
      answeringTeams.some(
        entry => !entry.submitted ||
          entry.selectedOption === null ||
          entry.selectedOption === undefined
      )
    ) {
      return emitError(
        socket,
        'Select an option for each of the first two teams before revealing the answer.'
      );
    }

    setSetting('buzzer_open', '0');
    stopBuzzerTimer();
    answerModeOpen = false;

    const updateScore = db.prepare(
      'UPDATE teams SET score = score + ? WHERE id = ?'
    );

    const insertHistory = db.prepare(`
      INSERT INTO score_history(team_id, question_id, points, created_at)
      VALUES(?, ?, ?, ?)
    `);

    // Compare the host-recorded option with the correct option.
    // Award points only once to each correct team.
    const awardCorrectTeams = db.transaction(() => {
      for (const entry of answeringTeams) {
        entry.isCorrect = entry.selectedOption === question.correct;

        if (entry.isCorrect && !entry.awarded) {
          updateScore.run(question.points, entry.teamId);

          insertHistory.run(
            entry.teamId,
            question.id,
            question.points,
            now()
          );

          entry.awarded = true;
        }
      }
    });

    awardCorrectTeams();

    setSetting('revealed', '1');

    broadcast();
  });

  // GO TO NEXT QUESTION
  socket.on('host:quiz:next', () => {
    if (!requireHost(socket)) {
      return emitError(socket, 'Host login required.');
    }

    const questions = allQuestions();

    if (!questions.length) return;

    const nextIndex =
      (Number(getSetting('current_index', '0')) + 1) % questions.length;

    setSetting('current_index', String(nextIndex));
    setSetting('buzzer_open', '0');
    setSetting('revealed', '0');
    answerModeOpen = false;
    stopBuzzerTimer();

    buzzes = [];

    broadcast();
  });

  // MANUAL SCORE AWARD, IF USED BY THE HOST UI
  socket.on('host:score:award', ({ teamId } = {}) => {
    if (!requireHost(socket)) {
      return emitError(socket, 'Host login required.');
    }

    const question = currentQuestion();
    const team = db
      .prepare('SELECT id FROM teams WHERE id = ?')
      .get(teamId);

    const buzz = buzzes.find(entry => entry.teamId === teamId);

    if (
      !question ||
      !team ||
      !buzz ||
      buzz.awarded ||
      buzz.order > 2 ||
      getSetting('revealed', '0') === '1'
    ) {
      return emitError(socket, 'This team cannot be awarded points.');
    }

    db.prepare(
      'UPDATE teams SET score = score + ? WHERE id = ?'
    ).run(question.points, teamId);

    db.prepare(`
      INSERT INTO score_history(team_id, question_id, points, created_at)
      VALUES(?, ?, ?, ?)
    `).run(teamId, question.id, question.points, now());

    buzz.awarded = true;

    setSetting('buzzer_open', '0');

    broadcast();
  });

  // DELETE TEAM
  socket.on('host:team:delete', ({ teamId } = {}) => {
    if (!requireHost(socket)) {
      return emitError(socket, 'Host login required.');
    }

    db.prepare('DELETE FROM teams WHERE id = ?').run(teamId);

    buzzes = buzzes.filter(entry => entry.teamId !== teamId);

    broadcast();
  });

  // RESET SCORES
  socket.on('host:scores:reset', () => {
    if (!requireHost(socket)) {
      return emitError(socket, 'Host login required.');
    }

    db.prepare('UPDATE teams SET score = 0').run();
    db.prepare('DELETE FROM score_history').run();

    buzzes = buzzes.map(entry => ({
      ...entry,
      awarded: false
    }));

    broadcast();
  });

  // EXPORT TEAM DETAILS FOR THE HOST
  socket.on('host:teams:export', () => {
    if (!requireHost(socket)) {
      return emitError(socket, 'Host login required.');
    }

    socket.emit('host:teams-export', allTeams(true));
  });

  socket.on('disconnect', () => {
    if (hostSocketId === socket.id) {
      hostSocketId = null;
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Live Team Quiz running on port ${PORT}`);
});
