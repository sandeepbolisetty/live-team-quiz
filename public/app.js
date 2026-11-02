
(() => {
  const socket = io();
  const $ = id => document.getElementById(id);

  let latest = null;
  let isHost = false;
  let audioCtx = null;
  let soundMuted = localStorage.getItem('liveQuizSoundMuted') === '1';
  let lastSoundPhase = null;
  let lastWarningSecond = null;
  let toastTimer;
  let buzzerCountdownInterval = null;
  let monitoringStarted = false;
  let quizEnded = false;
  let participantEliminated = false;
  let participantInLobby = false;
  let lastViolationSentAt = 0;

  const TEAM_ID_KEY = 'liveQuizTeamId';
  const TEAM_TOKEN_KEY = 'liveQuizTeamToken';
  const HOST_SESSION_KEY = 'liveQuizHostSession';
  let hostSessionToken = localStorage.getItem(HOST_SESSION_KEY) || '';

  let teamId = localStorage.getItem(TEAM_ID_KEY) || '';
  let teamToken = localStorage.getItem(TEAM_TOKEN_KEY) || '';
  // Until the server confirms admission on resume, keep returning teams in the lobby.
  if (teamId && teamToken) participantInLobby = true;

  function startParticipantMonitoring() {
    if (!teamId || !teamToken || isHost || quizEnded || participantEliminated) return;
    monitoringStarted = true;
    socket.emit('team:monitoring:start', { teamId, token: teamToken });
  }

  function reportTabSwitch() {
    if (!monitoringStarted || quizEnded || participantEliminated || !teamId || !teamToken) return;
    const currentTime = Date.now();
    if (currentTime - lastViolationSentAt < 1800) return;
    lastViolationSentAt = currentTime;
    socket.emit('team:violation', {
      teamId,
      token: teamToken,
      reason: 'Participant switched away from the quiz tab or minimized the quiz page.'
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) reportTabSwitch();
  });

  window.addEventListener('beforeunload', event => {
    if (!monitoringStarted || quizEnded || participantEliminated) return;
    event.preventDefault();
    event.returnValue = 'The quiz is still active. Leaving now may count as a violation.';
    return event.returnValue;
  });

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[char]);
  }

  function toast(message) {
    $('toast').textContent = message;
    $('toast').classList.add('show');

    clearTimeout(toastTimer);

    toastTimer = setTimeout(() => {
      $('toast').classList.remove('show');
    }, 3800);
  }

  function view(name) {
    if (monitoringStarted && !quizEnded && !isHost && teamId && name !== 'buzzer') {
      toast('The quiz is active. Stay on the quiz page until the host ends the test.');
      return;
    }
    document.querySelectorAll('.view').forEach(element => {
      element.classList.toggle('active', element.id === name);
    });

    document.querySelectorAll('nav [data-view]').forEach(element => {
      element.classList.toggle('active', element.dataset.view === name);
    });

    if (name === 'host' && !isHost) {
      $('hostPin').focus();
    }
    if (name === 'buzzer' && (!teamId || !latest?.teams || latest.teams.some(team => team.id === teamId))) startParticipantMonitoring();
  }

  document.querySelectorAll('nav [data-view]').forEach(button => {
    button.addEventListener('click', () => view(button.dataset.view));
  });

  document.querySelectorAll('[data-go]').forEach(button => {
    button.addEventListener('click', () => view(button.dataset.go));
  });

  // Short synthesized sound effects; no external audio files are required.
  function playTone(kind = 'buzzer') {
    if (soundMuted) return;
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      audioCtx = audioCtx || new AudioContextClass();
      if (audioCtx.state === 'suspended') audioCtx.resume();

      const patterns = {
        buzzer: [{ f: 880, d: 0.12, wave: 'sawtooth' }, { f: 620, d: 0.16, wave: 'sawtooth' }],
        warning: [{ f: 740, d: 0.09, wave: 'sine' }],
        reveal: [{ f: 523, d: 0.12, wave: 'triangle' }, { f: 659, d: 0.12, wave: 'triangle' }, { f: 784, d: 0.22, wave: 'triangle' }],
        phase: [{ f: 660, d: 0.08, wave: 'sine' }]
      };
      let offset = 0;
      for (const note of (patterns[kind] || patterns.buzzer)) {
        const start = audioCtx.currentTime + offset;
        const oscillator = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        oscillator.type = note.wave;
        oscillator.frequency.setValueAtTime(note.f, start);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.12, start + 0.012);
        gain.gain.setValueAtTime(0.09, start + note.d * 0.55);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + note.d);
        oscillator.connect(gain);
        gain.connect(audioCtx.destination);
        oscillator.start(start);
        oscillator.stop(start + note.d + 0.01);
        offset += note.d + 0.035;
      }
    } catch (error) {
      console.warn('Could not play quiz sound:', error);
    }
  }

  function updateSoundButton() {
    const button = $('enableSound');
    if (!button) return;
    button.textContent = soundMuted ? '🔇 Sound muted' : '🔊 Mute sound';
    button.setAttribute('aria-pressed', String(soundMuted));
  }

  $('enableSound').addEventListener('click', () => {
    soundMuted = !soundMuted;
    localStorage.setItem('liveQuizSoundMuted', soundMuted ? '1' : '0');
    updateSoundButton();
    if (!soundMuted) playTone('reveal');
    toast(soundMuted ? 'Sound effects muted on this device.' : 'Sound effects enabled on this device.');
  });
  updateSoundButton();

  // Host logout.
  $('hostLogout').addEventListener('click', () => {
    if (!confirm('Log out and reset this quiz session? All registered teams, scores, and violation records will be cleared. Your question bank will be kept, and no question will remain published.')) return;
    socket.emit('host:logout');
  });

  socket.on('host:logout-ok', () => {
    isHost = false;
    hostReconnectPending = false;
    hostSessionToken = '';
    localStorage.removeItem(HOST_SESSION_KEY);
    $('hostPin').value = '';
    $('hostLogin').hidden = false;
    $('hostPanel').hidden = true;
    $('hostPanel').classList.remove('host-reconnecting');
    $('resetScores').hidden = true;
    $('exportResults').hidden = true;
    view('home');
    toast('You have logged out of the host dashboard.');
  });

  // Host login.
  $('loginForm').addEventListener('submit', event => {
    event.preventDefault();

    socket.emit('host:login', {
      pin: $('hostPin').value
    });
  });

  socket.on('host:login-ok', data => {
    isHost = true;
    hostReconnectPending = false;
    if (data.hostToken) {
      hostSessionToken = data.hostToken;
      localStorage.setItem(HOST_SESSION_KEY, hostSessionToken);
    }

    $('hostPin').value = '';
    $('hostLogin').hidden = true;
    $('hostPanel').hidden = false;
    $('hostPanel').classList.remove('host-reconnecting');
    $('resetScores').hidden = false;
    $('exportResults').hidden = false;

    latest = data;
    render(data);

    toast('Host dashboard connected.');
  });

  socket.on('host:resume-failed', () => {
    hostReconnectPending = false;
    hostSessionToken = '';
    localStorage.removeItem(HOST_SESSION_KEY);
    isHost = false;
    $('hostPanel').hidden = true;
    $('hostPanel').classList.remove('host-reconnecting');
    $('hostLogin').hidden = false;
    $('resetScores').hidden = true;
    $('exportResults').hidden = true;
    toast('Host session expired. Please sign in again.');
  });

  socket.on('host:session-replaced', () => {
    isHost = false;
    hostReconnectPending = false;
    hostSessionToken = '';
    localStorage.removeItem(HOST_SESSION_KEY);
    $('hostPanel').hidden = true;
    $('hostPanel').classList.remove('host-reconnecting');
    $('hostLogin').hidden = false;
    $('resetScores').hidden = true;
    $('exportResults').hidden = true;
    toast('Host access was opened in another browser. Please sign in again here.');
  });

  socket.on('state', data => {
    // Public state intentionally omits the violation history. Once authenticated,
    // the host must only use host:state so public updates cannot replace the
    // complete host snapshot (and make earlier records disappear from the report).
    if (!isHost) {
      latest = data;
      render(data);
    }
  });

  socket.on('host:state', data => {
    if (isHost) {
      latest = data;
      render(data);
    }
  });

  socket.on('app:error', data => {
    toast(data?.message || 'Something went wrong.');
  });

  socket.on('team:answer:submitted', () => {
    toast('Answer submitted successfully. Wait for the host to reveal.');
  });

  // Notify the host whenever a team buzzes.
  socket.on('buzz:accepted', data => {
    if (isHost) {
      playTone('buzzer');
      toast(`${soundMuted ? '' : '🔊 '}${data.teamName} buzzed — #${data.order}`);
    } else if (data.teamId === teamId) {
      $('buzzerMessage').textContent =
        `Buzz accepted! Your order is #${data.order}. Wait for the host.`;
    }
  });

  // Successful team registration.
  function showLobby(teamName = 'Your team') {
    participantInLobby = true;
    monitoringStarted = false;
    $('registerResult').innerHTML = '<div class="notice"><b>' + esc(teamName) + '</b> is registered and waiting in the lobby. The host must approve your team before you can enter the quiz.</div>';
    $('teamSession').innerHTML = '<div class="notice"><b>' + esc(teamName) + '</b><br>Waiting for host approval. Please keep this page open.</div>';
    $('buzzerQuestion').innerHTML = '<div class="notice">You are in the lobby. Questions will appear after the host admits your team.</div>';
    $('teamAnswerArea').innerHTML = '';
    $('buzzButton').disabled = true;
    $('buzzerMessage').textContent = 'Waiting for host approval.';
    view('buzzer');
  }

  socket.on('team:registered', data => {
    teamId = data.teamId;
    teamToken = data.token;
    localStorage.setItem(TEAM_ID_KEY, teamId);
    localStorage.setItem(TEAM_TOKEN_KEY, teamToken);
    showLobby(data.teamName);
    socket.emit('team:resume', { teamId, token: teamToken });
    toast('Team registered. Waiting for host approval.');
  });

  socket.on('team:lobby', data => {
    teamId = data.teamId || teamId;
    showLobby(data.teamName || 'Your team');
  });

  socket.on('team:resume-ok', data => {
    teamId = data.teamId;
    participantInLobby = false;
    render(latest);
    startParticipantMonitoring();
  });

  socket.on('team:admitted', data => {
    if (data?.teamId !== teamId) return;
    participantInLobby = false;
    toast('Your team has been admitted. The quiz is ready.');
    view('buzzer');
    startParticipantMonitoring();
    render(latest);
  });

  socket.on('team:monitoring:started', () => {
    monitoringStarted = true;
    toast('Quiz monitoring is active. Stay on this page until the host ends the test.');
  });

  socket.on('team:violation:result', data => {
    if (!data) return;
    if (data.eliminated) {
      alert('You have been eliminated from the quiz after 3 tab-switch violations. Reason: ' + data.reason);
      lockEliminatedParticipant(data);
    } else {
      alert('Warning ' + data.count + ' of 2: You left the quiz page. A third violation will eliminate your team.');
    }
  });

  function lockEliminatedParticipant(data = {}) {
    participantEliminated = true;
    monitoringStarted = false;
    quizEnded = true;
    if (buzzerCountdownInterval) clearInterval(buzzerCountdownInterval);
    ['buzzerQuestion', 'projectorQuestion'].forEach(id => { if ($(id)) $(id).innerHTML = '<div class="notice warn"><b>Access removed</b><p>Your team has been eliminated from this quiz.</p></div>'; });
    ['teamAnswerArea', 'hostAnswerPicks'].forEach(id => { if ($(id)) $(id).innerHTML = ''; });
    if ($('teamSession')) $('teamSession').innerHTML = '<div class="notice warn"><b>Team eliminated</b><br>' + esc(data.teamName || 'Your team') + '<br>Reason: ' + esc(data.reason || 'Three tab-switch violations.') + '</div>';
    if ($('buzzButton')) $('buzzButton').disabled = true;
    if ($('buzzerMessage')) $('buzzerMessage').textContent = 'Your team has been removed from this quiz.';
    if ($('questionNum')) $('questionNum').textContent = '—';
    if ($('teamTimer')) $('teamTimer').textContent = 'Eliminated';
    view('buzzer');
  }

  socket.on('team:eliminated', data => lockEliminatedParticipant(data));

  socket.on('quiz:session-reset', () => {
    if (isHost) return;
    monitoringStarted = false;
    quizEnded = false;
    participantEliminated = false;
    teamId = '';
    teamToken = '';
    localStorage.removeItem(TEAM_ID_KEY);
    localStorage.removeItem(TEAM_TOKEN_KEY);
    $('teamSession').innerHTML = '<div class="notice warn">The host has reset the quiz session. Please register your team again.</div>';
    $('teamAnswerArea').innerHTML = '';
    $('buzzerQuestion').innerHTML = '';
    $('buzzButton').disabled = true;
    view('home');
    toast('Quiz session reset by the host. Register again to join.');
  });

  socket.on('quiz:ended', () => {
    quizEnded = true;
    monitoringStarted = false;
    toast('The host has ended the test. You may now leave the quiz page.');
  });

  socket.on('host:teams-export', teams => {
    const rows = [
      ['Team', 'Member name', 'Registration number', 'Representative', 'Score']
    ];

    teams.forEach(team => {
      team.members.forEach((member, index) => {
        rows.push([
          team.name,
          member.name,
          member.reg,
          index === team.repIndex ? 'Yes' : 'No',
          team.score
        ]);
      });
    });

    downloadCSV('registered-teams.csv', rows);
  });

  function renderQuestion(question, revealed = false, host = false) {
    if (!question) {
      return '<div class="empty">Waiting for the host to publish a question.</div>';
    }

    return `
      <div class="row">
        <span class="badge">${esc(question.category || 'General')}</span>
        <span class="badge">${question.points || 10} points</span>
        ${host ? `<span class="badge">${question.time || 30} sec</span>` : ''}
      </div>

      <div class="question-title">${esc(question.text)}</div>

      <div class="options">
        ${(question.options || []).map((option, index) => `
          <div class="option ${
            revealed && Number(question.correct) === index ? 'correct' : ''
          }">
            <b>${'ABCD'[index]}</b>
            ${esc(option)}
          </div>
        `).join('')}
      </div>

      ${revealed && question.correct !== undefined ? `
        <p class="notice">
          Correct answer:
          <b>${'ABCD'[question.correct]}. ${esc(question.options[question.correct])}</b>
        </p>
      ` : ''}
    `;
  }

  function renderBuzzes(buzzes) {
    if (!buzzes?.length) {
      return '<div class="empty">No teams have buzzed yet.</div>';
    }

    return `
      <ol>
        ${buzzes.map(buzz => `
          <li>
            <b>${esc(buzz.teamName)}</b> — buzz #${buzz.order}

            ${buzz.isCorrect === true
              ? '<span class="badge green">Correct · points awarded</span>'
              : ''}

            ${buzz.isCorrect === false
              ? '<span class="badge red">Incorrect</span>'
              : ''}
          </li>
        `).join('')}
      </ol>
    `;
  }

  // Host selects the option each team said aloud.
  function renderHostAnswers(answers, teams, question, revealed, phase) {
    if (!teams?.length) return '<div class="empty">No teams registered yet.</div>';
    const byTeam = new Map((answers || []).map(answer => [answer.teamId, answer]));
    return `<div class="answer-picks">${teams.map(team => {
      const answer = byTeam.get(team.id);
      return `<div class="answer-pick"><b>${esc(team.name)}</b>
        <p>${answer ? '<span class="badge green">Submitted</span>' : '<span class="badge">Not submitted</span>'}</p>
        ${answer && (revealed || phase === 'awaiting-reveal') ? `<p>Option: <b>${'ABCD'[answer.selectedOption]}</b></p>` : ''}
        ${revealed ? `<div class="notice ${answer?.isCorrect ? '' : 'warn'}">${answer?.isCorrect ? `Correct — ${question?.points || 1} points` : 'No points'}</div>` : ''}
      </div>`;
    }).join('')}</div>`;
  }

  function table(rows) {
    return `<div class="table-wrap"><table>${rows}</table></div>`;
  }

  function render(data) {
    if (!data) return;
    if (participantEliminated || (!isHost && participantInLobby)) return;

    quizEnded = Boolean(data.quizEnded);
    monitoringStarted = Boolean(data.monitoringStarted) && !quizEnded && !participantEliminated;
    $('roomCode').textContent = 'ROOM: ' + data.roomCode;
    $('projectorRoom').textContent = 'ROOM: ' + data.roomCode;

    const teams = data.teams || [];
    const question = data.currentQuestion;
    const buzzes = data.buzzes || [];
    const questions = data.questions || [];

    const teamRows = teams.map(team => `
      <li>
        ${esc(team.name)}
        <span class="badge">
          ${team.memberCount} member${team.memberCount === 1 ? '' : 's'}
        </span>
      </li>
    `).join('');

    if ($('homeTeamCount')) $('homeTeamCount').textContent = teams.length;
    if ($('homeQuestionCount')) $('homeQuestionCount').textContent = data.questionCount ?? questions.length;
    const homePhaseLabels = { hidden: 'Waiting', reading: 'Reading', buzzer: 'Buzzer live', answering: 'Answering', 'awaiting-reveal': 'Review', revealed: 'Complete' };
    if ($('homeRoundStatus')) $('homeRoundStatus').textContent = homePhaseLabels[data.roundPhase] || 'Waiting';
    if ($('homeRoundHint')) $('homeRoundHint').textContent = data.buzzerOpen ? 'Teams can buzz now' : (data.roundPhase === 'hidden' ? 'Host will start the first round' : 'Round in progress');
    if ($('joinUrl') && $('joinQr')) {
      const joinUrl = window.location.origin + '/';
      $('joinUrl').textContent = joinUrl;
      $('joinQr').src = 'https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=8&data=' + encodeURIComponent(joinUrl);
      $('joinQr').alt = 'QR code for ' + joinUrl;
    }
    $('homeTeams').innerHTML = teams.length
      ? '<ol>' + teamRows + '</ol>'
      : '<div class="empty">No teams registered yet.</div>';

    $('publicTeams').innerHTML = teams.length
      ? '<ol>' + teamRows + '</ol>'
      : '<div class="empty">No teams registered yet.</div>';

    $('teamCount').textContent = teams.length;
    $('questionCount').textContent = data.questionCount ?? questions.length;
    $('buzzStatus').textContent = data.buzzerOpen ? 'OPEN' : 'Closed';
    if (buzzerCountdownInterval) clearInterval(buzzerCountdownInterval);
    const phaseLabels = { hidden: 'Waiting', reading: 'Read question', buzzer: 'Buzz now', answering: 'Submit answer', 'awaiting-reveal': 'Time up', revealed: 'Complete', ended: 'Test ended' };
    const updateRoundCountdown = () => {
      const remaining = data.roundDeadline ? Math.max(0, Math.ceil((data.roundDeadline - Date.now()) / 1000)) : 0;
      const value = data.roundDeadline ? `${phaseLabels[data.roundPhase] || 'Round'}: ${remaining}s` : (phaseLabels[data.roundPhase] || 'Waiting');
      ['buzzerTimer','teamTimer','projectorTimer'].forEach(id => { if ($(id)) $(id).textContent = value; });
      if (data.roundPhase !== lastSoundPhase) {
        lastSoundPhase = data.roundPhase;
        lastWarningSecond = null;
        if (['buzzer','answering','awaiting-reveal','revealed'].includes(data.roundPhase)) {
          playTone(data.roundPhase === 'revealed' ? 'reveal' : 'phase');
        }
      }
      if (data.roundDeadline && remaining > 0 && remaining <= 3 && remaining !== lastWarningSecond) {
        lastWarningSecond = remaining;
        playTone('warning');
      }
    };
    updateRoundCountdown();
    if (data.roundDeadline) buzzerCountdownInterval = setInterval(updateRoundCountdown, 250);

    $('questionNum').textContent = question
      ? `${data.currentIndex + 1}/${data.questionCount ?? questions.length}`
      : '—';

    if (isHost) {
      $('hostCurrent').innerHTML = renderQuestion(question, data.revealed, true);
      $('hostBuzzes').innerHTML = renderBuzzes(buzzes);
      $('hostAnswerPicks').innerHTML = renderHostAnswers(data.answers || [], teams, question, data.revealed, data.roundPhase);
      $('openBuzz').textContent = data.roundPhase === 'hidden' ? 'Reveal question / Start round' : 'Question round in progress';
      $('openBuzz').disabled = data.roundPhase !== 'hidden';
      $('closeBuzz').disabled = data.roundPhase !== 'buzzer';
      $('reveal').disabled = Boolean(data.revealed) || data.roundPhase !== 'awaiting-reveal';
      $('reveal').textContent = data.revealed ? 'Answer revealed' : 'Reveal answer & award points';
      $('endTest').disabled = Boolean(data.quizEnded);
      $('endTest').textContent = data.quizEnded ? 'Test ended' : 'End Test';

      const waitingTeams = teams.filter(team => !team.admitted);
      const admittedTeams = teams.filter(team => team.admitted);
      const teamRows = (items, waiting) => items.length ? table(`
        <thead><tr><th>Team</th><th>Members (private)</th><th>Representative</th><th>Score</th><th>Action</th></tr></thead>
        <tbody>${items.map(team => `
          <tr>
            <td><b>${esc(team.name)}</b></td>
            <td>${(team.members || []).map(member => `${esc(member.name)} <span class="muted">(${esc(member.reg)})</span>`).join('<br>')}</td>
            <td>${esc(team.members?.[team.repIndex]?.name || '—')}</td>
            <td>${team.score}</td>
            <td>${waiting ? `<button class="primary" data-admit-team="${esc(team.id)}">Admit to quiz</button>` : '<span class="badge">Admitted</span>'} <button class="danger" data-remove-team="${esc(team.id)}">Remove</button></td>
          </tr>`).join('')}</tbody>`) : '<div class="empty">None.</div>';
      $('hostTeams').innerHTML = `
        <div class="row spread">
          <h3>Waiting lobby (${waitingTeams.length})</h3>
          <button type="button" class="primary" id="admitAllTeams" ${waitingTeams.length ? '' : 'disabled'}>Admit All Teams</button>
        </div>
        ${teamRows(waitingTeams, true)}
        <h3>Admitted teams (${admittedTeams.length})</h3>${teamRows(admittedTeams, false)}
      `;
      $('admitAllTeams')?.addEventListener('click', () => {
        if (!waitingTeams.length) return;
        if (!confirm('Admit all ' + waitingTeams.length + ' waiting teams to the quiz?')) return;
        socket.emit('host:team:admit-all');
      });
      document.querySelectorAll('[data-admit-team]').forEach(button => {
        button.addEventListener('click', () => socket.emit('host:team:admit', { teamId: button.dataset.admitTeam }));
      });

      const violationRows = data.violations || [];
      $('hostViolations').innerHTML = violationRows.length
        ? table(`
          <thead><tr><th>Team</th><th>Violation</th><th>Reason</th><th>Status</th><th>Time</th></tr></thead>
          <tbody>${violationRows.map(item => `
            <tr>
              <td><b>${esc(item.team_name)}</b></td>
              <td>${item.violation_number} of 3</td>
              <td>${esc(item.reason)}</td>
              <td><span class="badge ${item.eliminated ? 'red' : 'warn'}">${item.eliminated ? 'Eliminated' : 'Warning'}</span></td>
              <td>${esc(item.created_at)}</td>
            </tr>
          `).join('')}</tbody>
        `)
        : '<div class="empty">No tab-switch warnings or eliminations recorded.</div>';

      document.querySelectorAll('[data-remove-team]').forEach(button => {
        button.addEventListener('click', () => {
          if (confirm('Remove this team?')) {
            socket.emit('host:team:delete', {
              teamId: button.dataset.removeTeam
            });
          }
        });
      });

      $('questionBank').innerHTML = questions.length
        ? table(`
          <thead>
            <tr>
              <th>#</th>
              <th>Question</th>
              <th>Correct</th>
              <th>Points</th>
              <th>Actions</th>
            </tr>
          </thead>

          <tbody>
            ${questions.map((item, index) => `
              <tr>
                <td>${index + 1}</td>
                <td>
                  ${esc(item.text)}
                  <br><span class="muted">${esc(item.category)}</span>
                </td>
                <td>${'ABCD'[item.correct]}. ${esc(item.options[item.correct])}</td>
                <td>${item.points}</td>
                <td>
                  <div class="actions">
                    <button data-edit="${esc(item.id)}">Edit</button>
                    <button data-up="${esc(item.id)}" ${index === 0 ? 'disabled' : ''}>↑</button>
                    <button data-down="${esc(item.id)}" ${index === questions.length - 1 ? 'disabled' : ''}>↓</button>
                    <button class="danger" data-delete="${esc(item.id)}">Delete</button>
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        `)
        : '<div class="empty">Add your first question using the form.</div>';

      document.querySelectorAll('[data-edit]').forEach(button => {
        button.addEventListener('click', () => {
          editQuestion(questions.find(item => item.id === button.dataset.edit));
        });
      });

      document.querySelectorAll('[data-delete]').forEach(button => {
        button.addEventListener('click', () => {
          if (confirm('Delete this question?')) {
            socket.emit('host:question:delete', {
              id: button.dataset.delete
            });
          }
        });
      });

      document.querySelectorAll('[data-up]').forEach(button => {
        button.addEventListener('click', () => {
          socket.emit('host:question:move', {
            id: button.dataset.up,
            delta: -1
          });
        });
      });

      document.querySelectorAll('[data-down]').forEach(button => {
        button.addEventListener('click', () => {
          socket.emit('host:question:move', {
            id: button.dataset.down,
            delta: 1
          });
        });
      });
    }

    $('projectorQuestion').innerHTML = renderQuestion(question, data.revealed, false);
    const stageLabels = { hidden: 'WAITING FOR HOST', reading: 'READ THE QUESTION', buzzer: 'BUZZER IS LIVE', answering: 'SUBMIT YOUR ANSWER', 'awaiting-reveal': 'ANSWERS LOCKED', revealed: 'ANSWER REVEALED' };
    const stageDurations = { reading: 20, buzzer: 10, answering: 15 };
    const stageLabel = stageLabels[data.roundPhase] || 'WAITING FOR HOST';
    if ($('stagePhaseBadge')) {
      $('stagePhaseBadge').innerHTML = '<span class="stage-status-dot"></span> ' + stageLabel;
      $('stagePhaseBadge').classList.toggle('phase-buzzer', data.roundPhase === 'buzzer');
    }
    if ($('stageQuestionCount')) $('stageQuestionCount').textContent = question ? 'QUESTION ' + (Number(data.currentIndex || 0) + 1) + ' / ' + (data.questionCount ?? questions.length) : 'QUESTION —';
    if ($('stageHint')) $('stageHint').textContent = data.roundPhase === 'buzzer' ? 'Buzz now! The fastest teams get to answer.' : data.roundPhase === 'answering' ? 'Selected teams: submit your answer before time runs out.' : data.roundPhase === 'awaiting-reveal' ? 'The host will reveal the correct answer shortly.' : data.roundPhase === 'revealed' ? 'Round complete. Check the correct answer on screen.' : data.roundPhase === 'reading' ? 'Read carefully. Get ready to buzz.' : 'The host will start the next round shortly.';
    const stageRemaining = data.roundDeadline ? Math.max(0, Math.ceil((data.roundDeadline - Date.now()) / 1000)) : 0;
    const stageTotal = stageDurations[data.roundPhase] || 0;
    if ($('stageSeconds')) $('stageSeconds').textContent = data.roundDeadline ? stageRemaining : '—';
    if ($('stageTimerRing')) $('stageTimerRing').style.setProperty('--timer-progress', (stageTotal ? Math.max(0, Math.min(1, stageRemaining / stageTotal)) * 360 : 0) + 'deg');
    if ($('stageProgress')) $('stageProgress').style.width = (stageTotal ? Math.max(0, Math.min(1, 1 - stageRemaining / stageTotal)) * 100 : data.revealed ? 100 : 0) + '%';
    if ($('projector').classList) $('projector').classList.toggle('buzzer-live', data.roundPhase === 'buzzer');


    $('projectorBuzzes').innerHTML = renderBuzzes(buzzes);

    $('buzzerQuestion').innerHTML = renderQuestion(question, data.revealed, false);
    $('projectorQuestion').innerHTML = renderQuestion(question, data.revealed, false);
    $('buzzerOrder').innerHTML = renderBuzzes(buzzes);

    const myTeam = teams.find(team => team.id === teamId);
    const myAnswer = (data.answers || []).find(answer => answer.teamId === teamId);
    const answerArea = $('teamAnswerArea');
    if (answerArea) {
      if (!myTeam || !data.questionVisible) {
        answerArea.innerHTML = '';
      } else if (data.revealed) {
        answerArea.innerHTML = `<div class="notice">Round complete. ${myAnswer?.isCorrect ? 'Correct answer — points awarded.' : 'No points for this question.'}</div>`;
      } else if (myAnswer) {
        answerArea.innerHTML = '<div class="notice">Answer submitted successfully. Wait for the host to reveal the result.</div>';
      } else if (data.roundPhase !== 'answering') {
        const phaseMessages = { reading: 'Read the question. The buzzer opens after 20 seconds.', buzzer: 'Buzzer is open. You can buzz now; answer submission starts after the buzzer window.', 'awaiting-reveal': 'Answer time is over. Wait for the host to reveal the result.' };
        answerArea.innerHTML = `<div class="notice">${phaseMessages[data.roundPhase] || 'Wait for the answer submission window.'}</div>`;
      } else {
        answerArea.innerHTML = `
          <div class="answer-pick"><h3>Submit your answer</h3><p>Choose one option and submit before the 15-second timer ends.</p>
            <label class="field"><span>Choose an option</span><select id="teamAnswerChoice" required>
              <option value="">Select A, B, C, or D…</option>
              ${(question?.options || []).map((option, index) => `<option value="${index}">${'ABCD'[index]}. ${esc(option)}</option>`).join('')}
            </select></label>
            <button type="button" class="primary" id="submitTeamAnswer">Submit Answer</button></div>`;
        $('submitTeamAnswer').addEventListener('click', () => {
          const choice = $('teamAnswerChoice').value;
          if (choice === '') return toast('Select an option before submitting.');
          $('submitTeamAnswer').disabled = true;
          socket.emit('team:answer:submit', { teamId, token: teamToken, optionIndex: Number(choice) });
        });
      }
    }

    $('teamSession').innerHTML = myTeam
      ? `
        <div class="notice">
          Using buzzer for <b>${esc(myTeam.name)}</b>.
          Representative: ${esc(myTeam.members?.[myTeam.repIndex]?.name || '')}
        </div>
      `
      : `
        <div class="notice warn">
          No team is linked to this browser yet.
          Register here first, using the representative phone.
        </div>
      `;

    $('buzzButton').disabled = !(myTeam && data.buzzerOpen && !data.revealed && !buzzes.some(buzz => buzz.teamId === teamId));
    if (!myTeam) {
      $('buzzerMessage').textContent = 'Register this device as a team representative first.';
    } else if (data.roundPhase === 'reading') {
      $('buzzerMessage').textContent = 'Read the question. Buzzer opens automatically after 20 seconds.';
    } else if (data.buzzerOpen && buzzes.some(buzz => buzz.teamId === teamId)) {
      $('buzzerMessage').textContent = 'Your team has buzzed. You can still submit your answer during the answer window.';
    } else if (data.buzzerOpen) {
      $('buzzerMessage').textContent = 'Buzzer is open for 10 seconds. Tap BUZZ if you wish.';
    } else if (data.roundPhase === 'answering') {
      $('buzzerMessage').textContent = 'Answer submission is open for 15 seconds.';
    } else if (data.roundPhase === 'awaiting-reveal') {
      $('buzzerMessage').textContent = 'Submission time has ended. Wait for the host to reveal the result.';
    } else {
      $('buzzerMessage').textContent = 'Waiting for the host to reveal the next question.';
    }

    // Live leaderboard.
    const sorted = [...teams].sort(
      (a, b) => b.score - a.score || a.name.localeCompare(b.name)
    );

    if ($('leaderboardPodium')) {
      const topThree = sorted.slice(0, 3);
      const medals = ['🥇', '🥈', '🥉'];
      const order = topThree.length >= 3 ? [1, 0, 2] : topThree.map((_, i) => i);
      $('leaderboardPodium').innerHTML = topThree.length
        ? order.map(index => {
            const team = topThree[index];
            return '<div class="podium-place ' + (index === 0 ? 'first' : '') + '">' +
              '<span class="podium-medal">' + medals[index] + '</span>' +
              '<b>' + esc(team.name) + '</b>' +
              '<strong>' + Number(team.score || 0) + ' pts</strong>' +
              '<small>' + (index === 0 ? 'CHAMPION POSITION' : 'RANK #' + (index + 1)) + '</small></div>';
          }).join('')
        : '<div class="podium-empty">The podium is waiting for its first competitors.</div>';
    }

    const winnerBanner = $('winnerAnnouncement');
    if (winnerBanner) {
      if (sorted.length) {
        const leaders = sorted.filter(team => Number(team.score || 0) === Number(sorted[0].score || 0));
        winnerBanner.hidden = false;
        winnerBanner.textContent = leaders.length > 1
          ? '🏆 Current tie for the lead: ' + leaders.map(team => team.name).join(' · ')
          : '🏆 Current leader: ' + sorted[0].name + ' — ' + Number(sorted[0].score || 0) + ' points';
      } else {
        winnerBanner.hidden = true;
      }
    }

    $('leaderboardTable').innerHTML = sorted.length
      ? table(`
        <thead>
          <tr>
            <th>Rank</th>
            <th>Team</th>
            <th>Members</th>
            <th>Score</th>
          </tr>
        </thead>

        <tbody>
          ${sorted.map((team, index) => `
            <tr>
              <td>${index === 0 ? '🏆 ' : ''}${index + 1}</td>
              <td><b>${esc(team.name)}</b></td>
              <td>${team.memberCount}</td>
              <td><b>${team.score}</b></td>
            </tr>
          `).join('')}
        </tbody>
      `)
      : '<div class="empty">Leaderboard appears when teams register.</div>';
  }

  function editQuestion(question) {
    if (!question) return;

    $('qId').value = question.id;
    $('qText').value = question.text;

    ['qA', 'qB', 'qC', 'qD'].forEach((id, index) => {
      $(id).value = question.options[index];
    });

    $('qCorrect').value = question.correct;
    $('qPoints').value = question.points;
    $('qCategory').value = question.category;
    $('qTime').value = question.time;

    view('host');
    $('qText').focus();
  }

  // Host controls.
  $('openBuzz').addEventListener('click', () => {
    socket.emit('host:quiz:show-question');
  });

  $('closeBuzz').addEventListener('click', () => {
    socket.emit('host:quiz:close-buzzer');
  });

  $('endTest').addEventListener('click', () => {
    if (!isHost) return toast('Host login required.');
    if (confirm('End the quiz now? This releases participants from tab monitoring and stops the current round.')) {
      socket.emit('host:quiz:end-test');
    }
  });

  $('exportViolations').addEventListener('click', () => {
    if (!isHost || !latest) return toast('Host login required.');
    const rows = [
      ['Team name', 'Violation number', 'Reason', 'Status', 'Timestamp'],
      ...(latest.violations || []).map(item => [
        item.team_name,
        item.violation_number,
        item.reason,
        item.eliminated ? 'Eliminated' : 'Warning',
        item.created_at
      ])
    ];
    downloadCSV('quiz-tab-switch-violations.csv', rows);
    toast('Participant violation report downloaded.');
  });

  $('reveal').addEventListener('click', () => {
    if (!isHost) {
      return toast('Host login required.');
    }

    if (confirm(
      'Reveal the correct answer and award points to every team that submitted the correct option before the 15-second deadline?'
    )) {
      socket.emit('host:quiz:reveal');
    }
  });

  $('nextQ').addEventListener('click', () => {
    socket.emit('host:quiz:next');
  });

  $('resetScores').addEventListener('click', () => {
    if (confirm('Reset all team scores?')) {
      socket.emit('host:scores:reset');
    }
  });

  $('exportTeams').addEventListener('click', () => {
    socket.emit('host:teams:export');
  });

  $('exportResults').addEventListener('click', () => {
    if (!isHost || !latest) return toast('Host login required.');
    const ranked = [...(latest.teams || [])].sort((a, b) =>
      Number(b.score || 0) - Number(a.score || 0) || String(a.name).localeCompare(String(b.name))
    );
    const rows = [
      ['Rank', 'Team', 'Members', 'Score', 'Result'],
      ...ranked.map((team, index) => [
        index + 1, team.name, team.memberCount, team.score,
        index === 0 && Number(team.score || 0) > 0 ? 'Current leader' : ''
      ])
    ];
    rows.push([]);
    rows.push(['Recent scoring history']);
    rows.push(['Team', 'Question ID', 'Points awarded', 'Timestamp']);
    (latest.history || []).forEach(item => {
      rows.push([item.team_name, item.question_id, item.points, item.created_at]);
    });
    downloadCSV('live-team-quiz-results.csv', rows);
    toast('Results report downloaded.');
  });

  function clearQuestionForm() {
    $('questionForm').reset();
    $('qId').value = '';
    $('qPoints').value = 10;
    $('qCategory').value = 'General';
    $('qTime').value = 30;
  }

  $('clearQuestion').addEventListener('click', clearQuestionForm);

  $('questionForm').addEventListener('submit', event => {
    event.preventDefault();

    if (!isHost) {
      return toast('Host login required.');
    }

    socket.emit('host:question:save', {
      id: $('qId').value || undefined,
      text: $('qText').value,
      options: [
        $('qA').value,
        $('qB').value,
        $('qC').value,
        $('qD').value
      ],
      correct: Number($('qCorrect').value),
      points: Number($('qPoints').value),
      category: $('qCategory').value,
      time: Number($('qTime').value)
    });

    clearQuestionForm();
    toast('Question submitted.');
  });

  function downloadCSV(filename, rows) {
    const content = rows.map(row =>
      row.map(value =>
        '"' + String(value ?? '').replace(/"/g, '""') + '"'
      ).join(',')
    ).join('\r\n');

    const link = document.createElement('a');

    link.href = URL.createObjectURL(
      new Blob([content], { type: 'text/csv;charset=utf-8' })
    );

    link.download = filename;
    link.click();

    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  $('exportQuestions').addEventListener('click', () => {
    if (!isHost || !latest) {
      return toast('Host login required.');
    }

    downloadCSV('quiz-questions.csv', [
      ['Question', 'A', 'B', 'C', 'D', 'Correct', 'Points', 'Category', 'Time'],
      ...latest.questions.map(question => [
        question.text,
        ...question.options,
        'ABCD'[question.correct],
        question.points,
        question.category,
        question.time
      ])
    ]);
  });

  function parseCSV(text) {
    const output = [];
    let row = [];
    let cell = '';
    let quoted = false;

    for (let index = 0; index < text.length; index++) {
      const char = text[index];

      if (char === '"' && quoted && text[index + 1] === '"') {
        cell += '"';
        index++;
      } else if (char === '"') {
        quoted = !quoted;
      } else if (char === ',' && !quoted) {
        row.push(cell);
        cell = '';
      } else if ((char === '\n' || char === '\r') && !quoted) {
        if (char === '\r' && text[index + 1] === '\n') index++;

        row.push(cell);

        if (row.some(value => value !== '')) {
          output.push(row);
        }

        row = [];
        cell = '';
      } else {
        cell += char;
      }
    }

    if (cell !== '' || row.length) {
      row.push(cell);
      output.push(row);
    }

    return output;
  }

  $('importQuestions').addEventListener('change', async event => {
    const file = event.target.files[0];

    if (!file) return;

    if (!isHost) {
      toast('Host login required.');
      return;
    }

    const rows = parseCSV(await file.text()).slice(1);
    let count = 0;

    for (const row of rows) {
      if (row.length < 8 || !row[0].trim()) continue;

      socket.emit('host:question:save', {
        text: row[0],
        options: row.slice(1, 5),
        correct: Math.max(
          0,
          'ABCD'.indexOf((row[5] || 'A').trim().toUpperCase())
        ),
        points: Number(row[6]) || 10,
        category: row[7] || 'General',
        time: Number(row[8]) || 30
      });

      count++;
    }

    toast(`Submitted ${count} question(s) for import.`);
    event.target.value = '';
  });

  // Team buzzer.
  $('buzzButton').addEventListener('click', () => {
    if (!teamId || !teamToken) {
      return toast('Register this device first.');
    }

    socket.emit('team:buzz', {
      teamId,
      token: teamToken
    });
  });

  // Team registration form.
  let memberRows = [];

  function renderMemberRows(preserve = true) {
    if (preserve) {
      memberRows = [...document.querySelectorAll('.member-row')].map(row => ({
        name: row.querySelector('.mname').value,
        reg: row.querySelector('.mreg').value
      }));
    }

    $('members').innerHTML = '';

    if (!memberRows.length) {
      memberRows = [
        { name: '', reg: '' },
        { name: '', reg: '' }
      ];
    }

    memberRows.forEach((member, index) => {
      const element = document.createElement('div');
      element.className = 'member-row';

      element.innerHTML = `
        <input
          class="mname"
          placeholder="Member ${index + 1} full name"
          maxlength="100"
          required
          value="${esc(member.name)}"
        >

        <input
          class="mreg"
          placeholder="Registration number"
          maxlength="40"
          required
          value="${esc(member.reg)}"
        >

        <button type="button" ${memberRows.length === 1 ? 'disabled' : ''}>
          −
        </button>
      `;

      element.querySelector('.mname').addEventListener(
        'input',
        updateRepOptions
      );

      element.querySelector('button').addEventListener('click', () => {
        memberRows = [...document.querySelectorAll('.member-row')].map(row => ({
          name: row.querySelector('.mname').value,
          reg: row.querySelector('.mreg').value
        }));

        memberRows.splice(index, 1);
      
  const copyJoinButton = $('copyJoinLink');
  if (copyJoinButton) {
    copyJoinButton.addEventListener('click', async () => {
      const url = window.location.origin + '/';
      try {
        await navigator.clipboard.writeText(url);
        toast('Join link copied.');
      } catch (_) {
        const helper = document.createElement('textarea');
        helper.value = url; helper.style.position = 'fixed'; helper.style.opacity = '0';
        document.body.appendChild(helper); helper.select();
        const copied = document.execCommand('copy'); helper.remove();
        toast(copied ? 'Join link copied.' : 'Copy failed. You can copy the address from the QR panel.');
      }
    });
  }


  const connectionStatus = document.getElementById('connectionStatus');
  let hostReconnectPending = Boolean(hostSessionToken);

  function updateConnectionStatus(online) {
    if (!connectionStatus) return;
    connectionStatus.classList.toggle('is-online', !!online);
    connectionStatus.classList.toggle('is-offline', !online);
    const label = connectionStatus.querySelector('.connection-label');
    if (label) label.textContent = online ? 'LIVE CONNECTION' : 'RECONNECTING…';
    connectionStatus.setAttribute('aria-label', online ? 'Connected to the live quiz server' : 'Disconnected from the live quiz server');
  }

  function requestHostReauthentication() {
    if (!hostReconnectPending) return;
    if (hostSessionToken) {
      socket.emit('host:resume', { token: hostSessionToken });
      return;
    }
    // Older sessions without a saved token must sign in once to create one.
    $('hostPanel').hidden = true;
    $('hostLogin').hidden = false;
  }

  updateConnectionStatus(socket.connected);
  socket.on('connect', () => {
    updateConnectionStatus(true);
    requestHostReauthentication();
  });
  socket.on('disconnect', () => {
    updateConnectionStatus(false);
    if (isHost || hostSessionToken) {
      hostReconnectPending = true;
      isHost = false;
      $('hostPanel').hidden = false;
      $('hostPanel').classList.add('host-reconnecting');
      $('hostLogin').hidden = true;
      view('host');
    }
  });
  socket.on('connect_error', () => updateConnectionStatus(false));

  renderMemberRows(false);
      });

      $('members').appendChild(element);
    });

    updateRepOptions();
  }

  function updateRepOptions() {
    const select = $('representative');
    const previous = select.value;

    select.innerHTML = '';

    [...document.querySelectorAll('.mname')].forEach((input, index) => {
      const option = document.createElement('option');

      option.value = index;
      option.textContent = input.value.trim() || `Member ${index + 1}`;

      select.appendChild(option);
    });

    if (previous && Number(previous) < select.options.length) {
      select.value = previous;
    }
  }

  $('addMember').addEventListener('click', () => {
    memberRows = [...document.querySelectorAll('.member-row')].map(row => ({
      name: row.querySelector('.mname').value,
      reg: row.querySelector('.mreg').value
    }));

    if (memberRows.length >= 10) {
      return toast('Maximum 10 members per team.');
    }

    memberRows.push({ name: '', reg: '' });
    renderMemberRows(false);
  });

  $('registerForm').addEventListener('submit', event => {
    event.preventDefault();

    const members = [...document.querySelectorAll('.member-row')].map(row => ({
      name: row.querySelector('.mname').value.trim(),
      reg: row.querySelector('.mreg').value.trim()
    }));

    socket.emit('team:register', {
      name: $('teamName').value.trim(),
      members,
      repIndex: Number($('representative').value)
    });
  });

  renderMemberRows(false);

  // Restore this team's representative session after refresh.
  if (teamId && teamToken) {
    socket.emit('team:resume', {
      teamId,
      token: teamToken
    });
  }
  if (window.location.pathname === '/buzzer' && teamId && teamToken) view('buzzer');
})();
