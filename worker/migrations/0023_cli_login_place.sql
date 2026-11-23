-- Where a `teardrop login` was asked from, by the address's city and country
-- as Cloudflare places it, shown on the allow page with how long ago it was.
ALTER TABLE cli_logins ADD COLUMN place TEXT;
