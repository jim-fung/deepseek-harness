SELECT COUNT(*) AS count, COALESCE(MAX(rowid), 0) AS max_row_id
FROM sessions;
