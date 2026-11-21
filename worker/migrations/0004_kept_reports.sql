-- Where the report behind a log row is kept in full: its name in the REPORTS
-- bucket. NULL for a removal, for a file that was not a teardrop report, for
-- rows from before reports were kept, and once the person deletes their account.
ALTER TABLE account_log ADD COLUMN report_key TEXT;
