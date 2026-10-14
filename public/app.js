
(() => {
  const socket = io();
  const $ = id => document.getElementById(id);

  let latest = null;
  let isHost = false;
  let audioCtx = null;
  let toastTimer;
  let buzzerCountdownInterval = null;

  const TEAM_ID_KEY = 'liveQuizTeamId';
  const TEAM_TOKEN_KEY = 'liveQuizTeamToken';

  let teamId = localStorage.getItem(TEAM_ID_KEY) || '';
  let teamToken = localStorage.getItem(TEAM_TOKEN_KEY) || '';

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
    document.querySelectorAll('.view').forEach(element => {
      element.classList.toggle('active', element.id === name);
    });

    document.querySelectorAll('nav [data-view]').forEach(element => {
      element.classList.toggle('active', element.dataset.view === name);
    });

    if (name === 'host' && !isHost) {
      $('hostPin').focus();
    }
  }

  document.querySelectorAll('nav [data-view]').forEach(button => {
    button.addEventListener('click', () => view(button.dataset.view));
  });

  document.querySelectorAll('[data-go]').forEach(button => {
    button.addEventListener('click', () => view(button.dataset.go));
  });

  // Buzzer sound: host must enable sound with a click.
  function playBuzz() {
    try {
      const AudioContextClass =
        window.AudioContext || window.webkitAudioContext;

      if (!AudioContextClass) return;

      audioCtx = audioCtx || new AudioContextClass();

      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }

      const time = audioCtx.currentTime;
      const oscillator = audioCtx.createOscillator();
      const gain = audioCtx.createGain();

      oscillator.type = 'sawtooth';
      oscillator.frequency.setValueAtTime(880, time);
      oscillator.frequency.exponentialRampToValueAtTime(
        440,
        time + 0.23
      );

      gain.gain.setValueAtTime(0.0001, time);
      gain.gain.exponentialRampToValueAtTime(0.22, time + 0.015);
      gain.gain.setValueAtTime(0.17, time + 0.16);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.4);

      oscillator.connect(gain);
      gain.connect(audioCtx.destination);

      oscillator.start(time);
      oscillator.stop(time + 0.41);
    } catch (error) {
      console.warn('Could not play buzzer sound:', error);
    }
  }

  $('enableSound').addEventListener('click', () => {
    playBuzz();
    toast('Sound enabled in this browser.');
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

    $('hostLogin').hidden = true;
    $('hostPanel').hidden = false;
    $('resetScores').hidden = false;

    latest = data;
    render(data);

    toast('Host login successful.');
  });

  socket.on('state', data => {
    latest = data;
    render(data);
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
      playBuzz();
      toast(`🔊 ${data.teamName} buzzed — #${data.order}`);
    } else if (data.teamId === teamId) {
      $('buzzerMessage').textContent =
        `Buzz accepted! Your order is #${data.order}. Wait for the host.`;
    }
  });

  // Successful team registration.
  socket.on('team:registered', data => {
    teamId = data.teamId;
    teamToken = data.token;

    localStorage.setItem(TEAM_ID_KEY, teamId);
    localStorage.setItem(TEAM_TOKEN_KEY, teamToken);

    $('registerResult').innerHTML = `
      <div class="notice">
        Registered as <b>${esc(data.teamName)}</b>.
        This browser is now the team's buzzer device.
        Keep this browser storage.
      </div>
      <button type="button" class="primary" id="goBuzz">
        Open team buzzer
      </button>
    `;

    $('goBuzz').addEventListener('click', () => view('buzzer'));

    socket.emit('team:resume', {
      teamId,
      token: teamToken
    });

    toast('Team registered.');
  });

  socket.on('team:resume-ok', data => {
    teamId = data.teamId;
    render(latest);
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
  function renderHostAnswers(buzzes, question, revealed, answerModeOpen) {
    if (!buzzes?.length) return '<div class="empty">Waiting for teams to buzz.</div>';
    const firstTwo = buzzes.filter(buzz => buzz.order <= 2);
    return `
      <div class="answer-picks">
        ${firstTwo.map(buzz => `
          <div class="answer-pick">
            <b>Team ${buzz.order}: ${esc(buzz.teamName)}</b>
            <p class="muted small">${buzz.order === 1 ? 'First to buzz' : 'Second to buzz'}</p>
            <p>${buzz.submitted ? '<span class="badge green">Answer submitted</span>' : '<span class="badge">Waiting for answer</span>'}</p>
            ${revealed ? `<div class="notice ${buzz.isCorrect ? '' : 'warn'}">Submitted: <b>${buzz.selectedOption == null ? '—' : 'ABCD'[buzz.selectedOption]}</b><br>${buzz.isCorrect ? `Correct — ${question?.points || 1} points awarded` : 'Incorrect — 0 points'}</div>` : ''}
          </div>
        `).join('')}
      </div>
      <p class="muted small">${answerModeOpen ? 'Answer mode is unlocked. Eligible teams select an option on their own phones and submit.' : 'Wait for the buzzer timer to end or close the buzzer, then unlock answer mode.'}</p>
    `;
  }

  function table(rows) {
    return `<div class="table-wrap"><table>${rows}</table></div>`;
  }

  function render(data) {
    if (!data) return;

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

    $('homeTeams').innerHTML = teams.length
      ? '<ol>' + teamRows + '</ol>'
      : '<div class="empty">No teams registered yet.</div>';

    $('publicTeams').innerHTML = teams.length
      ? '<ol>' + teamRows + '</ol>'
      : '<div class="empty">No teams registered yet.</div>';

    $('teamCount').textContent = teams.length;
    $('questionCount').textContent = questions.length;
    $('buzzStatus').textContent = data.buzzerOpen ? 'OPEN' : 'Closed';
    if (buzzerCountdownInterval) clearInterval(buzzerCountdownInterval);
    const updateBuzzerCountdown = () => {
      const remaining = data.buzzerOpen && data.buzzerDeadline
        ? Math.max(0, Math.ceil((data.buzzerDeadline - Date.now()) / 1000))
        : 0;
      if ($('buzzerTimer')) $('buzzerTimer').textContent = data.buzzerOpen ? `${remaining}s` : '—';
    };
    updateBuzzerCountdown();
    if (data.buzzerOpen && data.buzzerDeadline) buzzerCountdownInterval = setInterval(updateBuzzerCountdown, 250);

    $('questionNum').textContent = question
      ? `${data.currentIndex + 1}/${questions.length}`
      : '—';

    if (isHost) {
      $('hostCurrent').innerHTML =
        renderQuestion(question, data.revealed, true);

      $('hostBuzzes').innerHTML = renderBuzzes(buzzes);
      $('hostAnswerPicks').innerHTML = renderHostAnswers(buzzes, question, data.revealed, data.answerModeOpen);

      const firstTwo = buzzes.filter(buzz => buzz.order <= 2);
      const allAnswersSubmitted = firstTwo.length > 0 && firstTwo.every(buzz => buzz.submitted);
      $('unlockAnswers').disabled = Boolean(data.revealed) || !firstTwo.length || Boolean(data.answerModeOpen);
      $('unlockAnswers').textContent = data.answerModeOpen ? 'Answer mode unlocked' : 'Unlock team answers';
      $('reveal').disabled = Boolean(data.revealed) || !allAnswersSubmitted;

      $('reveal').textContent = data.revealed
        ? 'Answer revealed'
        : 'Reveal answer & award points';

      $('hostTeams').innerHTML = teams.length
        ? table(`
          <thead>
            <tr>
              <th>Team</th>
              <th>Members (private)</th>
              <th>Representative</th>
              <th>Score</th>
              <th>Action</th>
            </tr>
          </thead>

          <tbody>
            ${teams.map(team => `
              <tr>
                <td><b>${esc(team.name)}</b></td>
                <td>
                  ${(team.members || []).map(member =>
                    `${esc(member.name)} <span class="muted">(${esc(member.reg)})</span>`
                  ).join('<br>')}
                </td>
                <td>${esc(team.members?.[team.repIndex]?.name || '—')}</td>
                <td>${team.score}</td>
                <td>
                  <button class="danger" data-remove-team="${esc(team.id)}">
                    Remove
                  </button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        `)
        : '<div class="empty">No teams registered yet.</div>';

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

    $('projectorQuestion').innerHTML =
      renderQuestion(question, data.revealed, false);

    $('projectorBuzzes').innerHTML = renderBuzzes(buzzes);

    $('buzzerQuestion').innerHTML =
      renderQuestion(question, data.revealed, false);

    $('buzzerOrder').innerHTML = renderBuzzes(buzzes);

    const myTeam = teams.find(team => team.id === teamId);
    const myBuzz = buzzes.find(buzz => buzz.teamId === teamId && buzz.order <= 2);
    const answerArea = $('teamAnswerArea');
    if (answerArea) {
      if (!myTeam || !myBuzz) {
        answerArea.innerHTML = '';
      } else if (data.revealed) {
        answerArea.innerHTML = '<div class="notice">Answer round finished. Check the revealed result.</div>';
      } else if (!data.answerModeOpen) {
        answerArea.innerHTML = '<div class="notice">You are eligible to answer. Waiting for the host to unlock answer mode.</div>';
      } else if (myBuzz.submitted) {
        answerArea.innerHTML = '<div class="notice">Your answer has been submitted. Wait for the host to reveal.</div>';
      } else {
        answerArea.innerHTML = `
          <div class="answer-pick">
            <h3>Submit your answer</h3>
            <p>Select your team's answer. You can submit only once.</p>
            <label class="field"><span>Choose an option</span>
              <select id="teamAnswerChoice" required>
                <option value="">Select A, B, C, or D…</option>
                ${(question?.options || []).map((option, index) => `<option value="${index}">${'ABCD'[index]}. ${esc(option)}</option>`).join('')}
              </select>
            </label>
            <button type="button" class="primary" id="submitTeamAnswer">Submit Answer</button>
          </div>
        `;
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

    $('buzzButton').disabled = !(
      myTeam &&
      data.buzzerOpen &&
      !data.revealed &&
      !buzzes.some(buzz => buzz.teamId === teamId)
    );

    if (!myTeam) {
      $('buzzerMessage').textContent =
        'Register this device as a team representative first.';
    } else if (!data.buzzerOpen) {
      $('buzzerMessage').textContent =
        'Waiting for the host to activate the buzzer.';
    } else if (buzzes.some(buzz => buzz.teamId === teamId)) {
      $('buzzerMessage').textContent =
        'Your team has already buzzed. Wait for the host.';
    } else if (buzzes.length >= 2) {
      $('buzzerMessage').textContent =
        'The first two teams have already buzzed.';
    } else {
      $('buzzerMessage').textContent =
        'Buzzer is open — tap once when you want to answer.';
    }

    // Live leaderboard.
    const sorted = [...teams].sort(
      (a, b) => b.score - a.score || a.name.localeCompare(b.name)
    );

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
    socket.emit('host:quiz:start-buzzer');
  });

  $('closeBuzz').addEventListener('click', () => {
    socket.emit('host:quiz:close-buzzer');
  });

  $('unlockAnswers').addEventListener('click', () => {
    socket.emit('host:answer-mode:unlock');
  });

  $('reveal').addEventListener('click', () => {
    if (!isHost) {
      return toast('Host login required.');
    }

    if (confirm(
      'Reveal the correct answer and automatically award points ' +
      'to each correct team among the first two buzzers?'
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
})();
