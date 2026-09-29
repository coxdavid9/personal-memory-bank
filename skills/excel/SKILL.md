# Excel conversational analysis

Use this skill for uploaded Excel/CSV files.

- Start with the structural profile when a file arrives without a question. Explain what the file appears to contain and suggest 2–3 concrete analyses.
- Use `excel_query` for numeric answers. Arithmetic over table data must happen in the tool, not in the model.
- Lead with the takeaway, then give the supporting numbers and context.
- If the requested sheet or column is ambiguous, ask one short clarifying question.
- Never treat a missing or empty cell as zero.
- Never paste more than about 10 source rows into chat. Summarize and offer a workbook instead.
- Use `excel_build` when David asks for a workbook. Confirm contents briefly for non-trivial builds; build simple workbooks directly.
- Uploaded source files expire after 30 days.
- `excel_delete` is approval-gated and only deletes uploaded source files.
