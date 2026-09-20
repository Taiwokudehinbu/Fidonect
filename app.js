// Fidonect MVP — static front-end with localStorage. No build step.
const $ = (id) => document.getElementById(id);
const store = {
  load(k, fb) { try { const v = localStorage.getItem("fidonect_" + k); return v ? JSON.parse(v) : fb; } catch { return fb; } },
  save(k, v) { localStorage.setItem("fidonect_" + k, JSON.stringify(v)); }
};

const SEED = {
  institutions: [
    { name: "University of Lagos (UNILAG)", faculties: [
      { name: "Faculty of Science", departments: [{ name: "Biology", programmes: ["B.Sc. Biology", "B.Sc. Microbiology"] }, { name: "Chemistry", programmes: ["B.Sc. Chemistry"] }] },
      { name: "Faculty of Engineering", departments: [{ name: "Computer Engineering", programmes: ["B.Eng. Computer Engineering"] }] } ] },
    { name: "University of Ibadan (UI)", faculties: [
      { name: "Faculty of Science", departments: [{ name: "Biology", programmes: ["B.Sc. Zoology"] }] } ] },
    { name: "Obafemi Awolowo University (OAU)", faculties: [
      { name: "Faculty of Technology", departments: [{ name: "Computer Science", programmes: ["B.Sc. Computer Science"] }] } ] },
    { name: "Yaba College of Technology (YabaTech)", faculties: [
      { name: "School of Science", departments: [{ name: "Science Laboratory Technology", programmes: ["ND SLT", "HND SLT"] }] } ] }
  ],
  people: [
    { name: "Adaeze O.", type: "prospective", dept: "Biology", school: "University of Lagos (UNILAG)", session: "2026/2027", interests: "Biology, Choir", level: "100-level (incoming)" },
    { name: "Tunde B.", type: "existing", dept: "Biology", school: "University of Lagos (UNILAG)", session: "2026/2027", interests: "Football, Tutorials", level: "300-level" },
    { name: "Mariam S.", type: "existing", dept: "Computer Science", school: "Obafemi Awolowo University (OAU)", session: "2026/2027", interests: "Coding, Design", level: "200-level" },
    { name: "Emeka N.", type: "alumni", dept: "Chemistry", school: "University of Lagos (UNILAG)", session: "2020/2021", interests: "Careers, Research", level: "Alumni" },
    { name: "Fatima A.", type: "prospective", dept: "Science Laboratory Technology", school: "Yaba College of Technology (YabaTech)", session: "2026/2027", interests: "Lab science", level: "ND1 incoming" }
  ],
  hub: {
    "University of Lagos (UNILAG)": { overview: "Federal university in Akoka, Lagos.", clearance: "JAMB admission letter, O-level results, birth certificate, LGA letter, passport photos.", fees: "See official portal; varies by faculty.", accommodation: "Hostels are limited — apply early; private hostels in Akoka/Bariga.", updated: "2026-09-20", source: "Official + Community" }
  }
};

let user = store.load("user", null);
let connections = store.load("connections", []);
let messages = store.load("messages", {}); // name -> [{from, text, at}]
let posts = store.load("posts", [{ community: "University of Lagos (UNILAG)", author: "Tunde B.", text: "Welcome 2026/2027 Biology freshers! Ask me about clearance.", at: Date.now() }]);
let notifs = store.load("notifs", []);
let reports = store.load("reports", []);
let mentors = store.load("mentors", [
  { name: "Tunde B.", dept: "Biology", school: "University of Lagos (UNILAG)", level: "300-level", areas: "Clearance, Accommodation, First-semester prep", verified: true },
  { name: "Mariam S.", dept: "Computer Science", school: "Obafemi Awolowo University (OAU)", level: "200-level", areas: "Resumption, Study tips", verified: false }
]);

function toast(m) { const t = $("toast"); t.textContent = m; t.classList.remove("hidden"); setTimeout(() => t.classList.add("hidden"), 2200); }
function persist() { store.save("connections", connections); store.save("messages", messages); store.save("posts", posts); store.save("notifs", notifs); store.save("reports", reports); store.save("mentors", mentors); store.save("user", user); renderNotifCount(); }

// ---------- Auth / Onboarding ----------
function show(view) { ["authView", "onboardView", "appView"].forEach(v => $(v).classList.add("hidden")); $(view).classList.remove("hidden"); }

function initAuth() {
  $("registerBtn").onclick = () => {
    const name = $("regName").value.trim(), email = $("regEmail").value.trim(), phone = $("regPhone").value.trim();
    if (!name || !email) return toast("Enter name and email");
    user = { name, email, phone, type: $("regType").value };
    persist(); fillOnboard(); show("onboardView");
  };
  $("demoBtn").onclick = () => { user = { name: "Demo Student", email: "demo@fidonect.ng", phone: "", type: "prospective" }; persist(); fillOnboard(); show("onboardView"); };
  $("logoutBtn").onclick = () => { user = null; persist(); show("authView"); };
}

function fillOnboard() {
  const inst = SEED.institutions;
  $("obInstitution").innerHTML = inst.map(i => `<option>${i.name}</option>`).join("");
  const sync = () => {
    const s = inst.find(i => i.name === $("obInstitution").value);
    $("obFaculty").innerHTML = s.faculties.map(f => `<option>${f.name}</option>`).join("");
    const f = s.faculties.find(x => x.name === $("obFaculty").value) || s.faculties[0];
    $("obDepartment").innerHTML = f.departments.map(d => `<option>${d.name}</option>`).join("");
    const d = f.departments.find(x => x.name === $("obDepartment").value) || f.departments[0];
    $("obProgramme").innerHTML = d.programmes.map(p => `<option>${p}</option>`).join("");
  };
  $("obInstitution").onchange = sync; $("obFaculty").onchange = sync; sync();
  $("onboardBtn").onclick = () => {
    Object.assign(user, { school: $("obInstitution").value, faculty: $("obFaculty").value, dept: $("obDepartment").value, programme: $("obProgramme").value, session: $("obSession").value, interests: $("obInterests").value });
    persist(); enterApp();
  };
}

// ---------- App ----------
let activeConvo = null;
function enterApp() {
  show("appView");
  $("discoverCtx").textContent = `${user.session || ""} • ${user.dept || ""} • ${user.school || ""}`;
  renderDiscover(); renderCommunities(); renderMentors(); renderConvos(); renderHub(); renderAdmin(); renderProfile();
  pushNotif("Welcome to Fidonect! Complete your profile and say hi in your community.");
}

function renderNotifCount() { const n = notifs.length; const b = $("notifCount"); if (!b) return; b.textContent = n; b.classList.toggle("hidden", n === 0); }
function pushNotif(text) { notifs.unshift({ text, at: Date.now() }); persist(); }

function allPeople() {
  const mine = user ? [{ name: user.name + " (you)", type: user.type, dept: user.dept, school: user.school, session: user.session, interests: user.interests || "", level: "you" }] : [];
  return [...mine, ...SEED.people];
}

function renderDiscover() {
  const q = ($("globalSearch").value || "").toLowerCase();
  const list = SEED.people.filter(p =>
    (!user.dept || p.dept === user.dept || p.school === user.school) &&
    (!q || (p.name + p.dept + p.school).toLowerCase().includes(q))
  );
  $("discoverList").innerHTML = list.map(p => {
    const connected = connections.includes(p.name);
    return `<div class="person"><h4>${p.name}</h4><div class="muted">${p.level} • ${p.type}</div><div>${p.dept} — ${p.school}</div><div class="muted small">${p.session} • ${p.interests}</div>
    <div class="row" style="margin-top:8px"><button onclick="connect('${p.name}')">${connected ? "✓ Connected" : "Connect"}</button><button onclick="message('${p.name}')">Message</button><button onclick="report('${p.name}')" title="Report">⚑</button></div></div>`;
  }).join("") || "<p class='muted'>No matches yet — try clearing search.</p>";
  renderProfile();
}

window.connect = (name) => {
  if (!connections.includes(name)) { connections.push(name); pushNotif(`Connection request accepted by ${name}.`); }
  persist(); renderDiscover(); renderAdmin();
};
window.message = (name) => {
  if (!connections.includes(name)) connections.push(name);
  activeConvo = name; persist(); switchTab("messages"); renderConvos();
};
window.report = (name) => { reports.push({ name, at: Date.now(), reason: "Reported by " + (user?.name || "user") }); persist(); renderAdmin(); toast(`Reported ${name}. Admin will review.`); };

// communities
function renderCommunities() {
  const schools = SEED.institutions.map(i => i.name);
  $("communityPicker").innerHTML = schools.map(s => `<option ${user?.school === s ? "selected" : ""}>${s}</option>`).join("");
  $("communityTitle").textContent = "Community — " + $("communityPicker").value;
  $("communityPicker").onchange = renderFeed; renderFeed();
  $("communityPostBtn").onclick = () => {
    const t = $("communityInput").value.trim(); if (!t) return;
    posts.unshift({ community: $("communityPicker").value, author: user.name, text: t, at: Date.now() });
    $("communityInput").value = ""; persist(); renderFeed(); pushNotif("Your community post is live.");
  };
}
function renderFeed() {
  const c = $("communityPicker").value;
  $("communityTitle").textContent = "Community — " + c;
  $("communityFeed").innerHTML = posts.filter(p => p.community === c).map(p => `<div class="card"><b>${p.author}</b> <span class="muted small">${new Date(p.at).toLocaleString()}</span><p>${p.text}</p></div>`).join("") || "<p class='muted'>No posts yet. Start the conversation.</p>";
}

// Fido AI (rule-based MVP with source labels)
function renderFido() {}
function fidoAnswer(q) {
  const s = q.toLowerCase();
  if (s.includes("clearance") || s.includes("document")) return { source: "Official", cls: "official", text: "For clearance typically: JAMB admission letter, O-level result(s), birth certificate/age declaration, LGA identification letter, passport photographs, and departmental screening forms. Confirm on your school portal — requirements vary by institution." };
  if (s.includes("accommod")) return { source: "Community", cls: "community", text: "Community tip: UNILAG hostels fill fast. Students recommend applying immediately after clearance and budgeting for private hostels in Akoka/Bariga as backup." };
  if (s.includes("prepare") || s.includes("resum")) return { source: "AI guidance", cls: "ai", text: "Prepare: (1) documents + photocopies, (2) accommodation plan, (3) departmental textbooks/materials list, (4) basic cooking/campus essentials, (5) connect with 2–3 classmates and one mentor before resumption." };
  if (s.includes("biology") || s.includes("semester")) return { source: "AI guidance", cls: "ai", text: "First-semester Biology: focus on cell biology, genetics basics, and lab safety. Ask a mentor for past questions and join your department community study threads." };
  return { source: "AI guidance", cls: "ai", text: "General guidance: verify critical dates/fees on the official school portal, then ask your department community or a mentor for practical experience. I can help with resumption, clearance, accommodation, and study prep." };
}
function initFido() {
  const send = () => {
    const q = $("fidoInput").value.trim(); if (!q) return;
    $("fidoChat").innerHTML += `<div class="msg me"><b>You</b><br/>${q}</div>`;
    const a = fidoAnswer(q);
    $("fidoChat").innerHTML += `<div class="msg"><b>Fido AI</b> <span class="tag ${a.cls}">${a.source}</span><br/>${a.text}</div>`;
    $("fidoInput").value = ""; $("fidoChat").scrollTop = 9999;
  };
  $("fidoSend").onclick = send;
  $("fidoInput").onkeydown = (e) => { if (e.key === "Enter") send(); };
  document.querySelectorAll(".suggest button").forEach(b => b.onclick = () => { $("fidoInput").value = b.dataset.q; send(); });
}

// mentors
function renderMentors() {
  $("mentorList").innerHTML = mentors.map((m, i) => `<div class="person"><h4>${m.name} ${m.verified ? "✓" : ""}</h4><div>${m.level} • ${m.dept}</div><div class="muted small">${m.school}</div><div class="muted small">Helps with: ${m.areas}</div><div class="row" style="margin-top:8px"><button onclick="askMentor(${i})">Request mentor</button></div></div>`).join("");
  $("becomeMentorBtn").onclick = () => {
    mentors.push({ name: user.name, dept: user.dept || "General", school: user.school || "", level: "Mentor (pending verification)", areas: user.interests || "General guidance", verified: false });
    pushNotif("Mentor application received. Verification: student ID / institutional email."); persist(); renderMentors();
  };
}
window.askMentor = (i) => { const m = mentors[i]; activeConvo = m.name; if (!messages[m.name]) messages[m.name] = []; messages[m.name].push({ from: m.name, text: `Hi! I'm ${m.name}. Happy to help with ${m.areas}. What do you need?`, at: Date.now() }); persist(); switchTab("messages"); renderConvos(); };

// messages
function renderConvos() {
  const names = [...new Set([...connections, ...Object.keys(messages)])];
  $("convoList").innerHTML = names.map(n => `<div class="convo ${n === activeConvo ? "active" : ""}" onclick="openConvo('${n}')">${n}</div>`).join("") || "<p class='muted'>No conversations yet.</p>";
  renderThread();
}
window.openConvo = (n) => { activeConvo = n; renderConvos(); };
function renderThread() {
  const t = messages[activeConvo] || [];
  $("threadBox").innerHTML = t.map(m => `<div class="msg ${m.from === user?.name ? "me" : ""}"><b>${m.from}</b><br/>${m.text}</div>`).join("") || "<p class='muted'>Select a conversation.</p>";
  $("msgSend").onclick = () => {
    if (!activeConvo) return toast("Pick a conversation first");
    const v = $("msgInput").value.trim(); if (!v) return;
    if (!messages[activeConvo]) messages[activeConvo] = [];
    messages[activeConvo].push({ from: user.name, text: v, at: Date.now() });
    $("msgInput").value = ""; persist(); renderThread();
  };
}

// hub
function renderHub() {
  $("hubPicker").innerHTML = SEED.institutions.map(i => `<option>${i.name}</option>`).join("");
  const draw = () => {
    const h = SEED.hub[$("hubPicker").value] || { overview: "Community-driven page. Official details coming soon.", clearance: "Ask Fido AI or mentors.", fees: "Check official portal.", accommodation: "Ask community.", updated: "2026-09-20", source: "Community" };
    $("hubContent").innerHTML = `<h3>${$("hubPicker").value}</h3><p>${h.overview}</p><p><b>Clearance:</b> ${h.clearance}</p><p><b>Fees:</b> ${h.fees}</p><p><b>Accommodation:</b> ${h.accommodation}</p><p class="muted small">Source: ${h.source} • Updated: ${h.updated}</p>`;
  };
  $("hubPicker").onchange = draw; draw();
}

// admin
function renderAdmin() {
  $("statUsers").textContent = SEED.people.length + (user ? 1 : 0);
  $("statConns").textContent = connections.length;
  $("statMsgs").textContent = Object.values(messages).reduce((a, b) => a + b.length, 0);
  $("reportList").innerHTML = reports.map(r => `<div class="row"><span>⚑ ${r.name} — ${r.reason}</span></div>`).join("") || "<p class='muted'>No reports.</p>";
  $("announceBtn").onclick = () => { const v = $("announceInput").value.trim(); if (!v) return; pushNotif("Announcement: " + v); $("announceInput").value = ""; toast("Announcement sent as notification."); };
}

function renderProfile() {
  if (!user) return;
  $("profileCard").innerHTML = `<p><b>${user.name}</b> (${user.type})</p><p>${user.programme || ""} • ${user.dept || ""}</p><p class="muted">${user.school || ""} • ${user.session || ""}</p><p class="muted small">${user.email || ""} • Interests: ${user.interests || "—"}</p><p class="muted small">Privacy: name, school & department visible. Phone hidden by default.</p>`;
}

// tabs + search + notifs
function switchTab(name) {
  document.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  ["discover", "community", "fido", "mentors", "messages", "hub", "admin", "profile"].forEach(t => $("tab-" + t).classList.toggle("hidden", t !== name));
}
document.querySelectorAll(".tabs button").forEach(b => b.onclick = () => switchTab(b.dataset.tab));

$("globalSearch").oninput = () => { if (!$("appView").classList.contains("hidden")) renderDiscover(); };
$("notifBtn").onclick = () => alert(notifs.map(n => "• " + n.text).join("\n") || "No notifications");

initAuth(); initFido(); renderNotifCount();
if (user && user.school) enterApp(); else if (user) { fillOnboard(); show("onboardView"); }
