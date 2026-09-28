(function(){
"use strict";

/* ================= constants ================= */
var CATEGORIES = ['Professional','Personal','Health','Social'];
var PRIORITIES = ['Critical','High','Medium','Low'];
var STATUSES = ['Planned','In Progress','Done','Cancelled'];
var PRIORITY_POINTS = {Critical:5, High:4, Medium:3, Low:2};
function priorityPoints(p){ return PRIORITY_POINTS[p] || 3; }
var CAT_KEYWORDS = {
  Professional: ['work','meeting','call','bloomberg','job','interview','forum','townhall','client','conference','presentation','fca','aprg'],
  Health: ['gym','doctor','surgery','physio','pilates','dentist','workout','run','yoga','medicine','discharge','checkup'],
  Social: ['friend','party','dinner','anniversary','family','birthday','wedding','outing'],
};
var WEEKDAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
var WEEKDAY_KEYS = ['sun','mon','tue','wed','thu','fri','sat'];

var ENCOURAGEMENTS = [
  "Small steps today add up to the goals that matter most.",
  "You don't have to do it all today — just the next right thing.",
  "Progress, not perfection. Every item you clear is momentum.",
  "Clear one thing at a time and the day gets lighter.",
  "You're building something real, one focused day at a time.",
  "Rest is part of the plan too — pace beats sprinting.",
  "Today's effort is tomorrow's ease. Keep going.",
];

/* ================= state ================= */
var state = {
  events: [],
  goals: [],
  checkins: [],
  checkinPoints: {},
  bestStreak: 0,
  activity: [],
  tab: 'today',
  goalFilter: 'all',
  plannerView: 'upcoming',
  weekOffset: 0,
  db: null,
  ready: false,
  routine: {},
  sky: null,
  uid: null,
  health: null,
  healthDay: null,
};

var todayStr = ymd(new Date());

function ymd(d){
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
function parseYmd(s){
  var p = s.split('-'); return new Date(parseInt(p[0]),parseInt(p[1])-1,parseInt(p[2]));
}
function addDays(d, n){ var r = new Date(d); r.setDate(r.getDate()+n); return r; }
function effectiveDate(ev){
  if(!ev.recurringAnnual) return ev.date;
  var stored = parseYmd(ev.date);
  var todayD = parseYmd(todayStr);
  var candidate = new Date(todayD.getFullYear(), stored.getMonth(), stored.getDate());
  if(candidate < todayD) candidate = new Date(todayD.getFullYear()+1, stored.getMonth(), stored.getDate());
  return ymd(candidate);
}
function daysUntil(dateStr){
  return Math.round((parseYmd(dateStr) - parseYmd(todayStr)) / 86400000);
}
function fmtDateLong(d){
  return d.toLocaleDateString(undefined, {weekday:'long', month:'long', day:'numeric'});
}
function fmtDateShort(dstr){
  var d = parseYmd(dstr);
  var diff = daysUntil(dstr);
  if(diff===0) return 'Today';
  if(diff===1) return 'Tomorrow';
  return d.toLocaleDateString(undefined,{weekday:'short', month:'short', day:'numeric'});
}

/* ================= local fallback storage (used only if Firebase can't init) ================= */
var LS_KEY = 'northstar_local_v1';
function loadLocal(){
  try{ var raw = localStorage.getItem(LS_KEY); if(raw) return JSON.parse(raw); }catch(e){}
  return null;
}
function saveLocal(){
  try{ localStorage.setItem(LS_KEY, JSON.stringify({events:state.events, goals:state.goals, checkins:state.checkins, checkinPoints:state.checkinPoints, bestStreak:state.bestStreak, activity:state.activity})); }catch(e){}
}

/* ================= firebase init ================= */
document.getElementById('todayDate').textContent = fmtDateLong(new Date());

function showApp(){
  document.getElementById('bootScreen').hidden = true;
  document.getElementById('app').hidden = false;
  document.getElementById('tabbar').hidden = false;
  document.getElementById('fabAdd').hidden = false;
}

function makeScopedDb(uid, fs){
  var base = 'users/' + uid;
  return {
    collection: function(name){ return fs.collection(base + '/' + name); },
    doc: function(path){ return fs.doc(base + '/' + path); },
  };
}

async function seedIfEmpty(db){
  try{
    var snap = await db.collection('events').limit(1).get();
    if(!snap.empty) return; // already has data
  }catch(e){ console.warn('seed check failed', e); return; }

  try{
    var res = await fetch('seed-data.json');
    if(!res.ok) return;
    var seed = await res.json();
    var batch = firebase.firestore().batch();
    var base = 'users/' + state.uid;
    (seed.events||[]).forEach(function(ev){
      var id = ev.id; var data = Object.assign({}, ev); delete data.id;
      batch.set(firebase.firestore().doc(base + '/events/' + id), data);
    });
    (seed.goals||[]).forEach(function(g){
      var id = g.id; var data = Object.assign({}, g); delete data.id;
      batch.set(firebase.firestore().doc(base + '/goals/' + id), data);
    });
    Object.keys(seed.routine||{}).forEach(function(day){
      batch.set(firebase.firestore().doc(base + '/routine/' + day), seed.routine[day]);
    });
    batch.set(firebase.firestore().doc(base + '/meta/checkins'), {dates: seed.checkins||[], points: seed.checkinPoints||{}, bestStreak: seed.bestStreak||0});
    batch.set(firebase.firestore().doc(base + '/meta/activity'), {items: seed.activity||[]});
    await batch.commit();
    console.log('Northstar: seeded initial data for this account.');
  }catch(e){ console.warn('seed failed', e); }
}

async function init(){
  if(typeof firebase === 'undefined' || !window.firebaseConfig){
    return initLocalFallback();
  }
  try{
    firebase.initializeApp(window.firebaseConfig);
    var auth = firebase.auth();
    var fs = firebase.firestore();

    auth.onAuthStateChanged(function(user){
      if(user){ onSignedIn(user, fs); }
    });
    await auth.signInAnonymously();
  }catch(e){
    console.warn('Firebase init failed, falling back to local storage', e);
    initLocalFallback();
  }
}

async function onSignedIn(user, fs){
  state.uid = user.uid;
  var db = makeScopedDb(user.uid, fs);
  state.db = db;

  await seedIfEmpty(db);

  db.collection('events').onSnapshot(function(snap){
    state.events = snap.docs.map(function(d){ return Object.assign({id:d.id}, d.data()); });
    renderAll();
  }, function(err){ console.warn('events sub error', err); });

  db.collection('goals').onSnapshot(function(snap){
    state.goals = snap.docs.map(function(d){ return Object.assign({id:d.id}, d.data()); });
    renderAll();
  }, function(err){ console.warn('goals sub error', err); });

  db.doc('meta/checkins').onSnapshot(function(snap){
    var d = snap.exists ? snap.data() : {};
    state.checkins = d.dates || [];
    state.checkinPoints = d.points || {};
    state.bestStreak = d.bestStreak || 0;
    renderAll();
  }, function(err){ console.warn('checkins sub error', err); });

  db.doc('meta/activity').onSnapshot(function(snap){
    state.activity = (snap.exists && snap.data().items) || [];
    renderAll();
  }, function(err){ console.warn('activity sub error', err); });

  db.collection('routine').onSnapshot(function(snap){
    var map = {};
    snap.docs.forEach(function(d){ map[d.id] = d.data(); });
    state.routine = map;
    renderAll();
  }, function(err){ console.warn('routine sub error', err); });

  state.ready = true;
  showApp();
  renderAll();
  loadSkyData();
  loadHealthData();
}

/* Sky/weather data is written by a scheduled background check into a static
   JSON file in this same repo (see sky-data.json) rather than into Firestore
   directly — the background job runs in a sandboxed environment that can
   reach GitHub but not arbitrary Google Cloud APIs, so pushing a file via
   git is the reliable path. The app just re-fetches it on load. */
function loadSkyData(){
  fetch('sky-data.json?_=' + Date.now()).then(function(r){ return r.ok ? r.json() : null; }).then(function(data){
    if(data){ state.sky = data; renderAll(); }
  }).catch(function(){ /* no sky data yet, that's fine */ });
}

/* Health Buddy data (diet + exercise plan, daily tips) is a static JSON file
   in this repo, fetched client-side — same pattern as sky-data.json. This
   means it shows up immediately for every account regardless of what's
   already seeded in that account's Firestore, and it's updated just by
   editing/committing health-data.json. */
function loadHealthData(){
  fetch('health-data.json?_=' + Date.now()).then(function(r){ return r.ok ? r.json() : null; }).then(function(data){
    if(data){ state.health = data; renderAll(); }
  }).catch(function(){ /* no health data yet, that's fine */ });
}

function initLocalFallback(){
  document.getElementById('offlineBanner').hidden = false;
  var local = loadLocal();
  if(local){
    state.events = local.events||[];
    state.goals = local.goals||[];
    state.checkins = local.checkins||[];
    state.checkinPoints = local.checkinPoints||{};
    state.bestStreak = local.bestStreak||0;
    state.activity = local.activity||[];
  } else {
    fetch('seed-data.json').then(function(r){ return r.json(); }).then(function(seed){
      state.events = seed.events||[];
      state.goals = seed.goals||[];
      state.checkins = seed.checkins||[];
      state.checkinPoints = seed.checkinPoints||{};
      state.bestStreak = seed.bestStreak||0;
      state.activity = seed.activity||[];
      state.routine = seed.routine||{};
      saveLocal();
      renderAll();
    }).catch(function(){});
  }
  state.ready = true;
  showApp();
  renderAll();
  loadSkyData();
  loadHealthData();
}

/* ================= write helpers (work with db or local) ================= */
async function addEvent(ev){
  ev.createdAt = new Date().toISOString();
  if(state.db){
    await state.db.collection('events').add(ev);
  }else{
    ev.id = 'evt-' + Date.now();
    state.events.push(ev);
    saveLocal(); renderAll();
  }
}
async function updateEvent(id, patch){
  if(state.db){
    await state.db.collection('events').doc(id).update(patch);
  }else{
    var e = state.events.find(function(x){return x.id===id;});
    if(e) Object.assign(e, patch);
    saveLocal(); renderAll();
  }
}
async function updateGoal(id, patch){
  if(state.db){
    await state.db.collection('goals').doc(id).update(patch);
  }else{
    var g = state.goals.find(function(x){return x.id===id;});
    if(g) Object.assign(g, patch);
    saveLocal(); renderAll();
  }
}
async function logActivity(text, type){
  var entry = {ts: new Date().toISOString(), type: type||'info', text: text};
  var items = [entry].concat(state.activity).slice(0,40);
  if(state.db){
    await state.db.doc('meta/activity').set({items: items});
  }else{
    state.activity = items; saveLocal(); renderAll();
  }
}
function computeStreakFromDates(dates){
  var set = {}; (dates||[]).forEach(function(d){set[d]=true;});
  var streak = 0;
  var cursor = parseYmd(todayStr);
  if(!set[ymd(cursor)]){ cursor = addDays(cursor, -1); }
  while(set[ymd(cursor)]){ streak++; cursor = addDays(cursor, -1); }
  return streak;
}
async function checkinToday(pts){
  pts = pts || 0;
  var alreadyToday = state.checkins.indexOf(todayStr) !== -1;
  var dates = alreadyToday ? state.checkins.slice() : state.checkins.concat([todayStr]).slice(-400);
  var points = Object.assign({}, state.checkinPoints);
  points[todayStr] = (points[todayStr]||0) + pts;
  var cutoff = ymd(addDays(parseYmd(todayStr), -120));
  Object.keys(points).forEach(function(d){ if(d < cutoff) delete points[d]; });
  var best = Math.max(state.bestStreak||0, computeStreakFromDates(dates));
  if(state.db){
    await state.db.doc('meta/checkins').set({dates: dates, points: points, bestStreak: best});
  }else{
    state.checkins = dates; state.checkinPoints = points; state.bestStreak = best; saveLocal(); renderAll();
  }
}

async function markEventDone(id, done){
  var ev = state.events.find(function(x){return x.id===id;});
  await updateEvent(id, {status: done ? 'Done' : 'Planned'});
  if(done){
    var pts = priorityPoints(ev ? ev.priority : 'Medium');
    await checkinToday(pts);
    logActivity('Completed "'+(ev?ev.entry:'task')+'" (+'+pts+' pts)', 'complete');
  }
}
async function toggleSubAction(goalId, idx, done){
  var g = state.goals.find(function(x){return x.id===goalId;});
  if(!g) return;
  var pts = priorityPoints(g.priority);
  var subs = (g.subActions||[]).map(function(s,i){
    if(i!==idx) return s;
    var ns = Object.assign({}, s, {done: done});
    if(done) ns.timesLogged = (s.timesLogged||0) + 1;
    return ns;
  });
  var allDone = subs.length>0 && subs.every(function(s){return s.done;});
  var anyDone = subs.some(function(s){return s.done;});
  var status = allDone ? 'Done' : (anyDone ? 'In Progress' : 'Not started');
  var newPoints = (g.points||0) + (done ? pts : 0);
  await updateGoal(goalId, {subActions: subs, status: status, points: newPoints});
  if(done){ await checkinToday(pts); logActivity('Completed "'+g.title+'": '+subs[idx].text+' (+'+pts+' pts)', 'complete'); }
}
async function logSubActionProgress(goalId, idx){
  var g = state.goals.find(function(x){return x.id===goalId;});
  if(!g) return;
  var pts = priorityPoints(g.priority);
  var subs = (g.subActions||[]).map(function(s,i){ return i===idx ? Object.assign({}, s, {timesLogged:(s.timesLogged||0)+1}) : s; });
  var newPoints = (g.points||0) + pts;
  await updateGoal(goalId, {subActions: subs, points: newPoints});
  await checkinToday(pts);
  logActivity('Logged progress on "'+g.title+'": '+subs[idx].text+' (+'+pts+' pts)', 'complete');
}
async function addSubAction(goalId, text){
  var g = state.goals.find(function(x){return x.id===goalId;});
  if(!g || !text.trim()) return;
  var subs = (g.subActions||[]).concat([{text:text.trim(), done:false}]);
  await updateGoal(goalId, {subActions: subs});
  logActivity('Added goal action: '+text.trim(), 'add');
}
async function editSubAction(goalId, idx, newText){
  var g = state.goals.find(function(x){return x.id===goalId;});
  if(!g || !g.subActions || !g.subActions[idx]) return;
  var text = (newText||'').trim();
  if(!text) return;
  var oldText = g.subActions[idx].text;
  var subs = g.subActions.map(function(s,i){ return i===idx ? Object.assign({}, s, {text: text}) : s; });
  await updateGoal(goalId, {subActions: subs});
  logActivity('Edited "'+oldText+'" to "'+text+'"', 'edit');
}
async function deleteSubAction(goalId, idx){
  var g = state.goals.find(function(x){return x.id===goalId;});
  if(!g || !g.subActions || !g.subActions[idx]) return;
  var removedText = g.subActions[idx].text;
  var subs = g.subActions.filter(function(s,i){ return i!==idx; });
  var allDone = subs.length>0 && subs.every(function(s){return s.done;});
  var anyDone = subs.some(function(s){return s.done;});
  var status = subs.length ? (allDone ? 'Done' : (anyDone ? 'In Progress' : 'Not started')) : g.status;
  await updateGoal(goalId, {subActions: subs, status: status});
  logActivity('Deleted goal action: '+removedText, 'delete');
}
async function deleteEvent(id){
  var ev = state.events.find(function(x){return x.id===id;});
  if(state.db){
    await state.db.collection('events').doc(id).delete();
  }else{
    state.events = state.events.filter(function(x){return x.id!==id;});
    saveLocal(); renderAll();
  }
  logActivity('Deleted "'+(ev?ev.entry:'item')+'"', 'delete');
}

/* ================= derived data ================= */
function computeStreak(){
  return computeStreakFromDates(state.checkins);
}
function eventsInRange(startOffset, endOffset){
  var start = ymd(addDays(parseYmd(todayStr), startOffset));
  var end = ymd(addDays(parseYmd(todayStr), endOffset));
  return state.events.filter(function(e){ var d = effectiveDate(e); return d >= start && d <= end; })
    .sort(function(a,b){ return (effectiveDate(a)+String(a.startTime||'')).localeCompare(effectiveDate(b)+String(b.startTime||'')); });
}
function openGoalsCount(){
  return state.goals.filter(function(g){ return g.status !== 'Done'; }).length;
}
function criticalToPrep(){
  return state.events.filter(function(e){
    var d = effectiveDate(e);
    return e.status!=='Done' && e.status!=='Cancelled' && (e.priority==='Critical' || e.prepNeeded) && d >= todayStr && d <= ymd(addDays(parseYmd(todayStr),14));
  });
}

/* ================= proactive recommendation engine =================
   Unifies calendar events AND goal sub-actions into one scored list so the
   app can proactively surface "do this next" rather than just listing
   everything flatly. This is what drives the Today tab's focus card and
   the overload/heads-up warnings. */
function computeRecommendations(){
  var candidates = [];
  var priWeight = {Critical:40, High:25, Medium:10, Low:2};

  state.events.forEach(function(e){
    if(e.status==='Done' || e.status==='Cancelled') return;
    var d = effectiveDate(e);
    var du = daysUntil(d);
    var score = priWeight[e.priority]!=null ? priWeight[e.priority] : 10;
    var reason;
    if(du < 0){ score += 120; reason = 'Overdue since '+fmtDateShort(d); }
    else if(du === 0){ score += 70; reason = 'Due today'; }
    else if(du <= 2){ score += 35; reason = 'Due '+fmtDateShort(d); }
    else if(du <= 7){ score += 12; reason = 'Coming up '+fmtDateShort(d); }
    else { reason = fmtDateShort(d); }
    if(e.prepNeeded && du>=0 && du<=3){ score += 28; reason = 'Needs prep — '+e.prepNeeded; }
    candidates.push({type:'event', id:e.id, title:e.entry, score:score, reason:reason});
  });

  state.goals.forEach(function(g){
    if(g.status==='Done') return;
    var subs = g.subActions||[];
    var openIdx = subs.findIndex(function(s){ return !s.done; });
    if(openIdx===-1) return;
    var doneCt = subs.filter(function(s){return s.done;}).length;
    var pct = subs.length ? doneCt/subs.length : 0;
    var score = (priWeight[g.priority]!=null?priWeight[g.priority]:10) * 0.7;
    var reason;
    if(pct===0){ score += 14; reason = 'Kick off "'+g.title+'"'; }
    else { reason = 'Keep momentum on "'+g.title+'"'; }
    candidates.push({type:'sub', goalId:g.id, idx:openIdx, title: subs[openIdx].text, score:score, reason:reason});
  });

  candidates.sort(function(a,b){ return b.score - a.score; });
  return candidates.slice(0,4);
}

function computeHeadsUp(){
  var msgs = [];
  var today = eventsInRange(0,0).filter(function(e){return e.status!=='Cancelled' && e.status!=='Done';});
  if(today.length >= 5){
    msgs.push('You have '+today.length+' open items today. Consider moving anything not Critical/High to tomorrow.');
  }
  var critSoon = state.events.filter(function(e){
    var du = daysUntil(effectiveDate(e));
    return e.status!=='Done' && e.status!=='Cancelled' && e.priority==='Critical' && du>=0 && du<=3;
  });
  if(critSoon.length >= 2){
    msgs.push(critSoon.length+' critical items land in the next 3 days: '+critSoon.map(function(e){return e.entry;}).join(', ')+'.');
  }
  var overdue = state.events.filter(function(e){
    return e.status!=='Done' && e.status!=='Cancelled' && daysUntil(effectiveDate(e)) < 0;
  });
  if(overdue.length){
    msgs.push(overdue.length+' item'+(overdue.length===1?'':'s')+' overdue: '+overdue.slice(0,3).map(function(e){return e.entry;}).join(', ')+(overdue.length>3?'…':'')+'.');
  }
  return msgs;
}

function goalNeedsFocus(g){
  if(g.status==='Done') return false;
  var subs = g.subActions||[];
  var doneCt = subs.filter(function(s){return s.done;}).length;
  return (g.priority==='Critical' || g.priority==='High') && doneCt===0 && subs.length>0;
}

/* ================= calendar link ================= */
function googleCalUrl(ev){
  var d = effectiveDate(ev).replace(/-/g,'');
  var startStr, endStr;
  if(ev.startTime){
    var t = parseTimeLoose(ev.startTime);
    if(t){
      var hh = String(t.h).padStart(2,'0'), mm = String(t.m).padStart(2,'0');
      startStr = d + 'T' + hh + mm + '00';
      var endH = (t.h+1) % 24;
      endStr = d + 'T' + String(endH).padStart(2,'0') + mm + '00';
    }
  }
  if(!startStr){
    startStr = d;
    endStr = ymd(addDays(parseYmd(effectiveDate(ev)),1)).replace(/-/g,'');
  }
  var params = new URLSearchParams({
    action: 'TEMPLATE',
    text: ev.entry || 'Reminder',
    dates: startStr + '/' + endStr,
    details: [ev.notes, ev.prepNeeded ? ('Prep needed: '+ev.prepNeeded) : ''].filter(Boolean).join('\n'),
    location: ev.location || ''
  });
  return 'https://calendar.google.com/calendar/render?' + params.toString();
}
function parseTimeLoose(str){
  if(!str) return null;
  str = String(str).trim().toLowerCase();
  var m = str.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if(!m) return null;
  var h = parseInt(m[1],10), min = m[2]?parseInt(m[2],10):0, ap = m[3];
  if(ap==='pm' && h<12) h+=12;
  if(ap==='am' && h===12) h=0;
  return {h:h, m:min};
}
function looksLikeTime(str){ return !!parseTimeLoose(str); }

/* ================= rendering ================= */
function catChipClass(pri){
  if(pri==='Critical') return 'chip pri-critical';
  if(pri==='High') return 'chip pri-high';
  return 'chip';
}

function eventRow(ev, opts){
  opts = opts||{};
  var done = ev.status === 'Done';
  var timeLabel = ev.startTime ? ev.startTime : (opts.showDate ? '' : 'All day');
  return (
    '<div class="item-row" data-evid="'+ev.id+'">' +
      '<button class="check '+(done?'done':'')+'" data-action="toggle-event" data-id="'+ev.id+'">'+(done?'✓':'')+'</button>' +
      '<div class="item-body">' +
        '<div class="item-title '+(done?'done':'')+'">'+escapeHtml(ev.entry||'(untitled)')+'</div>' +
        '<div class="item-meta">' +
          (opts.showDate ? '<span class="chip time">'+fmtDateShort(effectiveDate(ev))+'</span>' : '') +
          (timeLabel ? '<span class="chip time">'+escapeHtml(timeLabel)+'</span>' : '') +
          '<span class="chip">'+escapeHtml(ev.category||'Personal')+'</span>' +
          (ev.priority && ev.priority!=='Medium' ? '<span class="'+catChipClass(ev.priority)+'">'+ev.priority+'</span>' : '') +
          (ev.recurringAnnual ? '<span class="chip">🔁 Yearly</span>' : '') +
        '</div>' +
        (ev.prepNeeded ? '<div style="margin-top:6px;font-size:12.5px;color:var(--ink-dim);">Prep: '+escapeHtml(ev.prepNeeded)+'</div>' : '') +
        '<a class="cal-btn" href="'+googleCalUrl(ev)+'" target="_blank" rel="noopener">📅 Add to Calendar</a>' +
      '</div>' +
      '<div class="item-actions">' +
        '<button class="icon-btn" data-action="edit-event" data-id="'+ev.id+'" title="Edit">✎</button>' +
        '<button class="icon-btn" data-action="delete-event" data-id="'+ev.id+'" title="Delete">🗑</button>' +
      '</div>' +
    '</div>'
  );
}

function spawnFloatingPoints(x, y, text){
  var el = document.createElement('div');
  el.className = 'floatpoint';
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(function(){ el.remove(); }, 950);
}
function escapeHtml(s){
  return String(s==null?'':s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}

function renderStatStrip(){
  var today = eventsInRange(0,0).filter(function(e){return e.status!=='Cancelled';});
  var next7 = eventsInRange(1,7).filter(function(e){return e.status!=='Cancelled';});
  var next30 = eventsInRange(1,30).filter(function(e){return e.status!=='Cancelled';});
  var crit = criticalToPrep();
  var openGoals = openGoalsCount();
  var tiles = [
    {n: today.length, l:'Today', tab:'today'},
    {n: next7.length, l:'Next 7 days', tab:'planner'},
    {n: next30.length, l:'Next 30 days', tab:'planner'},
    {n: crit.length, l:'Critical prep', tab:'planner', warn:true},
    {n: openGoals, l:'Open goals', tab:'goals'},
  ];
  document.getElementById('statStrip').innerHTML = tiles.map(function(t){
    return '<button class="stat-tile '+(t.warn&&t.n>0?'warn':'')+'" data-goto="'+t.tab+'"><div class="n">'+t.n+'</div><div class="l">'+t.l+'</div></button>';
  }).join('');
}

function renderEncouragement(){
  document.getElementById('streakCount').textContent = computeStreak();
  var today = eventsInRange(0,0).filter(function(e){return e.status!=='Cancelled';});
  var doneToday = today.filter(function(e){return e.status==='Done';}).length;
  var line;
  if(today.length===0){
    line = "Nothing scheduled today — a good moment to move a goal forward.";
  } else if(doneToday === today.length){
    line = "Today's agenda is clear. " + pick(ENCOURAGEMENTS);
  } else {
    line = doneToday + ' of ' + today.length + ' done today. ' + pick(ENCOURAGEMENTS);
  }
  document.getElementById('encourageLine').textContent = line;
}
function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }

function renderRoutineCard(){
  var key = WEEKDAY_KEYS[new Date().getDay()];
  var r = state.routine[key];
  if(!r || !r.blocks || !r.blocks.length) return '';
  var html = '<div class="section" style="margin-top:8px;"><div class="section-head"><h2>Your routine today</h2>' +
    (r.mode ? '<span class="chip">'+escapeHtml(r.mode)+'</span>' : '') + '</div>';
  html += '<div class="card">' + r.blocks.map(function(b){
    return '<div class="item-row"><div class="item-body" style="display:flex;gap:12px;align-items:flex-start;">' +
      '<div class="mono" style="flex:0 0 auto;min-width:56px;color:var(--ink-dim);font-size:12.5px;padding-top:1px;">'+escapeHtml(b.time||'')+'</div>' +
      '<div style="flex:1;"><div style="font-weight:600;font-size:14.5px;">'+escapeHtml(b.label)+'</div>' +
      (b.note ? '<div style="font-size:12.5px;color:var(--ink-dim);margin-top:2px;">'+escapeHtml(b.note)+'</div>' : '') +
      '</div></div></div>';
  }).join('') + '</div></div>';
  return html;
}

function renderFocusCard(){
  var recs = computeRecommendations();
  if(!recs.length) return '';
  var html = '<div class="section" style="margin-top:8px;"><div class="focus-card">';
  html += '<h2>🎯 Do this next</h2>';
  html += '<div style="margin-top:10px;">';
  recs.forEach(function(r, i){
    var dataAttrs = r.type==='event' ? 'data-action="focus-complete-event" data-id="'+r.id+'"' : 'data-action="focus-complete-sub" data-goal="'+r.goalId+'" data-idx="'+r.idx+'"';
    html += '<div class="focus-item">' +
      '<div class="focus-num">'+(i+1)+'</div>' +
      '<div class="focus-body"><div class="focus-title">'+escapeHtml(r.title)+'</div><div class="focus-reason">'+escapeHtml(r.reason)+'</div></div>' +
      '<button class="icon-btn" style="color:#fff;" '+dataAttrs+' title="Mark done">✓</button>' +
    '</div>';
  });
  html += '</div>';
  var headsUp = computeHeadsUp();
  headsUp.forEach(function(m){
    html += '<div class="warn-banner">⚠️ '+escapeHtml(m)+'</div>';
  });
  html += '</div></div>';
  return html;
}

function skyVerdictColor(v){
  if(v==='good') return 'success';
  if(v==='fair') return 'accent';
  return 'dim';
}
function renderSkyPanel(){
  var s = state.sky;
  if(!s){
    return '<div style="margin-top:12px;padding:12px;border-radius:12px;background:var(--info-bg);font-size:12.5px;color:var(--ink-dim);">' +
      'Sky check hasn’t run yet — a weekly outlook and a same-day check will populate this once the scheduled checks kick in.</div>';
  }
  var html = '<div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line);">';
  html += '<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;color:var(--ink-dim);margin-bottom:8px;">Sky conditions — Highgate</div>';
  if(s.tonight){
    var t = s.tonight;
    var tColor = t.verdict==='good' ? 'var(--success)' : (t.verdict==='fair' ? 'var(--accent)' : 'var(--ink-dim)');
    html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">' +
      '<span style="width:9px;height:9px;border-radius:50%;background:'+tColor+';flex:0 0 auto;"></span>' +
      '<div style="font-size:13.5px;font-weight:600;">Tonight: '+escapeHtml(t.verdict==='good' ? 'Good — worth setting up' : (t.verdict==='fair' ? 'Fair' : 'Not great'))+
      ' <span class="mono" style="font-weight:500;color:var(--ink-dim);">('+ (t.cloudCoverPct!=null?t.cloudCoverPct+'% cloud':'?') +(t.moonIlluminationPct!=null?', '+t.moonIlluminationPct+'% moon':'')+')</span></div>' +
    '</div>';
  }
  if(s.nights && s.nights.length){
    html += '<div style="display:flex;flex-direction:column;gap:6px;">';
    s.nights.slice(0,7).forEach(function(n){
      var color = n.verdict==='good' ? 'var(--success)' : (n.verdict==='fair' ? 'var(--accent)' : 'var(--line)');
      html += '<div style="display:flex;justify-content:space-between;align-items:center;font-size:12.5px;">' +
        '<span>'+fmtDateShort(n.date)+'</span>' +
        '<span class="mono" style="color:var(--ink-dim);">'+(n.cloudCoverPct!=null?n.cloudCoverPct+'% cloud':'?')+(n.moonIlluminationPct!=null?' · '+n.moonIlluminationPct+'% moon':'')+'</span>' +
        '<span style="width:8px;height:8px;border-radius:50%;background:'+color+';"></span>' +
      '</div>';
    });
    html += '</div>';
  }
  if(s.summary){
    html += '<div style="margin-top:10px;font-size:12.5px;color:var(--ink-dim);">'+escapeHtml(s.summary)+'</div>';
  }
  html += '<div style="margin-top:8px;font-size:11px;color:var(--ink-dim);">Updated '+new Date(s.generatedAt).toLocaleString(undefined,{weekday:'short',hour:'numeric',minute:'2-digit'})+'</div>';
  html += '</div>';
  return html;
}

function tipOfDay(){
  if(!state.health || !state.health.tips || !state.health.tips.length) return null;
  var d = parseYmd(todayStr);
  var startOfYear = new Date(d.getFullYear(), 0, 0);
  var doy = Math.floor((d - startOfYear) / 86400000);
  return state.health.tips[doy % state.health.tips.length];
}

/* ================= "Let's do this now champ" — live schedule ================= */
var HB_TIME_KEYWORDS = [
  ['am commute', 8*60],
  ['pm commute', 17*60+30],
  ["morning (wfh day)", 7*60+30],
  ['late morning/afternoon', 11*60+30],
  ['lunchtime or evening', 12*60+45],
  ['lunchtime', 12*60+45],
  ['thursday evening', 18*60+30],
  ['morning', 7*60+30],
  ['evening', 19*60]
];
var HB_MEAL_TIMES = {
  'breakfast': [7*60+30],
  'lunch-weekday': [12*60+30],
  'dinner': [19*60],
  'snacks-drinks': [11*60, 16*60+30]
};
function hbTimeToMinutes(raw){
  if(!raw) return null;
  var s = raw.toLowerCase();
  for(var i=0;i<HB_TIME_KEYWORDS.length;i++){
    if(s.indexOf(HB_TIME_KEYWORDS[i][0])!==-1) return HB_TIME_KEYWORDS[i][1];
  }
  return null;
}
function hbDurationMinutes(raw){
  if(!raw) return 30;
  var m = raw.match(/(\d+)/);
  return m ? Math.max(parseInt(m[1],10), 15) : 30;
}
function hbBuildTimeline(dayKey){
  var items = [];
  var exList = (state.health && state.health.weeklyExercise && state.health.weeklyExercise[dayKey]) || [];
  exList.forEach(function(b, idx){
    var t = (b.time||'').toLowerCase();
    if(t.indexOf('any time')!==-1) return;
    if(t.indexOf('am/pm commute')!==-1){
      items.push({minutes:8*60, endMinutes:8*60+15, title:b.title+' (morning leg)', sub:b.location, kind:'exercise', dayKey:dayKey, idx:idx});
      items.push({minutes:17*60+30, endMinutes:17*60+45, title:b.title+' (evening leg)', sub:b.location, kind:'exercise', dayKey:dayKey, idx:idx});
      return;
    }
    var mins = hbTimeToMinutes(b.time);
    if(mins==null) return;
    var dur = hbDurationMinutes(b.duration);
    items.push({minutes:mins, endMinutes:mins+dur, title:b.title, sub:(b.location||'')+(b.duration?' · '+b.duration:''), kind:'exercise', dayKey:dayKey, idx:idx});
  });
  var db = state.health && state.health.dietBooklet;
  if(db){
    var isWeekday = ['mon','tue','wed','thu','fri'].indexOf(dayKey)!==-1;
    (db.sections||[]).forEach(function(sec){
      if(sec.id==='avoid') return;
      if(sec.id==='lunch-weekday' && !isWeekday) return;
      var starts = HB_MEAL_TIMES[sec.id];
      if(!starts) return;
      starts.forEach(function(mins){
        items.push({minutes:mins, endMinutes:mins+45, title:sec.title, sub:'Tap to see options in the diet booklet', kind:'meal', sectionId:sec.id});
      });
    });
  }
  items.sort(function(a,b){ return a.minutes-b.minutes; });
  return items;
}
function hbNowNext(){
  if(!state.health) return null;
  var now = new Date();
  var nowMinutes = now.getHours()*60 + now.getMinutes();
  var dayKey = WEEKDAY_KEYS[now.getDay()];
  var timeline = hbBuildTimeline(dayKey);
  var current = null, upcoming = [];
  for(var i=0;i<timeline.length;i++){
    var it = timeline[i];
    if(it.minutes<=nowMinutes && nowMinutes<it.endMinutes && !current){ current = it; continue; }
    if(it.minutes>nowMinutes){ upcoming.push(it); }
  }
  if(upcoming.length < 2){
    var tomorrowKey = WEEKDAY_KEYS[(now.getDay()+1)%7];
    var tomorrowTimeline = hbBuildTimeline(tomorrowKey);
    tomorrowTimeline.forEach(function(it){
      if(upcoming.length<2){ upcoming.push({minutes:it.minutes, endMinutes:it.endMinutes, title:it.title, sub:it.sub, kind:it.kind, dayKey:it.dayKey, idx:it.idx, sectionId:it.sectionId, tomorrow:true}); }
    });
  }
  return {current:current, next:upcoming.slice(0,2)};
}
function hbFmtTime(mins){
  var h = Math.floor(mins/60)%24, m = mins%60;
  var ap = h<12 ? 'am' : 'pm';
  var h12 = h%12; if(h12===0) h12=12;
  return h12 + (m ? ':'+(m<10?'0':'')+m : '') + ap;
}
function hbChampRow(it, label){
  var dataAttrs = it.kind==='exercise' ? 'data-action="ex-detail" data-day="'+it.dayKey+'" data-idx="'+it.idx+'"' : 'data-action="health-view" data-view="diet"';
  return '<div class="item-row" '+dataAttrs+' style="cursor:pointer;"><div class="item-body">' +
    '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">' +
      '<div><div style="font-size:11px;font-weight:700;color:var(--focus);text-transform:uppercase;letter-spacing:.03em;">'+escapeHtml(label)+(it.tomorrow?' · tomorrow':'')+'</div>' +
      '<div class="item-title" style="margin-top:2px;">'+escapeHtml(it.title)+'</div></div>' +
      '<span class="chip time" style="flex:0 0 auto;">'+hbFmtTime(it.minutes)+'</span>' +
    '</div>' +
    (it.sub ? '<div style="font-size:12.5px;color:var(--ink-dim);margin-top:4px;">'+escapeHtml(it.sub)+'</div>' : '') +
  '</div></div>';
}
function renderChampCard(){
  if(!state.health) return '';
  var nn = hbNowNext();
  if(!nn || (!nn.current && !nn.next.length)) return '';
  var html = '<div class="section" style="margin-top:8px;"><div class="focus-card">';
  html += '<h2>🙌 Let’s do this now champ</h2>';
  html += '<div class="card" style="margin-top:10px;">';
  if(nn.current){ html += hbChampRow(nn.current, 'Right now'); }
  nn.next.forEach(function(it, i){ html += hbChampRow(it, i===0 && !nn.current ? 'Up next' : (i===0 ? 'Then' : 'After that')); });
  html += '</div></div></div>';
  return html;
}

function renderToday(){
  var today = eventsInRange(0,0).filter(function(e){return e.status!=='Cancelled';});
  var crit = criticalToPrep().slice(0,4);
  var html = '';
  var tip = tipOfDay();
  if(tip){
    html += '<div class="section" style="margin-top:8px;"><div class="card" style="padding:14px 16px;background:var(--focus-bg);border-color:var(--focus);">' +
      '<div style="font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.03em;color:var(--focus);">💡 Thought for today</div>' +
      '<div style="font-size:13.5px;margin-top:5px;line-height:1.4;">'+escapeHtml(tip)+'</div>' +
      '<button class="link-btn" data-goto="health" style="padding-left:0;margin-top:6px;">See full plan →</button>' +
    '</div></div>';
  }
  if(state.sky && state.sky.tonight && state.sky.tonight.verdict==='good'){
    html += '<div class="section" style="margin-top:8px;"><div class="card" style="padding:14px 16px;background:var(--success-bg);border-color:var(--success);">' +
      '<div style="font-weight:700;font-size:14px;">✨ Good astrophotography conditions tonight</div>' +
      '<div style="font-size:12.5px;color:var(--ink-dim);margin-top:3px;">Clear-ish skies and low moon over Highgate — worth setting up the Dwarf 3. See Goals for details.</div>' +
    '</div></div>';
  }
  html += renderChampCard();
  html += renderFocusCard();
  html += renderRoutineCard();
  html += '<div class="section"><div class="section-head"><h2>Today’s agenda</h2><button class="icon-btn" data-action="speak-today" title="Read agenda aloud" aria-label="Read agenda aloud">🔊</button></div>';
  if(today.length===0){
    html += '<div class="empty">Nothing scheduled today. Tap + to add something, or check your goals for a next step.</div>';
  } else {
    html += '<div class="card">' + today.map(function(e){return eventRow(e,{});}).join('') + '</div>';
  }
  html += '</div>';

  if(crit.length){
    html += '<div class="section"><div class="section-head"><h2>Needs preparation</h2></div>';
    html += '<div class="card">' + crit.map(function(e){return eventRow(e,{showDate:true});}).join('') + '</div></div>';
  }

  var next7 = eventsInRange(1,7).filter(function(e){return e.status!=='Cancelled';}).slice(0,5);
  html += '<div class="section"><div class="section-head"><h2>Coming up</h2><button class="link-btn" data-goto="planner">See all</button></div>';
  if(next7.length===0){
    html += '<div class="empty">Nothing in the next 7 days yet.</div>';
  } else {
    html += '<div class="card">' + next7.map(function(e){return eventRow(e,{showDate:true});}).join('') + '</div>';
  }
  html += '</div>';

  document.getElementById('mainContent').innerHTML = html;
}

function renderPlanner(){
  var view = state.plannerView || 'upcoming';
  var html = '<div class="section" style="margin-top:8px;">';
  html += '<div class="filter-pills">' +
    '<button class="fpill '+(view==='upcoming'?'active':'')+'" data-action="planner-view" data-view="upcoming">Upcoming</button>' +
    '<button class="fpill '+(view==='week'?'active':'')+'" data-action="planner-view" data-view="week">Week plan</button>' +
  '</div>';
  if(view==='week'){
    html += renderWeekItinerary();
  } else {
    var upcoming = eventsInRange(0, 60).filter(function(e){return e.status!=='Cancelled';});
    var byDate = {};
    upcoming.forEach(function(e){ var d = effectiveDate(e); (byDate[d] = byDate[d]||[]).push(e); });
    var dates = Object.keys(byDate).sort();
    if(dates.length===0){
      html += '<div class="empty">No upcoming items in the next 60 days. Tap + to add one.</div>';
    } else {
      dates.forEach(function(d){
        html += '<div class="section-head" style="margin-top:18px;"><h2 style="font-size:15px;">'+fmtDateShort(d)+' · '+parseYmd(d).toLocaleDateString(undefined,{month:'short',day:'numeric'})+'</h2></div>';
        html += '<div class="card">' + byDate[d].map(function(e){return eventRow(e,{});}).join('') + '</div>';
      });
    }
  }
  html += '</div>';
  document.getElementById('mainContent').innerHTML = html;
}

function currentWeekMonday(){
  var d = parseYmd(todayStr);
  var dow = d.getDay(); // 0=Sun..6=Sat
  var offsetToMonday = dow===0 ? -6 : (1-dow);
  var monday = addDays(d, offsetToMonday);
  if(dow===0 || dow===6){ monday = addDays(monday, 7); } // weekend: show the week ahead
  return monday;
}

function goalTagForBlock(label){
  var l = (label||'').toLowerCase();
  if(l.indexOf('recovery')!==-1 || l.indexOf('gym')!==-1 || l.indexOf('tennis')!==-1) return '🏃 Health & Fitness';
  if(l.indexOf('job search')!==-1 || l.indexOf('job-search')!==-1 || l.indexOf('job checkpoint')!==-1) return '💼 New Job';
  if(l.indexOf('wife')!==-1) return '🤝 Support Wife';
  if(l.indexOf('family')!==-1 || l.indexOf('outing')!==-1) return '👨‍👩‍👧 Family Time';
  if(l.indexOf('finance')!==-1 || l.indexOf('house admin')!==-1) return '💰 Finances';
  if(l.indexOf('reva')!==-1 || l.indexOf('miraya')!==-1 || l.indexOf('reasoning')!==-1 || l.indexOf('drama')!==-1) return '🎓 Kids';
  if(l.indexOf('astro')!==-1) return '🔭 Astrophotography';
  return '';
}

function weekOffsetBounds(){
  var base = currentWeekMonday();
  var yearEnd = new Date(base.getFullYear(), 11, 31);
  var maxWeeks = Math.max(0, Math.floor((yearEnd - base) / (7*86400000)));
  return {min: 0, max: maxWeeks};
}
function renderWeekItinerary(){
  var bounds = weekOffsetBounds();
  state.weekOffset = Math.max(bounds.min, Math.min(bounds.max, state.weekOffset||0));
  var monday = addDays(currentWeekMonday(), state.weekOffset*7);
  var dayDefs = [['mon','Monday'],['tue','Tuesday'],['wed','Wednesday'],['thu','Thursday'],['fri','Friday'],['sat','Saturday'],['sun','Sunday']];
  var rangeLabel = 'Mon '+monday.toLocaleDateString(undefined,{month:'short',day:'numeric'})+' to Sun '+addDays(monday,6).toLocaleDateString(undefined,{month:'short',day:'numeric'});
  var html = '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;">' +
    '<button class="icon-btn" data-action="week-nav" data-dir="-1" '+(state.weekOffset<=bounds.min?'disabled style="opacity:.35;"':'')+' title="Previous week">‹</button>' +
    '<div style="flex:1;text-align:center;font-size:12.5px;color:var(--ink-dim);">'+rangeLabel+(state.weekOffset===0?' <span class="chip" style="margin-left:4px;">This week</span>':'')+'</div>' +
    '<button class="icon-btn" data-action="week-nav" data-dir="1" '+(state.weekOffset>=bounds.max?'disabled style="opacity:.35;"':'')+' title="Next week">›</button>' +
  '</div>';
  if(state.weekOffset!==0){
    html += '<div style="text-align:center;margin-bottom:6px;"><button class="link-btn" data-action="week-nav" data-dir="0">Jump to this week</button></div>';
  }
  dayDefs.forEach(function(pair, i){
    var key = pair[0], label = pair[1];
    var date = addDays(monday, i);
    var dateStr = ymd(date);
    var r = state.routine[key] || {blocks:[]};
    var dayEvents = state.events.filter(function(e){ return effectiveDate(e)===dateStr && e.status!=='Cancelled'; });
    var isToday = dateStr === todayStr;
    html += '<div class="section-head" style="margin-top:18px;"><h2 style="font-size:15px;">'+label+' · '+date.toLocaleDateString(undefined,{month:'short',day:'numeric'})+(isToday?' <span class="chip" style="margin-left:4px;">Today</span>':'')+'</h2>' +
      (r.mode ? '<span class="chip">'+escapeHtml(r.mode)+'</span>' : '') + '</div>';
    html += '<div class="card">';
    if((r.blocks||[]).length===0 && dayEvents.length===0){
      html += '<div class="empty">Nothing planned.</div>';
    } else {
      html += (r.blocks||[]).map(function(b){
        var tag = goalTagForBlock(b.label);
        return '<div class="item-row"><div class="item-body" style="display:flex;gap:12px;align-items:flex-start;">' +
          '<div class="mono" style="flex:0 0 auto;min-width:56px;color:var(--ink-dim);font-size:12.5px;padding-top:1px;">'+escapeHtml(b.time||'')+'</div>' +
          '<div style="flex:1;"><div style="font-weight:600;font-size:14.5px;">'+escapeHtml(b.label)+
            (tag?' <span class="chip">'+escapeHtml(tag)+'</span>':'')+'</div>' +
          (b.note ? '<div style="font-size:12.5px;color:var(--ink-dim);margin-top:2px;">'+escapeHtml(b.note)+'</div>' : '') +
          '</div></div></div>';
      }).join('');
      if(dayEvents.length){
        html += dayEvents.map(function(e){ return eventRow(e,{}); }).join('');
      }
    }
    html += '</div>';
  });
  return html;
}

function goalStatusComputed(g){
  var subs = g.subActions||[];
  if(!subs.length) return g.status || 'Not started';
  var done = subs.filter(function(s){return s.done;}).length;
  if(done===0) return subs.some(function(s){return s.timesLogged;}) ? 'In Progress' : (g.status||'Not started');
  if(done===subs.length) return 'Complete';
  return 'In Progress';
}
function statusPillClass(s){
  if(s==='Complete' || s==='Done') return 'complete';
  if(s==='In Progress') return 'progress';
  return 'not';
}
function renderDashStats(){
  var streak = computeStreak();
  var best = state.bestStreak||0;
  var todayPts = (state.checkinPoints && state.checkinPoints[todayStr]) || 0;
  var subTotal = 0, doneTotal = 0;
  state.goals.forEach(function(g){ var subs=g.subActions||[]; subTotal += subs.length; doneTotal += subs.filter(function(s){return s.done;}).length; });
  var pct = subTotal ? Math.round(100*doneTotal/subTotal) : 0;
  return '<div class="dash-stats">' +
    '<div class="dash-stat streak"><div class="dl">🔥 Streak</div><div class="dv mono">'+streak+'<small>days</small></div></div>' +
    '<div class="dash-stat"><div class="dl">🏆 Best</div><div class="dv mono">'+best+'<small>days</small></div></div>' +
    '<div class="dash-stat"><div class="dl">⚡ Today</div><div class="dv mono">'+todayPts+'<small>pts</small></div></div>' +
    '<div class="dash-stat"><div class="dl">✔ Complete</div><div class="dv mono">'+pct+'<small>%</small></div><div style="font-size:10.5px;color:var(--ink-dim);margin-top:1px;">'+doneTotal+'/'+subTotal+'</div></div>' +
  '</div>';
}
function renderFilterPills(){
  var f = state.goalFilter || 'all';
  var opts = [['all','All'],['Critical','Critical'],['High','High'],['Medium','Medium'],['Low','Low']];
  return '<div class="filter-pills">' + opts.map(function(o){
    return '<button class="fpill '+(f===o[0]?'active':'')+'" data-action="filter-priority" data-priority="'+o[0]+'">'+o[1]+'</button>';
  }).join('') + '</div>';
}
function renderHeatmap(){
  var days = 84;
  var today = parseYmd(todayStr);
  var start = addDays(today, -(days-1));
  start = addDays(start, -start.getDay());
  var totalDays = Math.round((today-start)/86400000) + 1;
  var weeks = Math.ceil(totalDays/7);
  var html = '<div class="heatmap-wrap"><div class="heatmap">';
  for(var w=0; w<weeks; w++){
    html += '<div class="heat-col">';
    for(var d=0; d<7; d++){
      var date = addDays(start, w*7+d);
      if(date > today){
        html += '<div class="heat-cell" style="visibility:hidden;"></div>';
        continue;
      }
      var ds = ymd(date);
      var pts = (state.checkinPoints && state.checkinPoints[ds]) || 0;
      var level = pts===0 ? 0 : pts<=3 ? 1 : pts<=7 ? 2 : pts<=14 ? 3 : 4;
      html += '<div class="heat-cell" data-level="'+level+'" title="'+ds+(pts?(' — '+pts+' pts'):' — nothing logged')+'"></div>';
    }
    html += '</div>';
  }
  html += '</div></div>';
  return html;
}
function renderGoals(){
  var html = '<div class="section" style="margin-top:8px;"><div class="section-head"><h2>Your goals</h2><button class="icon-btn" data-action="speak-goals" title="Read progress aloud" aria-label="Read progress aloud">🔊</button></div>';
  html += renderDashStats();
  html += renderFilterPills();
  if(state.goals.length===0){
    html += '<div class="empty">No goal areas yet.</div>';
  } else {
    var filter = state.goalFilter || 'all';
    var list = state.goals.slice().sort(function(a,b){
      var order={Critical:0,High:1,Medium:2,Low:3};
      return (order[a.priority]||2)-(order[b.priority]||2);
    });
    if(filter !== 'all') list = list.filter(function(g){ return g.priority === filter; });
    if(list.length === 0){
      html += '<div class="empty">No goals at this priority.</div>';
    }
    list.forEach(function(g){
      var subs = g.subActions||[];
      var doneCount = subs.filter(function(s){return s.done;}).length;
      var pct = subs.length ? Math.round(100*doneCount/subs.length) : 0;
      var status = goalStatusComputed(g);
      var pts = priorityPoints(g.priority);
      html += '<div class="card goal-card pri-'+escapeHtml(g.priority||'Medium')+'">';
      html += '<div class="goal-head"><div><div class="goal-title">'+escapeHtml(g.title)+'</div>' +
        '<div class="item-meta" style="margin-top:6px;"><span class="chip">'+escapeHtml(g.area||'Personal')+'</span>' +
        '<span class="'+catChipClass(g.priority)+'">'+escapeHtml(g.priority||'Medium')+'</span>' +
        '<span class="status-pill '+statusPillClass(status)+'">'+escapeHtml(status)+'</span></div></div></div>';
      if(goalNeedsFocus(g)) html += '<div class="suggested-tag">⭐ Suggested focus this week</div>';
      var metaBits = '';
      if(g.nextAction) metaBits += '<div>Next: '+escapeHtml(g.nextAction)+'</div>';
      if(g.reviewBy) metaBits += '<div>Review by: '+escapeHtml(g.reviewBy)+'</div>';
      if(metaBits) html += '<div style="margin-top:8px;font-size:12.5px;color:var(--ink-dim);">'+metaBits+'</div>';
      if(subs.length){
        html += '<div class="goal-progress-wrap"><div class="goal-bar"><div class="goal-bar-fill" style="width:'+pct+'%"></div></div><div class="goal-pct">'+doneCount+'/'+subs.length+'</div></div>';
        html += '<div class="goal-points mono">⚡ '+(g.points||0)+' pts earned</div>';
        html += '<div class="sub-list">' + subs.map(function(s,idx){
          return '<div class="sub-row">' +
            '<button class="check '+(s.done?'done':'')+'" data-action="toggle-sub" data-goal="'+g.id+'" data-idx="'+idx+'" title="Mark done">'+(s.done?'✓':'')+'</button>' +
            '<div class="sub-text '+(s.done?'done':'')+'">'+escapeHtml(s.text)+'</div>' +
            '<button class="logbtn" data-action="log-sub" data-goal="'+g.id+'" data-idx="'+idx+'" title="Log progress (+'+pts+' pts) without finishing it">⚡'+
              (s.timesLogged ? '<span class="logcount">'+s.timesLogged+'</span>' : '') +
            '</button>' +
            '<button class="icon-btn sub-edit" data-action="edit-sub" data-goal="'+g.id+'" data-idx="'+idx+'" title="Edit">✎</button>' +
            '<button class="icon-btn sub-del" data-action="delete-sub" data-goal="'+g.id+'" data-idx="'+idx+'" title="Delete">🗑</button>' +
          '</div>';
        }).join('') + '</div>';
      } else if(g.nextAction){
        html += '<div class="goal-points mono" style="margin-top:10px;">⚡ '+(g.points||0)+' pts earned</div>';
      }
      html += '<div class="add-sub"><input type="text" placeholder="Add an action…" data-goal-input="'+g.id+'"/><button class="mini-btn" data-action="add-sub" data-goal="'+g.id+'">Add</button></div>';
      if(g.title === 'Astrophotography') html += renderSkyPanel();
      html += '</div>';
    });
  }
  html += '<div class="section-head" style="margin-top:24px;"><h2>Activity map</h2><span style="font-size:12px;color:var(--ink-dim);">Last 12 weeks</span></div>';
  html += '<div class="card" style="padding:14px;">' + renderHeatmap() +
    '<div style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--ink-dim);margin-top:10px;">Less' +
    '<span class="heat-cell" data-level="0"></span><span class="heat-cell" data-level="1"></span>' +
    '<span class="heat-cell" data-level="2"></span><span class="heat-cell" data-level="3"></span>' +
    '<span class="heat-cell" data-level="4"></span>More</div></div>';
  html += '</div>';
  document.getElementById('mainContent').innerHTML = html;
}

function renderActivity(){
  var html = '<div class="section" style="margin-top:8px;">';
  html += '<div class="section-head"><h2>Recent activity</h2></div>';
  if(state.activity.length===0){
    html += '<div class="empty">Nothing logged yet. Complete a task or use voice to add one — it will show up here.</div>';
  } else {
    html += '<div class="card">' + state.activity.map(function(a){
      var when = new Date(a.ts);
      return '<div class="item-row"><div class="item-body"><div class="item-title" style="font-weight:500;">'+escapeHtml(a.text)+'</div>' +
        '<div class="item-meta"><span class="chip time">'+when.toLocaleDateString(undefined,{month:'short',day:'numeric'})+' · '+when.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})+'</span></div></div></div>';
    }).join('') + '</div>';
  }
  html += '</div>';
  document.getElementById('mainContent').innerHTML = html;
}

function safetyBadge(safety){
  if(!safety || !safety.status) return '';
  var map = {safe:['✓ Safe','pri-medium'], caution:['⚠ Caution','pri-high'], confirm:['⏸ Confirm first','pri-critical']};
  var m = map[safety.status] || ['',''];
  return m[0] ? '<span class="chip '+m[1]+'">'+m[0]+'</span>' : '';
}

function exerciseBlockRow(b, dayKey, idx){
  var hasDetail = !!(b.detail || (b.safety && b.safety.note));
  return '<div class="item-row" '+(hasDetail?'data-action="ex-detail" data-day="'+dayKey+'" data-idx="'+idx+'" style="cursor:pointer;"':'')+'><div class="item-body">' +
    '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">' +
      '<div class="item-title">'+escapeHtml(b.title)+'</div>' +
      (b.time ? '<span class="chip time" style="flex:0 0 auto;">'+escapeHtml(b.time)+'</span>' : '') +
    '</div>' +
    '<div class="item-meta">' +
      (b.location ? '<span class="chip">📍 '+escapeHtml(b.location)+'</span>' : '') +
      (b.duration ? '<span class="chip">⏱ '+escapeHtml(b.duration)+'</span>' : '') +
      (b.sets ? '<span class="chip">'+escapeHtml(b.sets)+' × '+escapeHtml(b.reps||'')+'</span>' : '') +
      (b.category ? '<span class="chip">'+escapeHtml(b.category)+'</span>' : '') +
      safetyBadge(b.safety) +
    '</div>' +
    (hasDetail ? '<div style="margin-top:6px;font-size:12px;color:var(--focus);font-weight:600;">Tap for details →</div>' : '') +
  '</div></div>';
}

function openDetailModal(title, bodyHtml){
  modalBody.innerHTML = '<h3>'+escapeHtml(title)+'</h3><div style="font-size:14px;line-height:1.55;">'+bodyHtml+'</div>' +
    '<div class="modal-actions"><button class="btn-primary" id="detailClose">Close</button></div>';
  modalBackdrop.hidden = false;
  document.getElementById('detailClose').onclick = closeModal;
}

function renderHealthWeek(){
  var dayDefs = [['mon','Mon'],['tue','Tue'],['wed','Wed'],['thu','Thu'],['fri','Fri'],['sat','Sat'],['sun','Sun']];
  var todayKey = WEEKDAY_KEYS[new Date().getDay()];
  var sel = state.healthDay || todayKey;
  var html = '<div class="filter-pills">' + dayDefs.map(function(d){
    return '<button class="fpill '+(sel===d[0]?'active':'')+'" data-action="health-day" data-day="'+d[0]+'">'+d[1]+(d[0]===todayKey?' •':'')+'</button>';
  }).join('') + '</div>';
  var blocks = (state.health && state.health.weeklyExercise && state.health.weeklyExercise[sel]) || [];
  if(!blocks.length){
    html += '<div class="empty">No exercise blocks for this day yet.</div>';
  } else {
    html += '<div class="card">' + blocks.map(function(b,i){ return exerciseBlockRow(b, sel, i); }).join('') + '</div>';
  }
  return html;
}

function renderStepsCard(){
  var sp = state.health && state.health.stepsPlan;
  var profile = state.health && state.health.profile;
  if(!sp) return '';
  var html = '<div class="section-head" style="margin-top:20px;"><h2 style="font-size:15px;">👟 15,000 steps/day</h2></div>';
  html += '<div class="card" style="padding:14px 16px;">';
  if(profile && profile.commute){
    html += '<div style="font-size:12.5px;color:var(--ink-dim);margin-bottom:10px;">'+escapeHtml(profile.commute.outbound)+' · '+escapeHtml(profile.commute.return)+'</div>';
  }
  html += '<div style="display:flex;flex-direction:column;gap:8px;">' + (sp.howItAddsUp||[]).map(function(s){
    return '<div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline;">' +
      '<div style="font-size:13.5px;flex:1;">'+escapeHtml(s.segment)+'</div>' +
      '<div class="mono" style="font-size:12px;color:var(--ink-dim);flex:0 0 auto;">'+escapeHtml(s.approxSteps)+'</div>' +
    '</div>';
  }).join('') + '</div>';
  html += '</div>';
  html += '<div class="card" style="margin-top:8px;">' + (sp.tips||[]).map(function(t){
    return '<div class="item-row"><div class="item-body"><div style="font-size:13px;line-height:1.4;">'+escapeHtml(t)+'</div></div></div>';
  }).join('') + '</div>';
  return html;
}

function asanaList(title, items, cls){
  if(!items || !items.length) return '';
  return '<div style="margin-top:10px;"><div style="font-size:12.5px;font-weight:700;" class="'+(cls||'')+'">'+escapeHtml(title)+'</div>' +
    '<ul style="margin:6px 0 0;padding-left:18px;font-size:13.5px;line-height:1.5;">' +
      items.map(function(a){ return '<li style="margin-bottom:5px;"><b>'+escapeHtml(a.name)+'</b>'+(a.note?' — <span style="color:var(--ink-dim);">'+escapeHtml(a.note)+'</span>':'')+'</li>'; }).join('') +
    '</ul></div>';
}

function renderHealthLibrary(){
  var lib = state.health && state.health.exerciseLibrary;
  if(!lib) return '<div class="empty">Loading…</div>';
  var html = '';
  if(lib.spinalYoga){
    var sy = lib.spinalYoga;
    html += '<div class="section-head" style="margin-top:8px;"><h2 style="font-size:15px;">🧘 '+escapeHtml(sy.title)+'</h2></div>';
    html += '<div class="card" style="padding:14px 16px;">';
    html += '<div style="font-size:13px;color:var(--ink-dim);line-height:1.5;">'+escapeHtml(sy.intro)+'</div>';
    html += asanaList('Safe', sy.safeAsanas, '');
    html += asanaList('Half / modified only (Jindal-flagged)', sy.halfOrModifiedOnly);
    html += asanaList('Avoid', sy.avoidAsanas);
    if(sy.note) html += '<div class="warn-banner" style="margin-top:10px;">ℹ️ '+escapeHtml(sy.note)+'</div>';
    html += '</div>';
  }
  if(lib.danceAndSpin){
    html += '<div class="section-head" style="margin-top:20px;"><h2 style="font-size:15px;">💃 Dance & Spin</h2></div>';
    html += '<div class="card" style="padding:14px 16px;">';
    ['zumba','spinning'].forEach(function(k){
      var it = lib.danceAndSpin[k];
      if(!it) return;
      html += '<div style="margin-bottom:12px;"><div style="font-weight:700;font-size:14px;text-transform:capitalize;">'+escapeHtml(k)+' — '+escapeHtml(it.verdict)+'</div>' +
        '<div style="font-size:13px;color:var(--ink-dim);margin-top:3px;line-height:1.5;">'+escapeHtml(it.detail)+'</div></div>';
    });
    html += '</div>';
  }
  if(lib.walkRun){
    html += '<div class="section-head" style="margin-top:20px;"><h2 style="font-size:15px;">🏃 '+escapeHtml(lib.walkRun.title)+'</h2></div>';
    html += '<div class="card">' + (lib.walkRun.phases||[]).map(function(ph){
      return '<div class="item-row"><div class="item-body"><div class="item-title" style="font-size:14px;">'+escapeHtml(ph.name)+'</div>' +
        '<div style="font-size:13px;color:var(--ink-dim);margin-top:4px;line-height:1.5;">'+escapeHtml(ph.detail)+'</div></div></div>';
    }).join('') + '</div>';
    if(lib.walkRun.note) html += '<div class="warn-banner" style="margin-top:8px;">ℹ️ '+escapeHtml(lib.walkRun.note)+'</div>';
  }
  if(lib.trainerFocus){
    html += '<div class="section-head" style="margin-top:20px;"><h2 style="font-size:15px;">🏋️ '+escapeHtml(lib.trainerFocus.title)+'</h2></div>';
    html += '<div class="card">' + (lib.trainerFocus.areas||[]).map(function(a){
      return '<div class="item-row"><div class="item-body"><div class="item-title" style="font-size:14px;">'+escapeHtml(a.title)+'</div>' +
        '<div style="font-size:13px;color:var(--ink-dim);margin-top:4px;line-height:1.5;">'+escapeHtml(a.detail)+'</div></div></div>';
    }).join('') + '</div>';
  }
  return html;
}

function dietItemRow(item, sectionId, idx){
  return '<div class="item-row" data-action="diet-detail" data-section="'+sectionId+'" data-idx="'+idx+'" style="cursor:pointer;"><div class="item-body">' +
    '<div class="item-title" style="font-size:14px;">'+escapeHtml(item.name)+'</div>' +
    (item.portion ? '<div style="font-size:12px;color:var(--ink-dim);margin-top:2px;">'+escapeHtml(item.portion)+'</div>' : '') +
    pillList(item.tags) +
    '<div style="margin-top:5px;font-size:12px;color:var(--focus);font-weight:600;">Tap for portion + recipe →</div>' +
  '</div></div>';
}

function pillList(items, cls){
  if(!items || !items.length) return '';
  return '<div class="item-meta" style="margin-top:6px;">' + items.map(function(t){
    return '<span class="chip '+(cls||'')+'">'+escapeHtml(t)+'</span>';
  }).join('') + '</div>';
}

function renderHealthDiet(){
  var d = state.health && state.health.dietBooklet;
  if(!d) return '<div class="empty">Loading…</div>';
  var html = '';
  if(d.intro) html += '<div class="card" style="padding:14px 16px;margin-bottom:14px;"><div style="font-size:13.5px;line-height:1.5;">'+escapeHtml(d.intro)+'</div></div>';
  (d.sections||[]).forEach(function(sec){
    html += '<div class="section-head" style="margin-top:16px;"><h2 style="font-size:15px;">'+escapeHtml(sec.title)+'</h2>'+(sec.timing?'<span class="chip time">🕐 '+escapeHtml(sec.timing)+'</span>':'')+'</div>';
    html += '<div class="card">' + (sec.items||[]).map(function(it,i){ return dietItemRow(it, sec.id, i); }).join('') + '</div>';
  });
  return html;
}

function renderHealthGaps(){
  var gaps = state.health && state.health.gapsToConfirm;
  if(!gaps || !gaps.length) return '';
  return '<div class="section-head" style="margin-top:24px;"><h2 style="font-size:15px;">Still to confirm</h2></div>' +
    '<div class="card">' + gaps.map(function(g){
      return '<div class="warn-banner" style="margin:10px 12px;">⚠️ '+escapeHtml(g)+'</div>';
    }).join('') + '</div>';
}

function renderHealth(){
  var view = state.healthView || 'week';
  var html = '<div class="section" style="margin-top:8px;">';
  if(state.health && state.health.profile){
    var p = state.health.profile;
    html += '<div class="card" style="padding:14px 16px;">' +
      '<div style="font-size:12.5px;font-weight:700;color:var(--ink-dim);text-transform:uppercase;letter-spacing:.03em;">Goal</div>' +
      '<div style="font-size:14px;margin-top:4px;">'+escapeHtml(p.currentWeightKg+'kg now → target '+p.targetWeightKgRange+'kg')+' · '+escapeHtml((p.stepsGoalDaily||15000).toLocaleString())+' steps/day</div>' +
      '<div style="font-size:12.5px;color:var(--ink-dim);margin-top:6px;line-height:1.4;">'+escapeHtml(p.paceGuidance||'')+'</div>' +
      (p.recoveryNote ? '<div class="warn-banner" style="margin-top:10px;">⚠️ '+escapeHtml(p.recoveryNote)+'</div>' : '') +
    '</div>';
  }
  html += '<a href="https://claude.ai/artifact/FszEC4QE7WL2xjWSmv4wqM" target="_blank" rel="noopener" class="card" style="margin-top:10px;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;gap:10px;text-decoration:none;color:inherit;">' +
    '<div><div style="font-weight:700;font-size:14px;">📄 Printable diet &amp; exercise plan</div>' +
    '<div style="font-size:12.5px;color:var(--ink-dim);margin-top:3px;">2-page A4 sheet — open, then use the page\'s download button for a PDF</div></div>' +
    '<span style="font-size:18px;color:var(--focus);flex:0 0 auto;">→</span>' +
  '</a>';
  html += '<div class="filter-pills" style="margin-top:16px;">' +
    '<button class="fpill '+(view==='week'?'active':'')+'" data-action="health-view" data-view="week">This week</button>' +
    '<button class="fpill '+(view==='library'?'active':'')+'" data-action="health-view" data-view="library">Exercise library</button>' +
    '<button class="fpill '+(view==='diet'?'active':'')+'" data-action="health-view" data-view="diet">Diet booklet</button>' +
    '<button class="fpill '+(view==='tips'?'active':'')+'" data-action="health-view" data-view="tips">Tips</button>' +
  '</div>';

  if(!state.health){
    html += '<div class="empty">Loading your plan…</div>';
  } else if(view==='week'){
    html += renderHealthWeek();
    html += renderStepsCard();
  } else if(view==='library'){
    html += renderHealthLibrary();
  } else if(view==='diet'){
    html += renderHealthDiet();
  } else if(view==='tips'){
    html += '<div class="card">' + (state.health.tips||[]).map(function(t){
      return '<div class="item-row"><div class="item-body"><div style="font-size:13.5px;line-height:1.4;">'+escapeHtml(t)+'</div></div></div>';
    }).join('') + '</div>';
  }
  html += state.health ? renderHealthGaps() : '';
  html += '</div>';
  document.getElementById('mainContent').innerHTML = html;
}

function renderAll(){
  if(!state.ready) return;
  renderStatStrip();
  renderEncouragement();
  if(state.tab==='today') renderToday();
  else if(state.tab==='planner') renderPlanner();
  else if(state.tab==='health') renderHealth();
  else if(state.tab==='goals') renderGoals();
  else if(state.tab==='log') renderActivity();
}

/* ================= tab / nav events ================= */
document.querySelectorAll('.tab-btn').forEach(function(btn){
  btn.addEventListener('click', function(){ setTab(btn.getAttribute('data-tab')); });
});
function setTab(t){
  state.tab = t;
  document.querySelectorAll('.tab-btn').forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-tab')===t); });
  renderAll();
  window.scrollTo(0,0);
}

document.getElementById('mainContent').addEventListener('click', function(e){
  var goto = e.target.closest('[data-goto]');
  if(goto){ setTab(goto.getAttribute('data-goto')); return; }

  if(e.target.closest('[data-action="speak-today"]')){ speakTodayAgenda(); return; }
  if(e.target.closest('[data-action="speak-goals"]')){ speakGoalProgress(); return; }

  var focusEvt = e.target.closest('[data-action="focus-complete-event"]');
  if(focusEvt){ markEventDone(focusEvt.getAttribute('data-id'), true); return; }
  var focusSub = e.target.closest('[data-action="focus-complete-sub"]');
  if(focusSub){ toggleSubAction(focusSub.getAttribute('data-goal'), parseInt(focusSub.getAttribute('data-idx'),10), true); return; }

  var toggleBtn = e.target.closest('[data-action="toggle-event"]');
  if(toggleBtn){
    var id = toggleBtn.getAttribute('data-id');
    var ev = state.events.find(function(x){return x.id===id;});
    markEventDone(id, !(ev && ev.status==='Done'));
    return;
  }
  var editBtn = e.target.closest('[data-action="edit-event"]');
  if(editBtn){ openEventModal(editBtn.getAttribute('data-id')); return; }
  var delEvtBtn = e.target.closest('[data-action="delete-event"]');
  if(delEvtBtn){
    var delEvId = delEvtBtn.getAttribute('data-id');
    var delEv = state.events.find(function(x){return x.id===delEvId;});
    if(window.confirm('Delete "'+(delEv?delEv.entry:'this item')+'"?')){ deleteEvent(delEvId); }
    return;
  }

  var editSubBtn = e.target.closest('[data-action="edit-sub"]');
  if(editSubBtn){
    var esGid = editSubBtn.getAttribute('data-goal');
    var esIdx = parseInt(editSubBtn.getAttribute('data-idx'),10);
    var esG = state.goals.find(function(x){return x.id===esGid;});
    var esCur = esG && esG.subActions[esIdx] ? esG.subActions[esIdx].text : '';
    var esNew = window.prompt('Edit action', esCur);
    if(esNew !== null && esNew.trim() && esNew.trim() !== esCur){ editSubAction(esGid, esIdx, esNew); }
    return;
  }
  var delSubBtn = e.target.closest('[data-action="delete-sub"]');
  if(delSubBtn){
    var dsGid = delSubBtn.getAttribute('data-goal');
    var dsIdx = parseInt(delSubBtn.getAttribute('data-idx'),10);
    var dsG = state.goals.find(function(x){return x.id===dsGid;});
    var dsText = dsG && dsG.subActions[dsIdx] ? dsG.subActions[dsIdx].text : 'this action';
    if(window.confirm('Delete "'+dsText+'"?')){ deleteSubAction(dsGid, dsIdx); }
    return;
  }

  var subBtn = e.target.closest('[data-action="toggle-sub"]');
  if(subBtn){
    var gid = subBtn.getAttribute('data-goal');
    var idx = parseInt(subBtn.getAttribute('data-idx'),10);
    var g = state.goals.find(function(x){return x.id===gid;});
    var cur = g.subActions[idx].done;
    if(!cur){ spawnFloatingPoints(e.clientX, e.clientY, '+'+priorityPoints(g.priority)); }
    toggleSubAction(gid, idx, !cur);
    return;
  }
  var logBtn = e.target.closest('[data-action="log-sub"]');
  if(logBtn){
    var lgid = logBtn.getAttribute('data-goal');
    var lidx = parseInt(logBtn.getAttribute('data-idx'),10);
    var lg = state.goals.find(function(x){return x.id===lgid;});
    if(lg){ spawnFloatingPoints(e.clientX, e.clientY, '+'+priorityPoints(lg.priority)); }
    logSubActionProgress(lgid, lidx);
    return;
  }
  var healthDayBtn = e.target.closest('[data-action="health-day"]');
  if(healthDayBtn){
    state.healthDay = healthDayBtn.getAttribute('data-day');
    renderHealth();
    return;
  }
  var healthViewBtn = e.target.closest('[data-action="health-view"]');
  if(healthViewBtn){
    state.healthView = healthViewBtn.getAttribute('data-view');
    renderHealth();
    return;
  }
  var exDetailBtn = e.target.closest('[data-action="ex-detail"]');
  if(exDetailBtn){
    var exDay = exDetailBtn.getAttribute('data-day');
    var exIdx = parseInt(exDetailBtn.getAttribute('data-idx'),10);
    var exBlock = state.health && state.health.weeklyExercise && state.health.weeklyExercise[exDay] && state.health.weeklyExercise[exDay][exIdx];
    if(exBlock){
      var exBody = (exBlock.sets ? '<div class="item-meta" style="margin:0 0 10px;"><span class="chip">'+escapeHtml(exBlock.sets)+(exBlock.reps?' × '+escapeHtml(exBlock.reps):'')+'</span>'+(exBlock.duration?'<span class="chip">⏱ '+escapeHtml(exBlock.duration)+'</span>':'')+'</div>' : '') +
        (exBlock.detail ? '<p style="margin:0 0 10px;">'+escapeHtml(exBlock.detail)+'</p>' : '') +
        (exBlock.safety && exBlock.safety.note ? '<div class="warn-banner">⚠️ '+escapeHtml(exBlock.safety.note)+'</div>' : '') +
        (exBlock.resource ? '<div style="margin-top:10px;padding:10px 12px;background:var(--info-bg);border-radius:10px;">' +
          '<div style="font-size:11px;font-weight:700;color:var(--ink-dim);text-transform:uppercase;letter-spacing:.03em;">Follow-along video</div>' +
          '<a href="'+escapeHtml(exBlock.resource.url)+'" target="_blank" rel="noopener" style="display:block;margin-top:4px;font-size:13.5px;font-weight:600;color:var(--primary);">▶ '+escapeHtml(exBlock.resource.title)+'</a>' +
          (exBlock.resource.note ? '<div style="font-size:11.5px;color:var(--ink-dim);margin-top:4px;">'+escapeHtml(exBlock.resource.note)+'</div>' : '') +
        '</div>' : '');
      openDetailModal(exBlock.title, exBody || '<p style="margin:0;color:var(--ink-dim);">No further detail yet.</p>');
    }
    return;
  }
  var dietDetailBtn = e.target.closest('[data-action="diet-detail"]');
  if(dietDetailBtn){
    var dsId = dietDetailBtn.getAttribute('data-section');
    var dsIdx = parseInt(dietDetailBtn.getAttribute('data-idx'),10);
    var dsSection = state.health && state.health.dietBooklet && (state.health.dietBooklet.sections||[]).find(function(s){return s.id===dsId;});
    var dsItem = dsSection && dsSection.items[dsIdx];
    if(dsItem){
      var dsBody = (dsItem.portion ? '<div class="item-meta" style="margin:0 0 10px;"><span class="chip">🍽 '+escapeHtml(dsItem.portion)+'</span>'+(dsSection.timing?'<span class="chip time">🕐 '+escapeHtml(dsSection.timing)+'</span>':'')+'</div>' : '') +
        (dsItem.instructions ? '<div style="margin-bottom:10px;"><div style="font-size:11px;font-weight:700;color:var(--ink-dim);text-transform:uppercase;letter-spacing:.03em;margin-bottom:4px;">How to prepare</div><p style="margin:0;">'+escapeHtml(dsItem.instructions)+'</p></div>' : '') +
        (dsItem.detail ? '<div><div style="font-size:11px;font-weight:700;color:var(--ink-dim);text-transform:uppercase;letter-spacing:.03em;margin-bottom:4px;">Why it fits</div><p style="margin:0;">'+escapeHtml(dsItem.detail)+'</p></div>' : '');
      openDetailModal(dsItem.name, dsBody || '<p style="margin:0;color:var(--ink-dim);">No further detail yet.</p>');
    }
    return;
  }
  var filterBtn = e.target.closest('[data-action="filter-priority"]');
  if(filterBtn){
    state.goalFilter = filterBtn.getAttribute('data-priority');
    renderGoals();
    return;
  }
  var pvBtn = e.target.closest('[data-action="planner-view"]');
  if(pvBtn){
    state.plannerView = pvBtn.getAttribute('data-view');
    if(state.plannerView==='week') state.weekOffset = 0;
    renderPlanner();
    return;
  }
  var weekNavBtn = e.target.closest('[data-action="week-nav"]');
  if(weekNavBtn){
    var dir = weekNavBtn.getAttribute('data-dir');
    state.weekOffset = dir==='0' ? 0 : (state.weekOffset||0) + parseInt(dir,10);
    renderPlanner();
    return;
  }
  var addSubBtn = e.target.closest('[data-action="add-sub"]');
  if(addSubBtn){
    var goalId = addSubBtn.getAttribute('data-goal');
    var input = document.querySelector('[data-goal-input="'+goalId+'"]');
    if(input && input.value.trim()){ addSubAction(goalId, input.value); input.value=''; }
    return;
  }
});
document.getElementById('statStrip').addEventListener('click', function(e){
  var t = e.target.closest('[data-goto]');
  if(t) setTab(t.getAttribute('data-goto'));
});

document.getElementById('mainContent').addEventListener('keydown', function(e){
  if(e.key==='Enter' && e.target.matches('[data-goal-input]')){
    var goalId = e.target.getAttribute('data-goal-input');
    if(e.target.value.trim()){ addSubAction(goalId, e.target.value); e.target.value=''; }
  }
});

/* ================= add/edit event modal ================= */
var modalBackdrop = document.getElementById('modalBackdrop');
var modalBody = document.getElementById('modalBody');

function openEventModal(editId){
  var editing = editId ? state.events.find(function(x){return x.id===editId;}) : null;
  var d = editing ? editing.date : todayStr;
  modalBody.innerHTML =
    '<h3>'+(editing?'Edit item':'Add item')+'</h3>' +
    '<div class="field"><label>What</label><input id="f-entry" type="text" value="'+escapeHtml(editing?editing.entry:'')+'" placeholder="e.g. Call the physio"></div>' +
    '<div class="field-row">' +
      '<div class="field"><label>Date</label><input id="f-date" type="date" value="'+d+'"></div>' +
      '<div class="field"><label>Time (optional)</label><input id="f-time" type="text" placeholder="e.g. 3pm" value="'+escapeHtml(editing&&editing.startTime||'')+'"></div>' +
    '</div>' +
    '<div class="field-row">' +
      '<div class="field"><label>Category</label><select id="f-cat">'+CATEGORIES.map(function(c){return '<option '+(editing&&editing.category===c?'selected':'')+'>'+c+'</option>';}).join('')+'</select></div>' +
      '<div class="field"><label>Priority</label><select id="f-pri">'+PRIORITIES.map(function(c){return '<option '+((editing?editing.priority:'Medium')===c?'selected':'')+'>'+c+'</option>';}).join('')+'</select></div>' +
    '</div>' +
    '<div class="field"><label>Prep needed (optional)</label><input id="f-prep" type="text" value="'+escapeHtml(editing&&editing.prepNeeded||'')+'"></div>' +
    '<div class="field"><label>Notes (optional)</label><textarea id="f-notes" rows="2">'+escapeHtml(editing&&editing.notes||'')+'</textarea></div>' +
    (editing ? '<div class="field"><label>Status</label><select id="f-status">'+STATUSES.map(function(c){return '<option '+(editing.status===c?'selected':'')+'>'+c+'</option>';}).join('')+'</select></div>' : '') +
    '<div class="modal-actions">' +
      '<button class="btn-ghost" id="modalCancel">Cancel</button>' +
      '<button class="btn-primary" id="modalSave">'+(editing?'Save changes':'Add to planner')+'</button>' +
    '</div>';
  modalBackdrop.hidden = false;
  document.getElementById('modalCancel').onclick = closeModal;
  document.getElementById('modalSave').onclick = async function(){
    var payload = {
      entry: document.getElementById('f-entry').value.trim(),
      date: document.getElementById('f-date').value,
      startTime: document.getElementById('f-time').value.trim() || null,
      category: document.getElementById('f-cat').value,
      priority: document.getElementById('f-pri').value,
      prepNeeded: document.getElementById('f-prep').value.trim() || null,
      notes: document.getElementById('f-notes').value.trim() || null,
    };
    if(!payload.entry) return;
    if(editing){
      payload.status = document.getElementById('f-status').value;
      await updateEvent(editing.id, payload);
      logActivity('Updated "'+payload.entry+'"', 'edit');
    } else {
      payload.status = 'Planned';
      payload.day = parseYmd(payload.date).toLocaleDateString(undefined,{weekday:'short'});
      await addEvent(payload);
      logActivity('Added "'+payload.entry+'" for '+fmtDateShort(payload.date), 'add');
    }
    closeModal();
  };
}
function closeModal(){ modalBackdrop.hidden = true; modalBody.innerHTML=''; }
modalBackdrop.addEventListener('click', function(e){ if(e.target===modalBackdrop) closeModal(); });
document.getElementById('fabAdd').addEventListener('click', function(){ openEventModal(null); });

/* ================= voice — real implementation =================
   This runs outside the claude.ai artifact sandbox, so getUserMedia /
   speech recognition permission prompts work normally in the browser. */
var Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
var recognizing = false;
var recognizer = null;
var voiceSheet = document.getElementById('voiceSheet');
var voiceLabel = document.getElementById('voiceLabel');
var voiceText = document.getElementById('voiceText');
var micBtn = document.getElementById('micBtn');
var micIcon = document.getElementById('micIcon');

function showVoiceSheet(label, text, holdMs){
  voiceLabel.textContent = label;
  voiceText.textContent = text;
  voiceSheet.classList.add('show');
  if(holdMs){
    clearTimeout(showVoiceSheet._t);
    showVoiceSheet._t = setTimeout(function(){ voiceSheet.classList.remove('show'); }, holdMs);
  }
}
function hideVoiceSheet(){ voiceSheet.classList.remove('show'); }

function speak(text){
  try{
    if(!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    var u = new SpeechSynthesisUtterance(text);
    u.rate = 1.02;
    window.speechSynthesis.speak(u);
  }catch(e){}
}

micBtn.addEventListener('click', function(){
  if(!Recognition){
    showVoiceSheet('Voice unavailable', 'Speech recognition isn’t supported in this browser. Try Chrome or Edge on Android, or Safari on iOS 14.5+.', 6000);
    return;
  }
  if(recognizing){ recognizer.stop(); return; }
  recognizer = new Recognition();
  recognizer.lang = 'en-GB';
  recognizer.interimResults = true;
  recognizer.maxAlternatives = 1;
  recognizing = true;
  micBtn.classList.add('listening');
  micIcon.textContent = '⏺️';
  showVoiceSheet('Listening…', 'Try: "add gym tomorrow", "mark surgery done", "what\'s today", "how am I doing"');

  recognizer.onresult = function(ev){
    var transcript = '';
    for(var i=0;i<ev.results.length;i++){ transcript += ev.results[i][0].transcript; }
    voiceText.textContent = transcript;
  };
  recognizer.onerror = function(ev){
    if(ev.error==='not-allowed' || ev.error==='service-not-allowed'){
      showVoiceSheet('Microphone permission needed', 'Allow microphone access for this site in your browser settings, then tap the mic again.', 6000);
    } else if(ev.error==='audio-capture'){
      showVoiceSheet('No microphone found', 'This device doesn’t seem to have a working microphone.', 5000);
    } else if(ev.error==='no-speech'){
      showVoiceSheet('Didn’t hear anything', 'Try again, a bit closer to the mic.', 3000);
    } else {
      showVoiceSheet('Voice error', 'Mic error: '+ev.error+'. Try again or type instead.', 3500);
    }
  };
  recognizer.onend = function(){
    recognizing = false;
    micBtn.classList.remove('listening');
    micIcon.textContent = '🎙️';
    var finalText = voiceText.textContent.trim();
    if(finalText && !/^Say something|^Try:|^Voice |^Listening/.test(finalText)){
      handleVoiceCommand(finalText);
    } else {
      hideVoiceSheet();
    }
  };
  try{ recognizer.start(); }
  catch(e){
    recognizing = false;
    micBtn.classList.remove('listening');
    micIcon.textContent = '🎙️';
    showVoiceSheet('Couldn’t start listening', String(e.message||e), 4000);
  }
});

function speakTodayAgenda(){
  var today = eventsInRange(0,0).filter(function(e){return e.status!=='Cancelled';});
  var msg;
  if(today.length===0) msg = "You have nothing scheduled today. A good day to make progress on a goal.";
  else {
    var doneCt = today.filter(function(e){return e.status==='Done';}).length;
    msg = 'You have '+today.length+' thing'+(today.length===1?'':'s')+' today. '+doneCt+' done so far. '+
      today.map(function(e){return e.entry + (e.startTime?(' at '+e.startTime):'');}).join('. ');
  }
  showVoiceSheet('Today’s agenda', msg, 6000);
  speak(msg);
}
function speakGoalProgress(){
  var parts = state.goals.map(function(g){
    var subs = g.subActions||[];
    var pct = subs.length ? Math.round(100*subs.filter(function(s){return s.done;}).length/subs.length) : 0;
    return g.title+' '+pct+'%';
  });
  var msg = 'Streak: '+computeStreak()+' days. '+parts.join('. ');
  showVoiceSheet('Goal progress', msg, 7000);
  speak(msg);
}

function findGoalByArea(text){
  text = text.toLowerCase();
  var best = null, bestScore = 0;
  state.goals.forEach(function(g){
    var words = g.title.toLowerCase().split(/\W+/).filter(Boolean);
    var score = words.reduce(function(s,w){ return s + (w.length>2 && text.indexOf(w)!==-1 ? 1 : 0); }, 0);
    if(score > bestScore){ bestScore = score; best = g; }
  });
  return bestScore>0 ? best : null;
}

function guessCategory(text){
  text = text.toLowerCase();
  for(var cat in CAT_KEYWORDS){
    if(CAT_KEYWORDS[cat].some(function(k){ return text.indexOf(k)!==-1; })) return cat;
  }
  return 'Personal';
}

function parseDatePhrase(text){
  var t = text.toLowerCase();
  var today = parseYmd(todayStr);
  var m;
  if(/\btoday\b/.test(t)) return {date: ymd(today), phrase:'today'};
  if(/\btomorrow\b/.test(t)) return {date: ymd(addDays(today,1)), phrase:'tomorrow'};
  m = t.match(/\bin (\d+) days?\b/);
  if(m) return {date: ymd(addDays(today, parseInt(m[1],10))), phrase:m[0]};
  m = t.match(/\bnext (sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if(m){
    var target = WEEKDAYS.indexOf(m[1]);
    var d = addDays(today, 7 + ((target - today.getDay() + 7) % 7 || 7));
    return {date: ymd(d), phrase:m[0]};
  }
  m = t.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if(m){
    var target2 = WEEKDAYS.indexOf(m[1]);
    var diff = (target2 - today.getDay() + 7) % 7;
    if(diff===0) diff = 7;
    return {date: ymd(addDays(today, diff)), phrase:m[0]};
  }
  return null;
}

function findMatchingOpenItem(text){
  text = text.toLowerCase();
  var candidates = state.events.filter(function(e){ return e.status!=='Done' && e.status!=='Cancelled'; });
  var best = null, bestScore = 0;
  candidates.forEach(function(e){
    var words = (e.entry||'').toLowerCase().split(/\W+/).filter(function(w){return w.length>2;});
    var score = words.reduce(function(s,w){ return s + (text.indexOf(w)!==-1?1:0); }, 0);
    if(score>bestScore){ bestScore=score; best={type:'event', item:e}; }
  });
  state.goals.forEach(function(g){
    (g.subActions||[]).forEach(function(s, idx){
      if(s.done) return;
      var words = s.text.toLowerCase().split(/\W+/).filter(function(w){return w.length>2;});
      var score = words.reduce(function(sc,w){ return sc + (text.indexOf(w)!==-1?1:0); }, 0);
      if(score>bestScore){ bestScore=score; best={type:'sub', goalId:g.id, idx:idx, item:s}; }
    });
  });
  return bestScore>0 ? best : null;
}

async function handleVoiceCommand(raw){
  var text = raw.trim();
  var lower = text.toLowerCase();

  if(/what.?s (today|my day)|read (my )?(day|agenda)|today.?s agenda/.test(lower)){
    speakTodayAgenda();
    setTab('today');
    return;
  }

  if(/what.?s next|next thing|next up/.test(lower)){
    var upcoming = eventsInRange(0,60).filter(function(e){return e.status!=='Done' && e.status!=='Cancelled';});
    var msg2 = upcoming.length ? ('Next up: '+upcoming[0].entry+', '+fmtDateShort(upcoming[0].date)+(upcoming[0].startTime?(' at '+upcoming[0].startTime):'')+'.') : 'Nothing upcoming on your planner.';
    showVoiceSheet('Next up', msg2, 5000);
    speak(msg2);
    return;
  }

  if(/how am i doing|read (my )?goals|goal progress|progress update/.test(lower)){
    speakGoalProgress();
    setTab('goals');
    return;
  }

  if(/what should i (do|focus on)|recommend|priorit/.test(lower)){
    var recs = computeRecommendations();
    var msg4 = recs.length ? ('Here\'s what I\'d focus on: ' + recs.map(function(r){return r.title;}).join('. Then ') + '.') : 'Nothing urgent — good time to plan ahead.';
    showVoiceSheet('Recommended focus', msg4, 7000);
    speak(msg4);
    setTab('today');
    return;
  }

  var completeMatch = lower.match(/^(mark|complete|done|finish(ed)?|check off)\b(.*)$/);
  if(completeMatch){
    var rest = completeMatch[3].replace(/\bas done\b|\bdone\b/g,'').trim();
    var match = findMatchingOpenItem(rest || lower);
    if(match){
      if(match.type==='event'){ await markEventDone(match.item.id, true); showVoiceSheet('Marked done', match.item.entry, 3500); speak('Nice work. Marked "'+match.item.entry+'" as done.'); }
      else { await toggleSubAction(match.goalId, match.idx, true); showVoiceSheet('Marked done', match.item.text, 3500); speak('Marked "'+match.item.text+'" as done.'); }
    } else {
      showVoiceSheet('Couldn’t find that', 'I couldn’t match an open item to "'+rest+'". Try being more specific.', 4000);
      speak("I couldn't find a matching open item.");
    }
    return;
  }

  // "move X to Thursday", "reschedule X to 3pm", "change X to Y", "rename X to Y"
  var changeMatch = lower.match(/^(move|reschedule|push|change|rename|edit|set)\b\s*(.*?)\s+to\s+(.*)$/);
  if(changeMatch && changeMatch[2].trim() && changeMatch[3].trim()){
    var chTarget = changeMatch[2].trim().replace(/\s+time$/,'');
    var chValue = changeMatch[3].trim();
    var chMatch = findMatchingOpenItem(chTarget);
    if(!chMatch){
      showVoiceSheet('Couldn’t find that', 'No open item matched "'+chTarget+'".', 4500);
      speak("I couldn't find an open item matching "+chTarget+".");
      return;
    }
    if(looksLikeTime(chValue) && chMatch.type==='event'){
      await updateEvent(chMatch.item.id, {startTime: chValue});
      logActivity('Changed time of "'+chMatch.item.entry+'" to '+chValue+' (voice)', 'edit');
      showVoiceSheet('Time updated', chMatch.item.entry+' → '+chValue, 4000);
      speak('Updated the time for '+chMatch.item.entry+' to '+chValue+'.');
      return;
    }
    var chDateInfo = parseDatePhrase(chValue);
    if(chDateInfo && chMatch.type==='event'){
      await updateEvent(chMatch.item.id, {date: chDateInfo.date, day: parseYmd(chDateInfo.date).toLocaleDateString(undefined,{weekday:'short'})});
      logActivity('Moved "'+chMatch.item.entry+'" to '+fmtDateShort(chDateInfo.date)+' (voice)', 'edit');
      showVoiceSheet('Moved', chMatch.item.entry+' → '+fmtDateShort(chDateInfo.date), 4000);
      speak('Moved '+chMatch.item.entry+' to '+fmtDateShort(chDateInfo.date)+'.');
      return;
    }
    var chNewText = chValue.charAt(0).toUpperCase()+chValue.slice(1);
    if(chMatch.type==='event'){
      var chOldEntry = chMatch.item.entry;
      await updateEvent(chMatch.item.id, {entry: chNewText});
      logActivity('Renamed "'+chOldEntry+'" to "'+chNewText+'" (voice)', 'edit');
    } else {
      await editSubAction(chMatch.goalId, chMatch.idx, chNewText);
    }
    showVoiceSheet('Updated', chNewText, 4000);
    speak('Updated it to '+chNewText+'.');
    return;
  }

  // "delete X", "remove X", "cancel X"
  var deleteMatch = lower.match(/^(delete|remove|cancel)\b\s*(.*)$/);
  if(deleteMatch && deleteMatch[2].trim()){
    var delTarget = deleteMatch[2].replace(/^(the|that|it)\b\s*/,'').trim();
    var delMatchRes = findMatchingOpenItem(delTarget);
    if(delMatchRes && delMatchRes.type==='event'){
      var delEntry = delMatchRes.item.entry;
      await deleteEvent(delMatchRes.item.id);
      showVoiceSheet('Deleted', delEntry, 3500);
      speak('Deleted '+delEntry+'.');
    } else if(delMatchRes && delMatchRes.type==='sub'){
      var delText = delMatchRes.item.text;
      await deleteSubAction(delMatchRes.goalId, delMatchRes.idx);
      showVoiceSheet('Deleted', delText, 3500);
      speak('Deleted '+delText+'.');
    } else {
      showVoiceSheet('Couldn’t find that', 'No open item matched "'+delTarget+'".', 4000);
      speak("I couldn't find a matching item to delete.");
    }
    return;
  }

  var goalAddMatch = lower.match(/^(add|create) (goal|to)\b\s*(.*)$/);
  if(goalAddMatch){
    var g2 = findGoalByArea(goalAddMatch[3]);
    if(g2){
      await addSubAction(g2.id, goalAddMatch[3]);
      showVoiceSheet('Added to '+g2.title, goalAddMatch[3], 4000);
      speak('Added to '+g2.title+'.');
      setTab('goals');
      return;
    }
  }

  var addMatch = lower.match(/^(add|create|new|remind me to|schedule)\b\s*(task|event|reminder)?\s*(.*)$/);
  if(addMatch && addMatch[3]){
    var body = addMatch[3];
    var dateInfo = parseDatePhrase(body);
    var entryText = dateInfo ? body.replace(dateInfo.phrase, '').replace(/\s+/g,' ').trim() : body;
    entryText = entryText.replace(/^(a |an |the |to )/,'').trim();
    entryText = entryText.charAt(0).toUpperCase() + entryText.slice(1);
    var date = dateInfo ? dateInfo.date : todayStr;
    var payload = {
      entry: entryText || 'New item',
      date: date,
      startTime: null,
      category: guessCategory(body),
      priority: 'Medium',
      status: 'Planned',
      day: parseYmd(date).toLocaleDateString(undefined,{weekday:'short'}),
      prepNeeded: null,
      notes: null,
    };
    await addEvent(payload);
    logActivity('Added "'+payload.entry+'" for '+fmtDateShort(date)+' (voice)', 'add');
    showVoiceSheet('Added to planner', payload.entry+' — '+fmtDateShort(date), 4500);
    speak('Added '+payload.entry+' for '+fmtDateShort(date)+'.');
    setTab('today');
    return;
  }

  showVoiceSheet('Didn’t catch a command', 'Try: "add gym tomorrow", "mark X done", "move X to Thursday", "change X to 3pm", "rename X to Y", "delete X", "what\'s today", "what\'s next", "what should I focus on", or "how am I doing".', 6500);
  speak("Sorry, I didn't catch a command.");
}

/* ================= boot ================= */
init();

})();
