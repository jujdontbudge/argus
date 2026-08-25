INSERT INTO sessions
  (id, source, model, started_at, message_count, cwd)
VALUES
  ('hermes-scenario-session', 'cli', 'scenario-model', 1777300000, 2, '__CWD__');

INSERT INTO messages
  (session_id, role, content, timestamp, active)
VALUES
  ('hermes-scenario-session', 'user', 'Run the Hermes autonomous batch.', 1777300001, 1),
  ('hermes-scenario-session', 'assistant', 'Hermes completed the autonomous batch.', 1777300002, 1);
