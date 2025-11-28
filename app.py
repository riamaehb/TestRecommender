# Test Recommender Backend (FastAPI)
# Handles qualification test, recommender system, timing, responses, and completion codes.

# app.py
import json
import sqlite3
import string
import random
import csv
from datetime import datetime
from pathlib import Path
from fastapi import FastAPI, Request, HTTPException, Form
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

BASE = Path(__file__).resolve().parent
DB_PATH = BASE / "data" / "quiz.db"
QUESTIONS_DIR = BASE / "questions"
QUAL_FILE = QUESTIONS_DIR / "qualification.json"

# Ensure dirs
(BASE / "data").mkdir(exist_ok=True)
QUESTIONS_DIR.mkdir(exist_ok=True)

app = FastAPI(title="Quiz Platform (Prototype)")

# Allow local frontend to talk to backend (adjust origins later)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# serve static frontend
app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")

def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    # responses table stores each question response
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS responses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT,
            prolific_id TEXT,
            session_id TEXT,
            study_id TEXT,
            set_number INTEGER, -- which set (0 = qualification)
            question_id TEXT,
            question_text TEXT,
            choice_index INTEGER,
            choice_text TEXT,
            correct_index INTEGER,
            correct INTEGER, -- 1 or 0
            time_on_question REAL -- seconds
        )
        """
    )
    # sessions table stores metadata & summary (and completion code)
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            prolific_id TEXT,
            session_id TEXT,
            study_id TEXT,
            started_at TEXT,
            completed_at TEXT,
            completion_code TEXT,
            sets_completed INTEGER DEFAULT 0
        )
        """
    )
    conn.commit()
    conn.close()

def load_json(path: Path):
    if not path.exists():
        return []
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def random_code(n=10):
    alphabet = string.ascii_uppercase + string.digits
    return "".join(random.choice(alphabet) for _ in range(n))

@app.on_event("startup")
def startup():
    init_db()
    # ensure qualification file exists (if not, save a small sample)
    if not QUAL_FILE.exists():
        sample = [
            {
                "id": "q1",
                "type": "mcq",
                "question": "What is the derivative of $x^2$?",
                "choices": ["2x", "x", "x^3", "2"],
                "correct_index": 0
            },
            {
                "id": "q2",
                "type": "mcq",
                "question": "Evaluate $\\int_0^1 x^2 \\, dx$",
                "choices": ["1/3", "1/2", "2/3", "1/4"],
                "correct_index": 0
            },
            {
                "id": "q3",
                "type": "mcq",
                "question": "Solve for $x$: $2x+3=7$",
                "choices": ["1", "2", "3", "4"],
                "correct_index": 1
            }
        ]
        with open(QUAL_FILE, "w", encoding="utf-8") as f:
            json.dump(sample, f, indent=2)

@app.get("/", response_class=HTMLResponse)
async def root():
    # serve the frontend index
    index_file = BASE / "static" / "index.html"
    return FileResponse(index_file)

@app.get("/api/questions/qualification")
async def get_qualification_questions():
    # Return the static qualification set (list of MCQs)
    data = load_json(QUAL_FILE)
    return JSONResponse(content={"questions": data})

@app.post("/api/response")
async def post_response(payload: dict):
    """
    Expected JSON payload:
    {
      "prolific_id": "...",
      "session_id": "...",
      "study_id": "...",
      "set_number": 0,
      "question_id": "q1",
      "question_text": "....",
      "choice_index": 0,
      "choice_text": "2x",
      "correct_index": 0,
      "correct": 1,
      "time_on_question": 3.51
    }
    """
    required = ["prolific_id", "session_id", "study_id", "question_id"]
    for k in required:
        if k not in payload:
            raise HTTPException(status_code=400, detail=f"Missing {k}")
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    ts = datetime.utcnow().isoformat()
    c.execute(
        """
        INSERT INTO responses (
            timestamp, prolific_id, session_id, study_id,
            set_number, question_id, question_text, choice_index,
            choice_text, correct_index, correct, time_on_question
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        (
            ts,
            payload.get("prolific_id"),
            payload.get("session_id"),
            payload.get("study_id"),
            payload.get("set_number", 0),
            payload.get("question_id"),
            payload.get("question_text"),
            payload.get("choice_index"),
            payload.get("choice_text"),
            payload.get("correct_index"),
            payload.get("correct"),
            payload.get("time_on_question"),
        ),
    )
    conn.commit()
    conn.close()
    return {"status": "ok"}

@app.post("/api/session/start")
async def start_session(payload: dict):
    """
    payload: { prolific_id, session_id, study_id }
    returns session meta
    """
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute(
        "INSERT INTO sessions (prolific_id, session_id, study_id, started_at) VALUES (?,?,?,?)",
        (payload.get("prolific_id"), payload.get("session_id"), payload.get("study_id"), datetime.utcnow().isoformat()),
    )
    conn.commit()
    sid = c.lastrowid
    conn.close()
    return {"status": "ok", "session_db_id": sid}

@app.post("/api/recommender/next_set")
async def recommend_next_set(payload: dict):
    """
    Dummy recommender that returns a set of 5 randomly chosen/created MCQ items.
    Expected payload: { prolific_id, session_id, study_id, set_number, learner_state (optional) }
    Response: { set_number: N, questions: [ {id, question, choices, correct_index}, ... ] }
    """
    # For prototype, we create simple math MCQs randomly
    set_number = payload.get("set_number", 1)
    # simple dummy generator: make 5 arithmetic MCQs
    questions = []
    for i in range(5):
        a = random.randint(1, 12)
        b = random.randint(1, 12)
        correct = a + b
        # shuffle choices
        choices = [str(correct), str(correct + random.randint(1,3)), str(correct - random.randint(1,2)), str(correct + random.randint(4,6))]
        random.shuffle(choices)
        correct_index = choices.index(str(correct))
        q = {
            "id": f"set{set_number}_q{i}",
            "type": "mcq",
            "question": f"What is ${a}+{b}$?",
            "choices": choices,
            "correct_index": correct_index
        }
        questions.append(q)
    return {"set_number": set_number, "questions": questions}

@app.post("/api/session/finish")
async def finish_session(payload: dict):
    """
    Called when user hits 'Finish Session'.
    payload: { prolific_id, session_id, study_id, sets_completed }
    Returns either: { completion_code: "ABC123" } OR { survey: true } to proceed to survey
    """
    prolific_id = payload.get("prolific_id")
    session_id = payload.get("session_id")
    study_id = payload.get("study_id")
    sets_completed = int(payload.get("sets_completed", 0))
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    # update session summary (if exists)
    c.execute(
        """
        UPDATE sessions
        SET completed_at = ?, sets_completed = ?
        WHERE prolific_id = ? AND session_id = ? AND study_id = ?
        """,
        (datetime.utcnow().isoformat(), sets_completed, prolific_id, session_id, study_id),
    )
    # if fewer than 2 sets -> immediate completion code
    if sets_completed < 2:
        code = random_code(8)
        c.execute(
            "UPDATE sessions SET completion_code = ? WHERE prolific_id = ? AND session_id = ? AND study_id = ?",
            (code, prolific_id, session_id, study_id),
        )
        conn.commit()
        conn.close()
        return {"completion_code": code, "survey": False}
    else:
        # else: request to show post-study survey
        conn.commit()
        conn.close()
        return {"survey": True}

@app.post("/api/survey/submit")
async def submit_survey(payload: dict):
    """
    Collect the post-study survey responses.
    payload: { prolific_id, session_id, study_id, responses: {...} }
    """
    # For prototype: just store survey as a JSON file append or table; here we append to a CSV.
    out = BASE / "data" / "surveys.csv"
    header = ["timestamp", "prolific_id", "session_id", "study_id", "survey_json"]
    row = [datetime.utcnow().isoformat(), payload.get("prolific_id"), payload.get("session_id"), payload.get("study_id"), json.dumps(payload.get("responses", {}))]
    exists = out.exists()
    with open(out, "a", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        if not exists:
            writer.writerow(header)
        writer.writerow(row)
    # After survey we give completion code
    code = random_code(8)
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute(
        "UPDATE sessions SET completion_code = ?, completed_at = ? WHERE prolific_id = ? AND session_id = ? AND study_id = ?",
        (code, datetime.utcnow().isoformat(), payload.get("prolific_id"), payload.get("session_id"), payload.get("study_id")),
    )
    conn.commit()
    conn.close()
    return {"completion_code": code}

@app.get("/admin/export_csv")
async def admin_export_csv():
    """
    Generate a CSV export of all responses (simple admin endpoint)
    """
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT * FROM responses ORDER BY id")
    rows = c.fetchall()
    cols = [desc[0] for desc in c.description]
    conn.close()
    out_file = BASE / "data" / "responses_export.csv"
    with open(out_file, "w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(cols)
        writer.writerows(rows)
    return FileResponse(out_file, filename="responses_export.csv")

# simple health
@app.get("/api/health")
async def health():
    return {"status": "ok"}