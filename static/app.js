// static/app.js
// Final version: KaTeX intact + LaTeX wrapping + full multi-set summary + survey-after-summary (option B)

// ========== Config / Globals ==========
const API_ROOT = ""; // same origin

function getParams() {
  const params = new URLSearchParams(window.location.search);
  return {
    prolific_id: params.get("prolific_id") || "",
    session_id: params.get("session_id") || "",
    study_id: params.get("study_id") || ""
  };
}

let meta = getParams();
let qualificationQuestions = [];
let currentIndex = 0;
let currentQuestionStart = null;
let setNumber = 0; // 0 = qualification, >=1 recommender sets
let setsCompleted = 0;
let setScores = []; // stores completed recommender set results

// ========== UI refs ==========
const consentPanel = document.getElementById("consent");
const consentBtn = document.getElementById("consent-btn");
const instructionsPanel = document.getElementById("instructions");

const quizArea = document.getElementById("quiz-area");
const qText = document.getElementById("question-text");
const choicesDiv = document.getElementById("choices");
const nextBtn = document.getElementById("next-btn");
const finishBtn = document.getElementById("finish-btn");
const questionCounter = document.getElementById("question-counter");

const scoreArea = document.getElementById("score-area");
const scoreDiv = document.getElementById("score");
const qualActions = document.getElementById("qual-actions");

const surveyArea = document.getElementById("survey-area");
const surveySubmit = document.getElementById("survey-submit");

const sessionSummary = document.getElementById("session-summary");
const sessionSummaryContent = document.getElementById("session-summary-content");

const completionDiv = document.getElementById("completion");
const completionCodeP = document.getElementById("completion-code");

// welcome
document.getElementById("welcome").innerText = `Welcome, ${meta.prolific_id}!`;

// ========== KaTeX renderer (original inline method) ==========
function renderInlineKatex(text) {
  if (!text) return "";
  return text.replace(/\$(.+?)\$/g, (match, expr) => {
    try {
      return katex.renderToString(expr, { throwOnError: false });
    } catch (e) {
      return expr;
    }
  });
}

// ========== Helpers ==========
function disableQuestionUI() {
  // Hide the question UI and instructions
  quizArea.classList.add("hidden");
  instructionsPanel.classList.add("hidden");

  // disable nav
  nextBtn.disabled = true;
  finishBtn.disabled = true;

  // visually disable choices
  document.querySelectorAll(".choice").forEach(c => {
    c.style.pointerEvents = "none";
    c.style.opacity = 0.5;
  });
}

function buildFullSummaryHTML(includeQualification = false, lastQualification = null) {
  // includeQualification: if true, include a qualification line (for setNumber==0 flow)
  let html = `<p><strong>Session Summary</strong></p><ul>`;

  if (includeQualification && lastQualification) {
    html += `<li>Qualification: ${lastQualification.correct} / ${lastQualification.total}</li>`;
  }

  // list recommender sets
  setScores.forEach(s => {
    html += `<li>Set ${s.set}: ${s.correct} / ${s.total}</li>`;
  });

  html += `</ul>`;
  return html;
}

// ========== Backend calls ==========
async function startSession() {
  await fetch(API_ROOT + "/api/session/start", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(meta)
  });
}

async function loadQualification() {
  const resp = await fetch(API_ROOT + "/api/questions/qualification");
  const data = await resp.json();
  qualificationQuestions = data.questions || [];
}

// ========== Render question ==========
function renderQuestion(q, idx) {
  // progress bar
  const pb = document.getElementById("progress-bar");
  if (pb && qualificationQuestions.length > 0) {
    const progressPercent = Math.round(((idx + 1) / qualificationQuestions.length) * 100);
    pb.style.width = progressPercent + "%";
  }

  currentQuestionStart = performance.now();
  questionCounter.innerText = `Question ${idx + 1} of ${qualificationQuestions.length}`;

  qText.classList.add("question-card");
  try {
    qText.innerHTML = renderInlineKatex(q.question);
  } catch (e) {
    qText.innerText = q.question;
  }

  // choices
  choicesDiv.innerHTML = "";
  qualificationQuestions[idx].choices.forEach((choiceText, choiceIdx) => {
    const choiceEl = document.createElement("div");
    choiceEl.className = "choice";
    choiceEl.dataset.index = choiceIdx;

    // If a choice looks like LaTeX (starts with \ OR contains ^ or _), wrap it
    let renderedChoice = choiceText;
    if (
      /^\\/.test(choiceText.trim()) ||
      /[0-9a-zA-Z]\^/.test(choiceText) ||
      /[0-9a-zA-Z]_/.test(choiceText)
    ) {
      renderedChoice = `$${choiceText}$`;
    }

    try {
      choiceEl.innerHTML = renderInlineKatex(renderedChoice);
    } catch (e) {
      choiceEl.innerText = choiceText;
    }

    choiceEl.addEventListener("click", () => selectChoice(choiceEl, qualificationQuestions[idx], choiceIdx));
    choicesDiv.appendChild(choiceEl);
  });

  // Hide finish button during qualification
  if (setNumber === 0) {
    finishBtn.classList.add("hidden");
  } else {
    finishBtn.classList.remove("hidden");
  }

  nextBtn.disabled = true;
}

// ========== Choice selection ==========
async function selectChoice(choiceEl, questionObj, choiceIdx) {
  // visual
  document.querySelectorAll(".choice").forEach(c => c.classList.remove("selected"));
  choiceEl.classList.add("selected");
  nextBtn.disabled = false;

  // store on question object for later summary
  questionObj.user_selected = choiceIdx;

  // time
  const elapsed_s = (performance.now() - currentQuestionStart) / 1000;

  const payload = {
    prolific_id: meta.prolific_id,
    session_id: meta.session_id,
    study_id: meta.study_id,
    set_number: setNumber,
    question_id: questionObj.id,
    question_text: questionObj.question,
    choice_index: choiceIdx,
    choice_text: questionObj.choices[choiceIdx],
    correct_index: questionObj.correct_index,
    correct: choiceIdx === questionObj.correct_index ? 1 : 0,
    time_on_question: elapsed_s
  };

  await fetch(API_ROOT + "/api/response", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(payload)
  });
}

// ========== Next question / finishing a set logic ==========
async function nextQuestion() {
  currentIndex++;
  if (currentIndex >= qualificationQuestions.length) {
    // end of this set
    finishQualification();
  } else {
    renderQuestion(qualificationQuestions[currentIndex], currentIndex);
  }
}

// When user advances at last question of a recommender set, we must save the set result BEFORE fetching the next set.
// This logic is in the next button handler below.

// ========== Finish Qualification ==========
async function finishQualification() {
  // hide quiz, show score area
  quizArea.classList.add("hidden");
  scoreArea.classList.remove("hidden");

  const resp = await fetch(API_ROOT + "/api/qualification/score", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(meta)
  });

  const data = await resp.json();
  const { correct, total, passed } = data;

  scoreDiv.innerHTML = `
    <p>You answered <strong>${correct}</strong> out of <strong>${total}</strong> questions correctly.</p>
    <p>Status: <strong style="color:${passed ? 'green' : 'red'}">${passed ? 'PASSED' : 'FAILED'}</strong></p>
  `;

  if (passed) {
    qualActions.innerHTML = `
      <p>You passed the qualification test. Do you want to continue?</p>
      <button id="proceed-yes">Yes, proceed</button>
      <button id="proceed-no">No, finish here</button>
    `;
  } else {
    qualActions.innerHTML = `
      <p>You did not pass the qualification test.</p>
      <button id="proceed-no">Finish</button>
    `;
  }

  // proceed-no handler (user chooses to finish here)
  document.getElementById("proceed-no").onclick = async () => {
    // remove actions so proceed-yes disappears
    qualActions.innerHTML = "";
    // hide score panel
    scoreArea.classList.add("hidden");

    // finish session
    const resp = await fetch(API_ROOT + "/api/session/finish", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({...meta, sets_completed: 0})
    });
    const d = await resp.json();

    if (d.completion_code) {
      showCompletionCode(d.completion_code);
    }

    // lock UI
    disableQuestionUI();
  };

  // proceed-yes handler
  const yesBtn = document.getElementById("proceed-yes");
  if (yesBtn) {
    yesBtn.onclick = () => startRecommender();
  }
}

// ========== Recommender: fetch next set ==========
async function startRecommender() {
  scoreArea.classList.add("hidden");
  instructionsPanel.classList.remove("hidden");
  quizArea.classList.remove("hidden");

  setNumber = 1;
  await fetchNextSet(setNumber);
}

async function fetchNextSet(n) {
  const resp = await fetch(API_ROOT + "/api/recommender/next_set", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({...meta, set_number: n})
  });
  const data = await resp.json();
  qualificationQuestions = data.questions || [];
  currentIndex = 0;
  setNumber = n;
  renderQuestion(qualificationQuestions[currentIndex], currentIndex);
}

// ========== Finish Session (recommender qualification unified entry) ==========
finishBtn.addEventListener("click", async () => {

  // Hide question UI immediately
  disableQuestionUI();

  // Compute this set's score (current in-memory set)
  let correct = 0;
  let total = qualificationQuestions.length;
  qualificationQuestions.forEach(q => {
    if (q.user_selected !== undefined && q.user_selected === q.correct_index) {
      correct++;
    }
  });

  // If recommender set, save it to setScores
  // Also if user clicks Finish mid-set, we still record the current performance for that set.
  if (setNumber >= 1) {
    setScores.push({ set: setNumber, correct, total });
  }

  // Build summary HTML but DO NOT show for recommender yet (option B)
  // For qualification, show immediately and go to completion code path.
  if (setNumber === 0) {
    // Qualification: show one-line summary then finish
    const qualHtml = buildFullSummaryHTML(true, {correct, total});
    sessionSummaryContent.innerHTML = qualHtml + `<p>Submitting your session...</p>`;
    sessionSummary.classList.remove("hidden");

    // Submit session finish to backend
    const resp = await fetch(API_ROOT + "/api/session/finish", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({...meta, sets_completed: setsCompleted})
    });
    const data = await resp.json();

    if (data.completion_code) {
      sessionSummaryContent.innerHTML += `<p>Your completion code is shown below.</p>`;
      showCompletionCode(data.completion_code);
    }

    return;
  }

  // For recommender: submit finish; show survey AFTER backend responds (survey flag)
  sessionSummaryContent.innerHTML = `<p>Submitting your session...</p>`;
  sessionSummary.classList.remove("hidden");

  const resp = await fetch(API_ROOT + "/api/session/finish", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({...meta, sets_completed: setsCompleted})
  });

  const data = await resp.json();

  // if backend asks for survey flow
  if (data.survey) {
    // Show survey NOW (summary will be shown AFTER survey submit)
    sessionSummaryContent.innerHTML = `<p>Please complete the post-test survey. Your session summary will be shown afterwards.</p>`;
    surveyArea.classList.remove("hidden");
    setupTLXSliders();
  } else if (data.completion_code) {
    // backend may directly return completion code
    sessionSummaryContent.innerHTML += `<p>Your completion code is shown below.</p>`;
    showCompletionCode(data.completion_code);
  }
});

// ========== Survey submit: after survey we show the session summary (option B) ==========
surveySubmit.addEventListener("click", async () => {
  const responses = {
    mental_demand: Number(document.getElementById("tlx_mental").value),
    physical_demand: Number(document.getElementById("tlx_physical").value),
    temporal_demand: Number(document.getElementById("tlx_temporal").value),
    performance: Number(document.getElementById("tlx_performance").value),
    effort: Number(document.getElementById("tlx_effort").value),
    frustration: Number(document.getElementById("tlx_frustration").value)
  };

  // Submit survey to backend
  const resp = await fetch(API_ROOT + "/api/survey/submit", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({...meta, responses})
  });

  const data = await resp.json();

  // Build and show full summary now that survey is done
  const fullHtml = buildFullSummaryHTML(false, null) + `<p>Thank you. Submitting final details...</p>`;
  sessionSummaryContent.innerHTML = fullHtml;
  sessionSummary.classList.remove("hidden");

  // If backend returned completion code in survey response, show it
  if (data.completion_code) {
    sessionSummaryContent.innerHTML += `<p>Your completion code is shown below.</p>`;
    showCompletionCode(data.completion_code);
  }
});

// ========== Completion code UI ==========
function showCompletionCode(code) {
  surveyArea.classList.add("hidden");
  completionDiv.classList.remove("hidden");
  completionCodeP.innerText = code || "";
  // After showing completion code, lock the UI
  disableQuestionUI();
}

// ========== Consent flow ==========
consentBtn.addEventListener("click", async () => {
  consentPanel.classList.add("hidden");
  instructionsPanel.classList.remove("hidden");
  quizArea.classList.remove("hidden");

  await startSession();
  await loadQualification();

  currentIndex = 0;
  renderQuestion(qualificationQuestions[currentIndex], currentIndex);
});

// ========== Next button handler ==========
nextBtn.addEventListener("click", async () => {
  const isLastInSet = currentIndex >= qualificationQuestions.length - 1;

  if (isLastInSet && setNumber > 0) {
    // Store completed set score BEFORE we move to the next set
    let correct = 0;
    let total = qualificationQuestions.length;
    qualificationQuestions.forEach(q => {
      if (q.user_selected !== undefined && q.user_selected === q.correct_index) correct++;
    });
    setScores.push({ set: setNumber, correct, total });

    setsCompleted += 1;

    if (setsCompleted >= 50) {
      finishBtn.click();
      return;
    }

    // increment set number and fetch next set
    setNumber += 1;
    await fetchNextSet(setNumber);
  } else {
    nextQuestion();
  }
});

// Update slider value labels live
function setupTLXSliders() {
  const sliders = [
    ["tlx_mental", "val_mental"],
    ["tlx_physical", "val_physical"],
    ["tlx_temporal", "val_temporal"],
    ["tlx_performance", "val_performance"],
    ["tlx_effort", "val_effort"],
    ["tlx_frustration", "val_frustration"]
  ];

  sliders.forEach(([sliderId, labelId]) => {
    const s = document.getElementById(sliderId);
    const l = document.getElementById(labelId);
    if (s && l) {
      l.textContent = s.value; // initial
      s.addEventListener("input", () => {
        l.textContent = s.value;
      });
    }
  });
}
