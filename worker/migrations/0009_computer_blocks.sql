-- Each computer's latest work blocks, as compact numbers grouped by project,
-- read out of its report once when it arrives, for the review app's graphs and
-- the public API. JSON: {project key: [name, first start, last end, engaged
-- seconds, [[start, end, engaged, prompts, tokens in, tokens out, added,
-- removed, kept], ...]]}, the newest blocks only. '' until it is filled in.
ALTER TABLE computers ADD COLUMN blocks TEXT NOT NULL DEFAULT '';
