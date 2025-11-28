// static/app.js
// Frontend logic for Test Recommender
// Single-question-per-page MCQ flow
// Reads prolific_id, session_id, study_id, handles timing and API calls.

const API_ROOT = ""; // same origin

// helper: parse URL params
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
let setNumber = 0; // 0 = qualification, 1..N recommender sets
let setsCompleted = 0;

// UI refs
const metaBox = document.getElementById("meta");
const consentPanel = document.getElementById("consent");
const consentBtn = document.getElementById("consent-btn");
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
const completionDiv = document.getElementById("completion");
const completionCodeP = document.getElementById("completion-code");

metaBox.innerText = `prolific_id=${meta.prolific_id}, session_id=${meta.session_id}, study_id=${meta.study_id}`;

// Start session on backend
async function startSession() {
  await fetch(API_ROOT + "/api/session/start", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(meta)
  });
}

// Load qualification questions
async function loadQualification() {
  const resp = await fetch(API_ROOT + "/api/questions/qualification");
  const data = await resp.json();
  qualificationQuestions = data.questions || [];
}

// render a question (single per page)
function renderQuestion(q, index) {
  currentQuestionStart = performance.now();
  questionCounter.innerText = `Question ${index + 1} of ${qualificationQuestions.length}`;
  // render LaTeX in question
  qText.innerHTML = "";
  const span = document.createElement("span");
  span.innerText = q.question;
  qText.appendChild(span);
  try {
    // render by parsing between $...$
    // Simple: replace inline $...$ with katex.renderToString
    const html = q.question.replace(/\$(.+?)\$/g, (m, expr) => katex.renderToString(expr, {throwOnError:false}));
    qText.innerHTML = html;
  } catch (e) {
    qText.innerText = q.question;
  }

  choicesDiv.innerHTML = "";
  q.choices.forEach((ch, idx) => {
    const d = document.createElement("div");
    d.className = "choice";
    d.dataset.index = idx;
    // render choice text with KaTeX if needed
    try {
      d.innerHTML = katex.renderToString(ch, {throwOnError:false});
    } catch (e) {
      d.innerText = ch;
    }
    d.addEventListener("click", () => selectChoice(d, q));
    choicesDiv.appendChild(d);
  });

  nextBtn.disabled = true;
}

// when user selects a choice
async function selectChoice(choiceDiv, question) {
  // mark selected visually
  document.querySelectorAll(".choice").forEach(c => c.classList.remove("selected"));
  choiceDiv.classList.add("selected");
  nextBtn.disabled = false;

  // compute time on question
  const now = performance.now();
  const elapsed_ms = now - currentQuestionStart;
  const elapsed_s = elapsed_ms / 1000.0;

  const choice_index = parseInt(choiceDiv.dataset.index);
  const correct_index = question.correct_index;
  const correct = (choice_index === correct_index) ? 1 : 0;

  // send response to backend
  const payload = {
    prolific_id: meta.prolific_id,
    session_id: meta.session_id,
    study_id: meta.study_id,
    set_number: setNumber,
    question_id: question.id,
    question_text: question.question,
    choice_index: choice_index,
    choice_text: question.choices[choice_index],
    correct_index: correct_index,
    correct: correct,
    time_on_question: elapsed_s
  };

  await fetch(API_ROOT + "/api/response", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(payload)
  });
}

// go to next question
function nextQuestion() {
  currentIndex++;
  if (currentIndex >= qualificationQuestions.length) {
    // finished qualification
    finishQualification();
  } else {
    renderQuestion(qualificationQuestions[currentIndex], currentIndex);
  }
}

// finish qualification scoring
async function finishQualification() {
  // calculate score by fetching responses or computing locally (we compute locally here)
  // For simplicity, compute based on the UI selections recorded on server is fine, but here we compute:
  // In prototype we will ask server for data, but to be simple: show that participant completed qualification
  quizArea.classList.add("hidden");
  scoreArea.classList.remove("hidden");

  // For correct counting, fetch responses from backend would be better; here we recompute based on selections stored in session memory is not kept.
  // For prototype: ask participant to proceed.
  scoreDiv.innerHTML = "<p>You have completed the qualification test.</p>";

  qualActions.innerHTML = `
    <p>Do you want to proceed to the main study?</p>
    <button id="proceed-yes">Yes, proceed</button>
    <button id="proceed-no">No, finish here</button>
  `;
  document.getElementById("proceed-yes").addEventListener("click", () => startRecommender());
  document.getElementById("proceed-no").addEventListener("click", async () => {
    // finish with 0 sets completed -> immediate completion code
    const resp = await fetch(API_ROOT + "/api/session/finish", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({...meta, sets_completed: 0})
    });
    const data = await resp.json();
    if (data.completion_code) showCompletionCode(data.completion_code);
  });
}

// start recommender loop
async function startRecommender() {
  scoreArea.classList.add("hidden");
  quizArea.classList.remove("hidden");
  setNumber = 1;
  await fetchNextSet(setNumber);
}

// fetch next set from recommender
async function fetchNextSet(n) {
  // call backend recommender
  const resp = await fetch(API_ROOT + "/api/recommender/next_set", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({...meta, set_number: n})
  });
  const data = await resp.json();
  // data.questions is array of 5 questions
  // for simplicity, use same UI but replace qualificationQuestions
  qualificationQuestions = data.questions;
  currentIndex = 0;
  setNumber = n;
  renderQuestion(qualificationQuestions[currentIndex], currentIndex);
}

// when finish session clicked
finishBtn.addEventListener("click", async () => {
  // finish current set (if half done, still allow finish)
  // increment setsCompleted if we already finished at least one set (we increment when a set is done)
  // For prototype: we increment setsCompleted by 1 for each set completed (we increment when we finish last question of a set)
  const resp = await fetch(API_ROOT + "/api/session/finish", {
    method: "POST", headers: {"Content-Type":"application/json"},
    body: JSON.stringify({...meta, sets_completed: setsCompleted})
  });
  const data = await resp.json();
  if (data.survey) {
    // ask to do survey
    quizArea.classList.add("hidden");
    surveyArea.classList.remove("hidden");
  } else if (data.completion_code) {
    showCompletionCode(data.completion_code);
  }
});

function showCompletionCode(code) {
  surveyArea.classList.add("hidden");
  completionDiv.classList.remove("hidden");
  completionCodeP.innerText = code;
}

// consent flow
consentBtn.addEventListener("click", async () => {
  consentPanel.classList.add("hidden");
  quizArea.classList.remove("hidden");
  // start session on backend
  await startSession();
  // load qualification and render first question
  await loadQualification();
  currentIndex = 0;
  renderQuestion(qualificationQuestions[currentIndex], currentIndex);
});

// next button
nextBtn.addEventListener("click", async () => {
  // if at end of a recommender set, increment setsCompleted and either fetch next or continue
  // determine if we are in recommender mode (setNumber > 0) and if currentIndex is last index
  const isLastInSet = (currentIndex >= (qualificationQuestions.length - 1));
  if (isLastInSet && setNumber > 0) {
    setsCompleted += 1;
    if (setsCompleted >= 50) {
      // force finish
      finishBtn.click();
      return;
    }
    // fetch next set automatically
    setNumber += 1;
    await fetchNextSet(setNumber);
  } else {
    nextQuestion();
  }
});

// survey submit
surveySubmit.addEventListener("click", async () => {
  const responses = {
    mental: document.getElementById("q_mental").value,
    frustration: document.getElementById("q_frustration").value
  };
  const resp = await fetch(API_ROOT + "/api/survey/submit", {
    method: "POST", headers: {"Content-Type":"application/json"},
    body: JSON.stringify({...meta, responses})
  });
  const data = await resp.json();
  if (data.completion_code) {
    showCompletionCode(data.completion_code);
  }
});