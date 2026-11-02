
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
  created_at TEXT NOT NULL,
  admitted INTEGER NOT NULL DEFAULT 0
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

CREATE TABLE IF NOT EXISTS quiz_violations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT NOT NULL,
  team_name TEXT NOT NULL,
  violation_number INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  eliminated INTEGER NOT NULL DEFAULT 0
);
`);

try { db.exec('ALTER TABLE teams ADD COLUMN admitted INTEGER NOT NULL DEFAULT 0'); } catch (error) {
  if (!String(error.message).includes('duplicate column name')) throw error;
}

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
if (!getSetting('quiz_ended')) setSetting('quiz_ended', '0');
if (!getSetting('quiz_monitoring_started')) setSetting('quiz_monitoring_started', '0');

let buzzes = [];
let hostSocketId = null;
let answerModeOpen = false;
let buzzerDeadline = null;
let buzzerTimer = null;
let roundPhase = 'hidden';
let roundDeadline = null;
let roundTimer = null;
let questionVisible = false;
let teamAnswers = [];

function stopBuzzerTimer() {
  if (buzzerTimer) clearTimeout(buzzerTimer);
  if (roundTimer) clearTimeout(roundTimer);
  buzzerTimer = null;
  roundTimer = null;
  buzzerDeadline = null;
  roundDeadline = null;
}

function startAnswerWindow() {
  if (roundTimer) clearTimeout(roundTimer);
  setSetting('buzzer_open', '0');
  buzzerDeadline = null;
  answerModeOpen = true;
  roundPhase = 'answering';
  roundDeadline = Date.now() + 15000;
  roundTimer = setTimeout(() => {
    answerModeOpen = false;
    roundPhase = 'awaiting-reveal';
    roundDeadline = null;
    roundTimer = null;
    broadcast();
  }, 15000);
  broadcast();
}

function startBuzzerWindow() {
  if (roundTimer) clearTimeout(roundTimer);
  setSetting('buzzer_open', '1');
  buzzerDeadline = Date.now() + 10000;
  roundPhase = 'buzzer';
  roundDeadline = buzzerDeadline;
  answerModeOpen = false;
  roundTimer = setTimeout(() => {
    setSetting('buzzer_open', '0');
    buzzerDeadline = null;
    startAnswerWindow();
  }, 10000);
  broadcast();
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

function isTeamEliminated(teamId) {
  return Boolean(db.prepare(
    'SELECT 1 FROM quiz_violations WHERE team_id = ? AND eliminated = 1 LIMIT 1'
  ).get(teamId));
}

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
        admitted: Boolean(t.admitted),
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

    questions: forHost ? questions : [],
    questionCount: questions.length,
    currentIndex: index,
    currentQuestion: questionVisible && question
      ? (forHost || revealed
          ? question
          : (({ correct, ...safe }) => safe)(question))
      : null,
    questionVisible,
    roundPhase,
    roundDeadline,
    buzzerOpen: getSetting('buzzer_open', '0') === '1',
    buzzerDeadline,
    answerModeOpen,
    revealed,

    teams: forHost ? allTeams(true) : allTeams(false).filter(team => team.admitted),

    buzzes: buzzes.map(b => ({
      teamId: b.teamId,
      teamName: db.prepare('SELECT name FROM teams WHERE id = ?').get(b.teamId)?.name || 'Team',
      order: b.order,
      awarded: b.awarded
    })),
    answers: teamAnswers.map(answer => ({
      teamId: answer.teamId,
      teamName: db.prepare('SELECT name FROM teams WHERE id = ?').get(answer.teamId)?.name || 'Team',
      submitted: true,
      selectedOption: (forHost || revealed) ? answer.selectedOption : undefined,
      isCorrect: revealed ? Boolean(answer.isCorrect) : undefined,
      awarded: Boolean(answer.awarded)
    })),

    history: forHost
      ? db.prepare(`
          SELECT h.*, t.name AS team_name
          FROM score_history h
          JOIN teams t ON t.id = h.team_id
          ORDER BY h.id DESC
          LIMIT 100
        `).all()
      : [],
    quizEnded: getSetting('quiz_ended', '0') === '1',
    monitoringStarted: getSetting('quiz_monitoring_started', '0') === '1',
    violations: forHost
      ? db.prepare(`
          SELECT id, team_id, team_name, violation_number, reason, created_at, eliminated
          FROM quiz_violations
          ORDER BY id DESC
        `).all().map(item => ({ ...item, eliminated: Boolean(item.eliminated) }))
      : []
  };
}

function broadcast() {
  const state = publicState(false);
  for (const client of io.sockets.sockets.values()) {
    if (client.data.teamId && isTeamEliminated(client.data.teamId)) {
      client.emit('state', { ...state, teams: (state.teams || []).filter(team => team.id !== client.data.teamId), questions: [], questionCount: 0, currentQuestion: null, questionVisible: false, buzzerOpen: false, buzzes: [], answers: [] });
    } else {
      client.emit('state', state);
    }
  }
  if (hostSocketId) io.to(hostSocketId).emit('host:state', publicState(true));
}

function requireHost(socket) {
  return socket.data.isHost === true &&
    Boolean(socket.data.hostSessionTokenHash) &&
    socket.data.hostSessionTokenHash === getSetting('host_session_token_hash', '');
}

function activateHostSession(socket, token) {
  if (hostSocketId && hostSocketId !== socket.id) {
    const old = io.sockets.sockets.get(hostSocketId);
    if (old) {
      old.data.isHost = false;
      old.data.hostSessionTokenHash = '';
      old.emit('host:session-replaced');
    }
  }

  const tokenHash = hashToken(token);
  setSetting('host_session_token_hash', tokenHash);
  hostSocketId = socket.id;
  socket.data.isHost = true;
  socket.data.hostSessionTokenHash = tokenHash;
  socket.emit('host:login-ok', { ...publicState(true), hostToken: token });
  broadcast();
}

function emitError(socket, message) {
  socket.emit('app:error', { message });
}

io.on('connection', socket => {
  socket.emit('state', publicState(false));

  // HOST LOGIN AND SESSION RESUME
  socket.on('host:login', ({ pin } = {}) => {
    if (typeof pin !== 'string' || pin !== HOST_PIN) {
      return emitError(socket, 'Incorrect host PIN.');
    }
    const token = crypto.randomBytes(32).toString('hex');
    activateHostSession(socket, token);
  });

  socket.on('host:resume', ({ token } = {}) => {
    const savedHash = getSetting('host_session_token_hash', '');
    if (typeof token !== 'string' || !savedHash || hashToken(token) !== savedHash) {
      socket.emit('host:resume-failed');
      return;
    }
    activateHostSession(socket, token);
  });

  // Explicit logout invalidates the persistent session on the server.
  socket.on('host:logout', () => {
    if (requireHost(socket)) {
      // Explicit host logout starts a clean quiz session but preserves the question bank.
      stopBuzzerTimer();
      if (roundTimer) clearTimeout(roundTimer);
      roundTimer = null;
      setSetting('host_session_token_hash', '');
      setSetting('current_index', '0');
      setSetting('buzzer_open', '0');
      setSetting('revealed', '0');
      setSetting('quiz_ended', '0');
      setSetting('quiz_monitoring_started', '0');
      buzzes = [];
      teamAnswers = [];
      answerModeOpen = false;
      questionVisible = false;
      roundPhase = 'hidden';
      roundDeadline = null;
      buzzerDeadline = null;
      db.prepare('DELETE FROM teams').run();
      db.prepare('DELETE FROM quiz_violations').run();
      if (socket.id === hostSocketId) hostSocketId = null;
      io.emit('quiz:session-reset');
    }
    socket.data.isHost = false;
    socket.data.hostSessionTokenHash = '';
    socket.emit('host:logout-ok');
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

    socket.data.teamId = teamId;
    socket.emit('team:registered', {
      teamId,
      token,
      teamName: name.trim(),
      admitted: false
    });

    broadcast();
  });

  // RESUME REGISTERED TEAM
  socket.on('team:resume', ({ teamId, token } = {}) => {
    const team = db
      .prepare('SELECT id, name, token_hash, admitted FROM teams WHERE id = ?')
      .get(teamId);

    if (!team || !token || hashToken(token) !== team.token_hash) {
      return emitError(
        socket,
        'Team session not found. Ask the host to remove and re-register your team.'
      );
    }

    socket.data.teamId = team.id;
    if (isTeamEliminated(team.id)) {
      socket.emit('team:eliminated', { teamName: team.name, reason: 'Three tab-switch violations.' });
      return;
    }

    socket.emit(team.admitted ? 'team:resume-ok' : 'team:lobby', {
      teamId: team.id,
      teamName: team.name,
      admitted: Boolean(team.admitted)
    });
  });

  // PARTICIPANT TAB-SWITCH MONITORING
  socket.on('team:monitoring:start', ({ teamId, token } = {}) => {
    const team = db.prepare('SELECT id, name, token_hash, admitted FROM teams WHERE id = ?').get(teamId);
    if (!team || !token || hashToken(token) !== team.token_hash) {
      return emitError(socket, 'Team authentication failed. Reopen the registration device.');
    }
    if (!team.admitted) { socket.emit('team:lobby', { teamId: team.id, teamName: team.name }); return; }
    if (getSetting('quiz_ended', '0') === '1') {
      socket.emit('quiz:ended');
      return;
    }
    if (isTeamEliminated(team.id)) {
      socket.emit('team:eliminated', { teamName: team.name, reason: 'Three tab-switch violations.' });
      return;
    }
    setSetting('quiz_monitoring_started', '1');
    socket.data.teamId = team.id;
    socket.emit('team:monitoring:started');
    broadcast();
  });

  socket.on('team:violation', ({ teamId, token, reason } = {}) => {
    const team = db.prepare('SELECT id, name, token_hash FROM teams WHERE id = ?').get(teamId);
    if (!team || !token || hashToken(token) !== team.token_hash) {
      return emitError(socket, 'Team authentication failed.');
    }
    if (!team.admitted) return emitError(socket, 'Your team is waiting for host approval in the lobby.');
    if (getSetting('quiz_ended', '0') === '1' ||
        getSetting('quiz_monitoring_started', '0') !== '1') return;
    if (isTeamEliminated(team.id)) {
      socket.emit('team:eliminated', { teamName: team.name, reason: 'Three tab-switch violations.' });
      return;
    }
    const latestViolation = db.prepare(
      'SELECT created_at FROM quiz_violations WHERE team_id = ? ORDER BY id DESC LIMIT 1'
    ).get(team.id);
    if (latestViolation && Date.now() - Date.parse(latestViolation.created_at) < 1800) return;
    const count = db.prepare(
      'SELECT COUNT(*) AS count FROM quiz_violations WHERE team_id = ?'
    ).get(team.id).count;
    const violationNumber = count + 1;
    const eliminated = violationNumber >= 3;
    const cleanReason = String(reason || 'Quiz tab became hidden or inactive.').slice(0, 240);
    db.prepare(`
      INSERT INTO quiz_violations(team_id, team_name, violation_number, reason, created_at, eliminated)
      VALUES(?, ?, ?, ?, ?, ?)
    `).run(team.id, team.name, violationNumber, cleanReason, now(), eliminated ? 1 : 0);
    const result = { teamName: team.name, count: violationNumber, eliminated, reason: cleanReason };
    socket.emit('team:violation:result', result);
    if (eliminated) {
      for (const client of io.sockets.sockets.values()) {
        if (client.data.teamId === team.id) client.emit('team:eliminated', result);
      }
    }
    broadcast();
  });

  // TEAM BUZZER: ANY REGISTERED TEAM MAY BUZZ DURING THE 10-SECOND WINDOW
  socket.on('team:buzz', ({ teamId, token } = {}) => {
    const team = db
      .prepare('SELECT id, name, token_hash, admitted FROM teams WHERE id = ?')
      .get(teamId);

    if (!team || !token || hashToken(token) !== team.token_hash) {
      return emitError(
        socket,
        'Team authentication failed. Reopen the registration device.'
      );
    }
    if (!team.admitted) return emitError(socket, 'Your team is waiting for host approval in the lobby.');
    if (isTeamEliminated(team.id)) return emitError(socket, 'Your team has been eliminated from this quiz.');

    if (getSetting('buzzer_open', '0') !== '1' || roundPhase !== 'buzzer' || !roundDeadline || Date.now() >= roundDeadline) {
      return emitError(socket, 'The 10-second buzzer window is closed.');
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
    questionVisible = false;
    roundPhase = 'hidden';
    teamAnswers = [];

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

  // HOST ENDS THE TEST AND RELEASES PARTICIPANTS FROM TAB MONITORING
  socket.on('host:quiz:end-test', () => {
    if (!requireHost(socket)) return emitError(socket, 'Host login required.');
    setSetting('quiz_ended', '1');
    setSetting('buzzer_open', '0');
    stopBuzzerTimer();
    answerModeOpen = false;
    questionVisible = false;
    roundPhase = 'ended';
    roundDeadline = null;
    broadcast();
    io.emit('quiz:ended');
  });

  // HOST REVEALS THE QUESTION; THEN A 45-SECOND ROUND RUNS AUTOMATICALLY
  socket.on('host:quiz:show-question', () => {
    if (!requireHost(socket)) return emitError(socket, 'Host login required.');
    if (getSetting('quiz_ended', '0') === '1') return emitError(socket, 'The test has ended.');
    if (!currentQuestion()) return emitError(socket, 'Import or add questions first.');
    if (roundPhase !== 'hidden') return emitError(socket, 'Finish the current question before starting the next round.');
    stopBuzzerTimer();
    buzzes = [];
    teamAnswers = [];
    answerModeOpen = false;
    questionVisible = true;
    setSetting('buzzer_open', '0');
    setSetting('revealed', '0');
    roundPhase = 'reading';
    roundDeadline = Date.now() + 20000;
    roundTimer = setTimeout(() => { roundTimer = null; startBuzzerWindow(); }, 20000);
    broadcast();
  });

  // Backwards-compatible event alias.
  socket.on('host:quiz:start-buzzer', () => {
    if (!requireHost(socket)) return emitError(socket, 'Host login required.');
    if (roundPhase !== 'hidden') return emitError(socket, 'Finish the current question first.');
    if (!currentQuestion()) return emitError(socket, 'Import or add questions first.');
    stopBuzzerTimer();
    buzzes = [];
    teamAnswers = [];
    answerModeOpen = false;
    questionVisible = true;
    setSetting('buzzer_open', '0');
    setSetting('revealed', '0');
    roundPhase = 'reading';
    roundDeadline = Date.now() + 20000;
    roundTimer = setTimeout(() => { roundTimer = null; startBuzzerWindow(); }, 20000);
    broadcast();
  });

  socket.on('host:quiz:close-buzzer', () => {
    if (!requireHost(socket)) return emitError(socket, 'Host login required.');
    if (roundPhase !== 'buzzer') return emitError(socket, 'The buzzer is not currently open.');
    stopBuzzerTimer();
    startAnswerWindow();
  });

  // Every registered team may submit one answer during the 15-second window.
  socket.on('team:answer:submit', ({ teamId, token, optionIndex } = {}) => {
    const team = db.prepare('SELECT id, token_hash, admitted FROM teams WHERE id = ?').get(teamId);
    if (!team || !token || hashToken(token) !== team.token_hash) return emitError(socket, 'Team authentication failed.');
    if (!team.admitted) return emitError(socket, 'Your team is waiting for host approval in the lobby.');
    if (isTeamEliminated(team.id)) return emitError(socket, 'Your team has been eliminated from this quiz.');
    if (roundPhase !== 'answering' || !answerModeOpen || !roundDeadline || Date.now() >= roundDeadline) return emitError(socket, 'The 15-second answer submission window is closed.');
    if (teamAnswers.some(answer => answer.teamId === team.id)) return emitError(socket, 'Your team has already submitted an answer.');
    const choice = Number(optionIndex);
    if (!Number.isInteger(choice) || choice < 0 || choice > 3) return emitError(socket, 'Choose option A, B, C, or D.');
    teamAnswers.push({ teamId: team.id, selectedOption: choice, submittedAt: Date.now(), isCorrect: false, awarded: false });
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

    if (roundPhase !== 'awaiting-reveal') {
      return emitError(socket, 'Wait until the reading, buzzer, and answer timers finish before revealing.');
    }
    const answeringTeams = teamAnswers;
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

    // Award points only to teams that submitted a correct answer before the deadline.
    const awardCorrectTeams = db.transaction(() => {
      for (const entry of answeringTeams) {
        entry.isCorrect = entry.selectedOption === question.correct;

        // A team can receive points for a question only once, even if a
        // legacy/manual scoring event or a repeated client event is attempted.
        const alreadyScored = db.prepare(
          'SELECT 1 FROM score_history WHERE team_id = ? AND question_id = ? LIMIT 1'
        ).get(entry.teamId, question.id);

        if (entry.isCorrect && !entry.awarded && !alreadyScored) {
          updateScore.run(question.points, entry.teamId);
          insertHistory.run(entry.teamId, question.id, question.points, now());
          entry.awarded = true;
        }
      }
    });

    awardCorrectTeams();

    setSetting('revealed', '1');
    roundPhase = 'revealed';
    questionVisible = true;
    roundDeadline = null;

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
    questionVisible = false;
    roundPhase = 'hidden';
    teamAnswers = [];
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

    const alreadyScored = question && db.prepare(
      'SELECT 1 FROM score_history WHERE team_id = ? AND question_id = ? LIMIT 1'
    ).get(teamId, question.id);

    if (
      !question ||
      !team ||
      !buzz ||
      buzz.awarded ||
      alreadyScored ||
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

  // ADMIT TEAM FROM REGISTRATION LOBBY
  socket.on('host:team:admit', ({ teamId } = {}) => {
    if (!requireHost(socket)) return emitError(socket, 'Host login required.');
    const result = db.prepare('UPDATE teams SET admitted = 1 WHERE id = ?').run(teamId);
    if (!result.changes) return emitError(socket, 'Team not found in the lobby.');
    for (const client of io.sockets.sockets.values()) {
      if (client.data.teamId === teamId) client.emit('team:admitted', { teamId });
    }
    broadcast();
  });

  // DELETE TEAM
  socket.on('host:team:delete', ({ teamId } = {}) => {
    if (!requireHost(socket)) {
      return emitError(socket, 'Host login required.');
    }

    db.prepare('DELETE FROM teams WHERE id = ?').run(teamId);

    buzzes = buzzes.filter(entry => entry.teamId !== teamId);
    teamAnswers = teamAnswers.filter(entry => entry.teamId !== teamId);

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
