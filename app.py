import json
import os
import sqlite3
from datetime import datetime
import streamlit as st
from openai import OpenAI

st.set_page_config(page_title="Memory Bank", page_icon="🧠", layout="wide")
DB = "memory_bank.db"


def db():
    conn = sqlite3.connect(DB)
    conn.execute("CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT, created TEXT, text TEXT, category TEXT, due_date TEXT, action TEXT, plan TEXT, status TEXT DEFAULT 'Open')")
    return conn


def classify(text):
    client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    prompt = f'''You are a personal/work memory assistant. Analyze this brain dump and return ONLY valid JSON with keys: category, due_date, action, plan. Category must be one of Remember, Do, Improve, Idea. due_date should be YYYY-MM-DD if a date is clearly stated or can be reasonably inferred from words like tomorrow; otherwise null. action should be a concise action if one is needed, otherwise null. plan should be a short practical next-step plan if useful, otherwise null. Never invent a specific deadline. Brain dump: {text}'''
    response = client.responses.create(model="gpt-5.6-luna", input=prompt)
    return json.loads(response.output_text)


def add_memory(text):
    parsed = classify(text)
    conn = db()
    conn.execute("INSERT INTO memories(created,text,category,due_date,action,plan) VALUES(?,?,?,?,?,?)", (datetime.now().isoformat(timespec="seconds"), text, parsed.get("category", "Remember"), parsed.get("due_date"), parsed.get("action"), parsed.get("plan")))
    conn.commit(); conn.close()


def load_memories():
    conn = db(); rows = conn.execute("SELECT * FROM memories ORDER BY id DESC").fetchall(); conn.close(); return rows


def update_status(memory_id, status):
    conn = db(); conn.execute("UPDATE memories SET status=? WHERE id=?", (status, memory_id)); conn.commit(); conn.close()


def delete_memory(memory_id):
    conn = db(); conn.execute("DELETE FROM memories WHERE id=?", (memory_id,)); conn.commit(); conn.close()


db()
st.title("🧠 Personal Memory Bank")
st.caption("Dump it here. I'll organize it, turn it into action, and help you remember it.")

if not os.getenv("OPENAI_API_KEY"):
    st.warning("Add OPENAI_API_KEY to use AI organization.")

st.subheader("Brain Dump")
text = st.text_area("What's on your mind?", height=140, placeholder="Example: I need to get better at explaining monthly variances. I should ask Sarah how she handles inventory reserves next week.")
if st.button("Save to Memory Bank", type="primary", use_container_width=True):
    if not text.strip(): st.error("Type something first.")
    elif not os.getenv("OPENAI_API_KEY"): st.error("Add your OpenAI API key first.")
    else:
        with st.spinner("Organizing that..."):
            try:
                add_memory(text.strip()); st.success("Saved."); st.rerun()
            except Exception as exc:
                st.error("I couldn't organize that yet."); st.exception(exc)

rows = load_memories()
open_rows = [r for r in rows if r[7] == "Open"]
completed_rows = [r for r in rows if r[7] != "Open"]

st.divider()
st.subheader("What Needs Your Attention?")
if not open_rows:
    st.info("Nothing here yet. Brain-dump something above.")
else:
    for row in open_rows:
        memory_id, created, original, category, due_date, action, plan, status = row
        with st.container(border=True):
            st.write(f"**{category}**")
            st.write(original)
            if due_date: st.write(f"📅 **Due:** {due_date}")
            if action: st.write(f"**Next action:** {action}")
            if plan: st.write(f"**Plan:** {plan}")
            c1, c2 = st.columns([1, 1])
            with c1:
                if st.button("✅ Done", key=f"done_{memory_id}", use_container_width=True): update_status(memory_id, "Done"); st.rerun()
            with c2:
                if st.button("🗑️ Delete", key=f"delete_{memory_id}", use_container_width=True): delete_memory(memory_id); st.rerun()

with st.expander(f"Memory Archive ({len(completed_rows)})"):
    for row in completed_rows:
        memory_id, created, original, category, due_date, action, plan, status = row
        st.write(f"**{category}** — {original}")
        st.caption(f"{status} • {created[:10]}")
