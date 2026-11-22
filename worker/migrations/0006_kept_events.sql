-- Cloud events are now kept for a year and read back by the person's cloud
-- threads, which count them. No computer takes them any more, so
-- users.relay_computer and users.relay_pulled_at are no longer used.

-- A cloud thread reads a person's events in the order they arrived, and
-- later only the ones after the last it has.
CREATE INDEX relayed_events_by_id ON relayed_events (user_id, id);

-- For counting what a person sent in the last day, and dropping what is
-- older than a year.
CREATE INDEX relayed_events_by_arrival ON relayed_events (user_id, received_at);
