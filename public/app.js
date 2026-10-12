(() => {
const socket = io();
const $ = id => document.getElementById(id);
let latest = null, isHost = false, audioCtx = null, memberCount = 2, toastTimer;
const TEAM_ID_KEY='liveQuizTeamId', TEAM_TOKEN_KEY='liveQuizTeamToken';
let teamId=localStorage.getItem(TEAM_ID_KEY)||'', teamToken=localStorage.getItem(TEAM_TOKEN_KEY)||'';
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function toast(msg){$('toast').textContent=msg;$('toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('show'),3800);}
function view(name){document.querySelectorAll('.view').forEach(x=>x.classList.toggle('active',x.id===name));document.querySelectorAll('nav [data-view]').forEach(x=>x.classList.toggle('active',x.dataset.view===name));if(name==='host'&&!isHost)$('hostPin').focus();}
document.querySelectorAll('nav [data-view]').forEach(b=>b.addEventListener('click',()=>view(b.dataset.view)));
document.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>view(b.dataset.go)));
function playBuzz(){try{const AC=window.AudioContext||window.webkitAudioContext;if(!AC)return;audioCtx=audioCtx||new AC();if(audioCtx.state==='suspended')audioCtx.resume();const t=audioCtx.currentTime,o=audioCtx.createOscillator(),g=audioCtx.createGain();o.type='sawtooth';o.frequency.setValueAtTime(880,t);o.frequency.exponentialRampToValueAtTime(440,t+.23);g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(.22,t+.015);g.gain.setValueAtTime(.17,t+.16);g.gain.exponentialRampToValueAtTime(.0001,t+.4);o.connect(g);g.connect(audioCtx.destination);o.start(t);o.stop(t+.41);}catch(e){console.warn(e);}}
$('enableSound').addEventListener('click',()=>{playBuzz();toast('Sound enabled in this browser.');});
$('loginForm').addEventListener('submit',e=>{e.preventDefault();socket.emit('host:login',{pin:$('hostPin').value});});
socket.on('host:login-ok',data=>{isHost=true;$('hostLogin').hidden=true;$('hostPanel').hidden=false;$('resetScores').hidden=false;latest=data;render(data);toast('Host login successful.');});
socket.on('state',data=>{latest=data;render(data);});
socket.on('host:state',data=>{if(isHost){latest=data;render(data);}});
socket.on('app:error',data=>toast(data?.message||'Something went wrong.'));
socket.on('buzz:accepted',data=>{if(isHost){playBuzz();toast(`🔊 ${data.teamName} buzzed — #${data.order}`);}else if(data.teamId===teamId){$('buzzerMessage').textContent='Buzz accepted! Your order is #'+data.order+'. Wait for the host.';}});
socket.on('team:registered',data=>{teamId=data.teamId;teamToken=data.token;localStorage.setItem(TEAM_ID_KEY,teamId);localStorage.setItem(TEAM_TOKEN_KEY,teamToken);$('registerResult').innerHTML=`<div class="notice">Registered as <b>${esc(data.teamName)}</b>. This browser is now the team's buzzer device. Keep this browser storage; your buzzer token is saved locally.</div><button type="button" class="primary" id="goBuzz">Open team buzzer</button>`;$('goBuzz').addEventListener('click',()=>view('buzzer'));socket.emit('team:resume',{teamId,token:teamToken});toast('Team registered.');});
socket.on('team:resume-ok',data=>{teamId=data.teamId;render(latest);});
socket.on('host:teams-export',teams=>{const rows=[['Team','Member name','Registration number','Representative','Score']];teams.forEach(t=>t.members.forEach((m,i)=>rows.push([t.name,m.name,m.reg,i===t.repIndex?'Yes':'No',t.score])));downloadCSV('registered-teams.csv',rows);});

function renderQuestion(q,revealed=false,host=false){
 if(!q)return '<div class="empty">Waiting for the host to publish a question.</div>';
 return `<div class="row"><span class="badge">${esc(q.category||'General')}</span><span class="badge">${q.points||10} points</span>${host?`<span class="badge">${q.time||30} sec</span>`:''}</div><div class="question-title">${esc(q.text)}</div><div class="options">${(q.options||[]).map((o,i)=>`<div class="option ${revealed&&Number(q.correct)===i?'correct':''}"><b>${'ABCD'[i]}</b>${esc(o)}</div>`).join('')}</div>${revealed&&q.correct!==undefined?`<p class="notice">Correct answer: <b>${'ABCD'[q.correct]}. ${esc(q.options[q.correct])}</b></p>`:''}`;
}
function renderBuzzes(buzzes,host=false){if(!buzzes?.length)return '<div class="empty">No teams have buzzed yet.</div>';return '<ol>'+buzzes.map(b=>`<li><b>${esc(b.teamName)}</b> — buzz #${b.order} ${b.awarded?'<span class="badge green">Points awarded</span>':''} ${host&&!b.awarded?`<button class="good" data-award="${b.teamId}">Mark correct & award points</button>`:''}</li>`).join('')+'</ol>';}
function table(rows){return `<div class="table-wrap"><table>${rows}</table></div>`;}
function render(data){
 if(!data)return;
 $('roomCode').textContent='ROOM: '+data.roomCode;$('projectorRoom').textContent='ROOM: '+data.roomCode;
 const teams=data.teams||[],q=data.currentQuestion,buzzes=data.buzzes||[];
 const teamRows=teams.map(t=>`<li>${esc(t.name)} <span class="badge">${t.memberCount} member${t.memberCount===1?'':'s'}</span></li>`).join('');
 $('homeTeams').innerHTML=teams.length?'<ol>'+teamRows+'</ol>':'<div class="empty">No teams registered yet.</div>';
 $('publicTeams').innerHTML=teams.length?'<ol>'+teamRows+'</ol>':'<div class="empty">No teams registered yet.</div>';
 $('teamCount').textContent=teams.length;$('questionCount').textContent=(data.questions||[]).length;$('buzzStatus').textContent=data.buzzerOpen?'OPEN':'Closed';$('questionNum').textContent=q?`${data.currentIndex+1}/${data.questions.length}`:'—';
 if(isHost){
  $('hostCurrent').innerHTML=renderQuestion(q,data.revealed,true);
  $('hostBuzzes').innerHTML=renderBuzzes(buzzes,true);
  document.querySelectorAll('[data-award]').forEach(b=>b.addEventListener('click',()=>{if(confirm('Award points to this team for a correct answer?'))socket.emit('host:score:award',{teamId:b.dataset.award});}));
  $('hostTeams').innerHTML=teams.length?table('<thead><tr><th>Team</th><th>Members (private)</th><th>Representative</th><th>Score</th><th>Action</th></tr></thead><tbody>'+teams.map(t=>`<tr><td><b>${esc(t.name)}</b></td><td>${(t.members||[]).map(m=>`${esc(m.name)} <span class="muted">(${esc(m.reg)})</span>`).join('<br>')}</td><td>${esc(t.members?.[t.repIndex]?.name||'—')}</td><td>${t.score}</td><td><button class="danger" data-remove-team="${t.id}">Remove</button></td></tr>`).join('')+'</tbody>'):'<div class="empty">No teams registered yet.</div>';
  document.querySelectorAll('[data-remove-team]').forEach(b=>b.addEventListener('click',()=>{if(confirm('Remove this team?'))socket.emit('host:team:delete',{teamId:b.dataset.removeTeam});}));
  $('questionBank').innerHTML=data.questions.length?table('<thead><tr><th>#</th><th>Question</th><th>Correct</th><th>Points</th><th>Actions</th></tr></thead><tbody>'+data.questions.map((x,i)=>`<tr><td>${i+1}</td><td>${esc(x.text)}<br><span class="muted">${esc(x.category)}</span></td><td>${'ABCD'[x.correct]}. ${esc(x.options[x.correct])}</td><td>${x.points}</td><td><div class="actions"><button data-edit="${x.id}">Edit</button><button data-up="${x.id}" ${i===0?'disabled':''}>↑</button><button data-down="${x.id}" ${i===data.questions.length-1?'disabled':''}>↓</button><button class="danger" data-delete="${x.id}">Delete</button></div></td></tr>`).join('')+'</tbody>'):'<div class="empty">Add your first question using the form.</div>';
  document.querySelectorAll('[data-edit]').forEach(b=>b.addEventListener('click',()=>editQuestion(data.questions.find(q=>q.id===b.dataset.edit))));
  document.querySelectorAll('[data-delete]').forEach(b=>b.addEventListener('click',()=>{if(confirm('Delete this question?'))socket.emit('host:question:delete',{id:b.dataset.delete});}));
  document.querySelectorAll('[data-up]').forEach(b=>b.addEventListener('click',()=>socket.emit('host:question:move',{id:b.dataset.up,delta:-1})));
  document.querySelectorAll('[data-down]').forEach(b=>b.addEventListener('click',()=>socket.emit('host:question:move',{id:b.dataset.down,delta:1})));
 }
 $('projectorQuestion').innerHTML=renderQuestion(q,data.revealed,false);$('projectorBuzzes').innerHTML=renderBuzzes(buzzes,false);
 $('buzzerQuestion').innerHTML=renderQuestion(q,data.revealed,false);$('buzzerOrder').innerHTML=renderBuzzes(buzzes,false);
 const myTeam=teams.find(t=>t.id===teamId);
 $('teamSession').innerHTML=myTeam?`<div class="notice">Using buzzer for <b>${esc(myTeam.name)}</b>. Representative: ${esc(myTeam.members?.[myTeam.repIndex]?.name||'')}</div>`:'<div class="notice warn">No team is linked to this browser yet. Register here first, using the representative phone.</div>';
 $('buzzButton').disabled=!(myTeam&&data.buzzerOpen&&!data.revealed&&!buzzes.some(b=>b.teamId===teamId));
 if(!myTeam)$('buzzerMessage').textContent='Register this device as a team representative first.';
 else if(!data.buzzerOpen)$('buzzerMessage').textContent='Waiting for the host to activate the buzzer.';
 else if(buzzes.some(b=>b.teamId===teamId))$('buzzerMessage').textContent='Your team has already buzzed. Wait for the host.';
 else $('buzzerMessage').textContent='Buzzer is open — tap once when you want to answer.';
 const sorted=[...teams].sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name));
 $('leaderboardTable').innerHTML=sorted.length?table('<thead><tr><th>Rank</th><th>Team</th><th>Members</th><th>Score</th></tr></thead><tbody>'+sorted.map((t,i)=>`<tr><td>${i===0?'🏆 ':''}${i+1}</td><td><b>${esc(t.name)}</b></td><td>${t.memberCount}</td><td><b>${t.score}</b></td></tr>`).join('')+'</tbody>'):'<div class="empty">Leaderboard appears when teams register.</div>';
}
function editQuestion(q){if(!q)return;$('qId').value=q.id;$('qText').value=q.text;['qA','qB','qC','qD'].forEach((id,i)=>$(id).value=q.options[i]);$('qCorrect').value=q.correct;$('qPoints').value=q.points;$('qCategory').value=q.category;$('qTime').value=q.time;view('host');$('qText').focus();}
$('openBuzz').addEventListener('click',()=>socket.emit('host:quiz:start-buzzer'));
$('closeBuzz').addEventListener('click',()=>socket.emit('host:quiz:close-buzzer'));
$('reveal').addEventListener('click',()=>socket.emit('host:quiz:reveal'));
$('nextQ').addEventListener('click',()=>socket.emit('host:quiz:next'));
$('resetScores').addEventListener('click',()=>{if(confirm('Reset all team scores?'))socket.emit('host:scores:reset');});
$('exportTeams').addEventListener('click',()=>socket.emit('host:teams:export'));
function clearQuestionForm(){$('questionForm').reset();$('qId').value='';$('qPoints').value=10;$('qCategory').value='General';$('qTime').value=30;}
$('clearQuestion').addEventListener('click',clearQuestionForm);
$('questionForm').addEventListener('submit',e=>{e.preventDefault();if(!isHost)return toast('Host login required.');socket.emit('host:question:save',{id:$('qId').value||undefined,text:$('qText').value,options:[$('qA').value,$('qB').value,$('qC').value,$('qD').value],correct:Number($('qCorrect').value),points:Number($('qPoints').value),category:$('qCategory').value,time:Number($('qTime').value)});clearQuestionForm();toast('Question saved.');});
function downloadCSV(name,rows){const content=rows.map(r=>r.map(v=>'"'+String(v??'').replace(/"/g,'""')+'"').join(',')).join('\r\n');const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([content],{type:'text/csv;charset=utf-8'}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
$('exportQuestions').addEventListener('click',()=>{if(!isHost||!latest)return;downloadCSV('quiz-questions.csv',[['Question','A','B','C','D','Correct','Points','Category','Time'],...latest.questions.map(q=>[q.text,...q.options,'ABCD'[q.correct],q.points,q.category,q.time])]);});
function parseCSV(s){const out=[];let row=[],cell='',quoted=false;for(let i=0;i<s.length;i++){const c=s[i];if(c==='"'&&quoted&&s[i+1]==='"'){cell+='"';i++;}else if(c==='"')quoted=!quoted;else if(c===','&&!quoted){row.push(cell);cell='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&s[i+1]==='\n')i++;row.push(cell);if(row.some(x=>x!==''))out.push(row);row=[];cell='';}else cell+=c;}if(cell!==''||row.length){row.push(cell);out.push(row);}return out;}
$('importQuestions').addEventListener('change',async e=>{const file=e.target.files[0];if(!file)return;if(!isHost){toast('Host login required.');return;}const rows=parseCSV(await file.text()).slice(1);let n=0;for(const r of rows){if(r.length<8||!r[0].trim())continue;socket.emit('host:question:save',{text:r[0],options:r.slice(1,5),correct:Math.max(0,'ABCD'.indexOf((r[5]||'A').trim().toUpperCase())),points:Number(r[6])||10,category:r[7]||'General',time:Number(r[8])||30});n++;}toast('Submitted '+n+' question(s) for import.');e.target.value='';});
$('buzzButton').addEventListener('click',()=>{if(!teamId||!teamToken)return toast('Register this device first.');socket.emit('team:buzz',{teamId,token:teamToken});});
let memberRows=[];
function renderMemberRows(preserve=true){if(preserve)memberRows=[...document.querySelectorAll('.member-row')].map(r=>({name:r.querySelector('.mname').value,reg:r.querySelector('.mreg').value}));$('members').innerHTML='';memberCount=Math.max(1,memberRows.length||2);if(!memberRows.length)memberRows=[{name:'',reg:''},{name:'',reg:''}];memberRows.forEach((m,i)=>{const d=document.createElement('div');d.className='member-row';d.innerHTML=`<input class="mname" placeholder="Member ${i+1} full name" maxlength="100" required value="${esc(m.name)}"><input class="mreg" placeholder="Registration number" maxlength="40" required value="${esc(m.reg)}"><button type="button" ${memberRows.length===1?'disabled':''}>−</button>`;d.querySelector('.mname').addEventListener('input',updateRepOptions);d.querySelector('button').addEventListener('click',()=>{memberRows=[...document.querySelectorAll('.member-row')].map(r=>({name:r.querySelector('.mname').value,reg:r.querySelector('.mreg').value}));memberRows.splice(i,1);renderMemberRows(false);});$('members').appendChild(d);});updateRepOptions();}
function updateRepOptions(){const s=$('representative'),prev=s.value;s.innerHTML='';[...document.querySelectorAll('.mname')].forEach((n,i)=>{const o=document.createElement('option');o.value=i;o.textContent=n.value.trim()||`Member ${i+1}`;s.appendChild(o);});if(prev&&Number(prev)<s.options.length)s.value=prev;}
$('addMember').addEventListener('click',()=>{memberRows=[...document.querySelectorAll('.member-row')].map(r=>({name:r.querySelector('.mname').value,reg:r.querySelector('.mreg').value}));if(memberRows.length>=10)return toast('Maximum 10 members per team.');memberRows.push({name:'',reg:''});renderMemberRows(false);});
$('registerForm').addEventListener('submit',e=>{e.preventDefault();const members=[...document.querySelectorAll('.member-row')].map(r=>({name:r.querySelector('.mname').value.trim(),reg:r.querySelector('.mreg').value.trim()}));socket.emit('team:register',{name:$('teamName').value.trim(),members,repIndex:Number($('representative').value)});});
renderMemberRows(false);
if(teamId&&teamToken)socket.emit('team:resume',{teamId,token:teamToken});
})();
